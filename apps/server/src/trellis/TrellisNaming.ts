/**
 * TrellisNaming - names Trellis ideas and projects from their threads.
 *
 * New Trellis items are called "Idea" / "Project" until someone names them.
 * When a thread in a Trellis project path completes its first turn, the
 * text-generation model configured for thread titles proposes a short name
 * and a one-line description from its first message; once the thread has
 * completed its third turn, they are regenerated from the conversation so
 * far. The first is sent to
 * Trellis as `generated`, the refinement as `refined`, which is final for
 * the item: no later thread renames it. Neither overrides a name given by
 * the user, an agent or the git repository. Failures are logged and never
 * affect the turn.
 *
 * Driven by V2's live domain events: a completed `run.updated`.
 *
 * @module trellis/TrellisNaming
 */
import type { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { formatThreadTitleContext } from "../textGeneration/ThreadTitleContext.ts";
import { isTrellisManagedPath, Trellis } from "./Trellis.ts";
import { TrellisCatalog } from "./TrellisCatalog.ts";

/** The completed turn after which the name is regenerated from the thread. */
const TRELLIS_NAME_REFINE_TURN = 3;

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
    /** Handles one domain event; `start` feeds every live event through it. */
    readonly handleEvent: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
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
  const orchestrator = yield* OrchestratorV2;
  const projects = yield* ProjectService;
  const serverSettings = yield* ServerSettingsService;
  // Threads with a refinement queued or running, so repeated completions do
  // not duplicate the work. Whether an item is refined at all is Trellis's
  // `name_source`.
  const refining = new Set<ThreadId>();

  const nameFromThread = Effect.fn("TrellisNaming.nameFromThread")(function* (
    request: NamingRequest,
  ) {
    const env = yield* trellis.current;
    if (env === null) return;
    // Cheap checks first: the thread's folder and the item's name source end
    // most requests before any conversation is read.
    const thread = yield* orchestrator.getThreadShell(request.threadId);
    if (thread === null) return;
    const path =
      thread.worktreePath ??
      Option.getOrNull(yield* projects.getById(thread.projectId))?.workspaceRoot ??
      null;
    if (path === null) return;
    const cwd = yield* trellis.canonicalPath(path);
    if (!isTrellisManagedPath(env.root, cwd)) return;
    const item = (yield* trellis.resolve(cwd)).project;
    if (item === null || !mayGenerateName(request.stage, item.name_source)) return;

    const records = yield* orchestrator.getThreadRecords(request.threadId, ["messages"], {
      messageRoles: request.stage === "initial" ? ["user"] : ["user", "assistant"],
    });
    const messages = records.messages.filter((message) => !message.streaming);
    const userMessages = messages.filter((message) => message.role === "user");
    if (request.stage === "refine" && userMessages.length < TRELLIS_NAME_REFINE_TURN) return;

    const message =
      request.stage === "initial"
        ? (userMessages[0]?.text ?? "")
        : formatThreadTitleContext(messages).message;
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

  const enqueue = (request: NamingRequest) =>
    Effect.gen(function* () {
      if ((yield* trellis.current) === null) return;
      if (request.stage === "refine") {
        if (refining.has(request.threadId)) return;
        refining.add(request.threadId);
      }
      yield* worker.enqueue(request);
    });

  const handleEvent = (event: OrchestrationV2DomainEvent): Effect.Effect<void> => {
    switch (event.type) {
      // The item's name source makes each stage happen once per item: an
      // initial name only replaces the placeholder, a refined one is final.
      case "run.updated":
        if (event.payload.status !== "completed") return Effect.void;
        return enqueue({
          threadId: event.payload.threadId,
          stage: event.payload.ordinal >= TRELLIS_NAME_REFINE_TURN ? "refine" : "initial",
        });
      default:
        return Effect.void;
    }
  };

  const start: TrellisNaming["Service"]["start"] = Effect.fn("TrellisNaming.start")(function* () {
    yield* forkParked(Stream.runForEach(orchestrator.streamDomainEvents, handleEvent));
  });

  return TrellisNaming.of({ start, handleEvent, drain: worker.drain });
});

export const layer = Layer.effect(TrellisNaming, make);
