import { CommandId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";

const GENERIC_CODEX_TITLES = new Set([
  "new thread",
  "new chat",
  "new conversation",
  "untitled",
  "untitled conversation",
  "codex conversation",
]);

/** Preserve native titles unless Codex only supplied a generic placeholder. */
export function needsCodexImportTitle(title: string | null | undefined): boolean {
  const normalized = title?.trim().toLowerCase();
  return (
    normalized === undefined || normalized.length === 0 || GENERIC_CODEX_TITLES.has(normalized)
  );
}

export interface CodexImportTitleRequest {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly expectedTitle: string;
  /** Bounded preview from the native conversation, without synthetic messages. */
  readonly context: string;
}

export class CodexImportTitle extends Context.Service<
  CodexImportTitle,
  {
    /** Queue a best-effort title generation without waiting for the model. */
    readonly schedule: (request: CodexImportTitleRequest) => Effect.Effect<void>;
  }
>()("t3/project/CodexImportTitle") {}

/** @public Service construction is part of the canonical Effect module API. */
export const makeCodexImportTitle = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const settings = yield* ServerSettingsService;
  const textGeneration = yield* TextGeneration;
  const serviceScope = yield* Effect.scope;
  const generationSlots = yield* Semaphore.make(2);
  const pending = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());

  const releasePending = (threadId: ThreadId) =>
    Ref.update(pending, (current) => {
      const next = new Set(current);
      next.delete(threadId);
      return next;
    });

  const generate = Effect.fn("CodexImportTitle.generate")(function* (
    request: CodexImportTitleRequest,
  ) {
    const current = yield* snapshots.getThreadShellById(request.threadId);
    if (Option.isNone(current) || current.value.title !== request.expectedTitle) return;
    if (current.value.titleState?.source === "manual") return;
    const expectedVersion = current.value.titleState?.version ?? null;

    const message = request.context.trim();
    if (message.length === 0) return;

    const modelSelection = (yield* settings.getSettings).textGenerationModelSelection;
    const generated = yield* textGeneration.generateThreadTitle({
      cwd: request.cwd,
      message,
      modelSelection,
    });
    if (generated.title === request.expectedTitle) return;

    const latest = yield* snapshots.getThreadShellById(request.threadId);
    if (Option.isNone(latest) || latest.value.title !== request.expectedTitle) return;

    const uuid = yield* crypto.randomUUIDv4;
    yield* engine.dispatch({
      type: "thread.title.generate.complete",
      commandId: CommandId.make(`server:codex-import-title:${uuid}`),
      threadId: request.threadId,
      title: generated.title,
      expectedTitle: request.expectedTitle,
      expectedVersion,
      needsRefinement: generated.needsRefinement === true,
    });
  });

  const schedule: CodexImportTitle["Service"]["schedule"] = Effect.fn("CodexImportTitle.schedule")(
    function* (request) {
      const admitted = yield* Ref.modify(pending, (current) => {
        if (current.has(request.threadId)) return [false, current] as const;
        const next = new Set(current);
        next.add(request.threadId);
        return [true, next] as const;
      });
      if (!admitted) return;

      yield* generate(request).pipe(
        generationSlots.withPermits(1),
        Effect.ensuring(releasePending(request.threadId)),
        Effect.ignoreCause({ log: true }),
        Effect.forkIn(serviceScope, { startImmediately: true }),
        Effect.asVoid,
      );
    },
  );

  return CodexImportTitle.of({ schedule });
});

export const CodexImportTitleLive = Layer.effect(CodexImportTitle, makeCodexImportTitle);
