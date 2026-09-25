/**
 * TrellisNaming - names Trellis ideas and projects from their threads.
 *
 * New Trellis items are called "Idea" / "Project" until someone names them.
 * After the first user message of a thread in a Trellis project path, the
 * text-generation model configured for thread titles proposes a short name
 * and a one-line description; once the thread has completed its third turn,
 * they are regenerated from the conversation so far. The first is sent to
 * Trellis as `generated`, the refinement as `refined`, which is final for
 * the item: no later thread renames it. Neither overrides a name given by
 * the user, an agent or the git repository. Failures are logged and never
 * affect the turn.
 *
 * @module trellis/TrellisNaming
 */
import type { OrchestrationEvent, ProjectId, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { formatThreadTitleContext } from "../textGeneration/ThreadTitleContext.ts";
import { isTrellisManagedPath, Trellis } from "./Trellis.ts";
import { TrellisCatalog } from "./TrellisCatalog.ts";

/** The completed turn after which the name is regenerated from the thread. */
export const TRELLIS_NAME_REFINE_TURN = 3;

export type NamingStage = "initial" | "refine";

/**
 * Whether a Trellis name in `nameSource` may be generated at `stage`. The
 * first message names only a placeholder, so a second thread in the same
 * project does not rename it; the refinement may also improve an earlier
 * generated name, once per item. Names from the user, an agent or the
 * repository, and refined names, are kept.
 */
export function mayGenerateName(stage: NamingStage, nameSource: string | undefined): boolean {
  return stage === "initial"
    ? nameSource === "default"
    : nameSource === "default" || nameSource === "generated";
}

export class TrellisNaming extends Context.Service<
  TrellisNaming,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Handles one domain event; `start` feeds every engine event through it. */
    readonly handleEvent: (event: OrchestrationEvent) => Effect.Effect<void>;
    /** Resolves when queued naming work is done. For tests. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/trellis/TrellisNaming") {}

interface NamingRequest {
  readonly threadId: ThreadId;
  readonly stage: NamingStage;
}

const make = Effect.gen(function* () {
  const trellis = yield* Trellis;
  const catalog = yield* TrellisCatalog;
  const textGeneration = yield* TextGeneration;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettingsService;
  // Threads with a refinement queued or running, so repeated ready events do
  // not duplicate the work. Whether an item is refined at all is Trellis's
  // `name_source`.
  const refining = new Set<ThreadId>();

  const cwdOf = Effect.fn("TrellisNaming.cwdOf")(function* (thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  }) {
    if (thread.worktreePath !== null) return thread.worktreePath;
    const project = yield* snapshots.getProjectShellById(thread.projectId);
    return Option.isSome(project) ? project.value.workspaceRoot : null;
  });

  const nameFromThread = Effect.fn("TrellisNaming.nameFromThread")(function* (
    request: NamingRequest,
  ) {
    const env = yield* trellis.current;
    if (env === null) return;
    const detail = yield* snapshots.getThreadDetailById(request.threadId, { activityKinds: [] });
    if (Option.isNone(detail)) return;
    const thread = detail.value;
    const cwd = yield* cwdOf(thread);
    if (cwd === null || !isTrellisManagedPath(env.root, cwd)) return;

    const userMessages = thread.messages.filter((message) => message.role === "user");
    if (request.stage === "initial" && userMessages.length !== 1) return;

    const resolved = yield* trellis.resolve(cwd);
    const item = resolved.project;
    if (item === null || !mayGenerateName(request.stage, item.name_source)) return;

    const message =
      request.stage === "initial"
        ? (userMessages[0]?.text ?? "")
        : formatThreadTitleContext(thread.messages).message;
    if (message.trim().length === 0) return;

    const { textGenerationModelSelection: modelSelection } = resolveProjectSettings(
      yield* serverSettings.getSettings,
      thread.projectId,
    ).settings;
    const generated = yield* textGeneration.generateProjectName({
      cwd,
      message,
      ...(request.stage === "refine" ? { previousName: item.name } : {}),
      modelSelection,
    });
    if (generated.name.length === 0) return;

    const result = yield* trellis.describe({
      target: item.path,
      name: generated.name,
      ...(generated.description.length > 0 ? { description: generated.description } : {}),
      source: request.stage === "refine" ? "refined" : "generated",
    });
    yield* Effect.logInfo("Trellis project named from its thread", {
      threadId: request.threadId,
      stage: request.stage,
      name: generated.name,
      ignored: result.ignored,
    });
    // Mirror the new name into the T3 project title now, not at the next poll.
    yield* catalog.syncNow;
  });

  const worker = yield* makeDrainableWorker((request: NamingRequest) =>
    nameFromThread(request).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (request.stage === "refine") refining.delete(request.threadId);
        }),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("failed to name Trellis project from thread", {
              threadId: request.threadId,
              stage: request.stage,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  // Refine when a thread has completed its third turn or more; the item's
  // name source makes it happen once per item.
  const maybeRefine = Effect.fn("TrellisNaming.maybeRefine")(function* (threadId: ThreadId) {
    if (refining.has(threadId) || (yield* trellis.current) === null) return;
    const thread = yield* snapshots.getThreadShellById(threadId);
    if (Option.isNone(thread) || thread.value.latestTurn?.state !== "completed") return;
    const detail = yield* snapshots.getThreadDetailById(threadId, { activityKinds: [] });
    if (Option.isNone(detail)) return;
    const turns = detail.value.messages.filter((message) => message.role === "user").length;
    if (turns < TRELLIS_NAME_REFINE_TURN) return;
    refining.add(threadId);
    yield* worker.enqueue({ threadId, stage: "refine" });
  });

  const onEvent = (event: OrchestrationEvent): Effect.Effect<void> => {
    switch (event.type) {
      case "thread.message-sent":
        return event.payload.role === "user" &&
          !event.payload.streaming &&
          event.metadata.historyImport !== true
          ? worker.enqueue({ threadId: event.payload.threadId, stage: "initial" })
          : Effect.void;
      case "thread.session-set":
        return event.payload.session.status === "ready"
          ? maybeRefine(event.payload.threadId).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Effect.logWarning("failed to check Trellis name refinement", {
                      threadId: event.payload.threadId,
                      cause: Cause.pretty(cause),
                    }),
              ),
            )
          : Effect.void;
      default:
        return Effect.void;
    }
  };

  const start: TrellisNaming["Service"]["start"] = Effect.fn("TrellisNaming.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, onEvent));
  });

  return TrellisNaming.of({ start, handleEvent: onEvent, drain: worker.drain });
});

export const layer = Layer.effect(TrellisNaming, make);

/** For runtimes without Trellis. */
export const layerDisabled = Layer.succeed(
  TrellisNaming,
  TrellisNaming.of({
    start: () => Effect.void,
    handleEvent: () => Effect.void,
    drain: Effect.void,
  }),
);
