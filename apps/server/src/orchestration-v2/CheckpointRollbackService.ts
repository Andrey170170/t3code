import {
  CheckpointId,
  CheckpointScopeId,
  type OrchestrationV2AcknowledgedWork,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import {
  CheckpointBackendError,
  CheckpointSnapshotUnavailableError,
} from "../checkpointing/Errors.ts";

import {
  CheckpointRestoreRule,
  SHARED_WORKSPACE_RESTORE_MESSAGE,
} from "./CheckpointRestoreSafety.ts";
import {
  CheckpointServiceV2,
  checkpointRunOrdinal,
  MOVE_BOUNDARY_RESTORE_MESSAGE,
  scopeAssignmentOf,
  workspaceAssignmentOf,
} from "./CheckpointService.ts";
import type { EffectOutboxV2Shape } from "./EffectOutbox.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2 } from "./IdAllocator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type { ProviderAdapterV2RollbackTarget } from "./ProviderAdapter.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RestoreLease } from "./RestoreLease.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

export const ROLLBACK_FAILED_MESSAGE =
  "The provider could not roll back this conversation. Try again; if it keeps failing, check the provider and server logs.";

const ROLLBACK_SUPERSEDED_MESSAGE = "A newer revert of this thread replaced this one.";

export const CHECKPOINT_EXPIRED_MESSAGE =
  "This checkpoint's saved files are no longer available, so it can no longer be restored.";

export class CheckpointRollbackExecutionError extends Schema.TaggedError<CheckpointRollbackExecutionError>()(
  "CheckpointRollbackExecutionError",
  {
    reason: Schema.Literals([
      "rollback-target-invalid",
      "active-provider-changed",
      "provider-turn-unavailable",
      "unexpected-failure",
      "shared-workspace",
    ]),
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    checkpointId: CheckpointId,
    cause: Schema.optional(Schema.Defect()),
    /** Shown to the user instead of the generic failure, when set. */
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "rollback-target-invalid":
        return `Rollback target ${this.checkpointId} for provider thread ${this.providerThreadId} on thread ${this.threadId} is incomplete or invalid.`;
      case "active-provider-changed":
        return `Active provider changed before rollback target ${this.checkpointId} could execute on thread ${this.threadId}.`;
      case "provider-turn-unavailable":
        return `Provider turn for rollback target ${this.checkpointId} is unavailable on provider thread ${this.providerThreadId}.`;
      case "shared-workspace":
        return this.detail ?? SHARED_WORKSPACE_RESTORE_MESSAGE;
      case "unexpected-failure":
        return ROLLBACK_FAILED_MESSAGE;
    }
  }
}

const isCheckpointRollbackExecutionError = Schema.is(CheckpointRollbackExecutionError);

/**
 * Whether the thread's latest rollback may still run: accepted, neither
 * completed nor failed for good, and its effect not settled in the outbox
 * (which also covers a failure whose receipt was lost). Without the outbox
 * the thread's record alone decides. Unreadable counts as in flight.
 */
export const rollbackInFlight = (
  thread: Pick<
    OrchestrationV2AppThread,
    "rollbackRequestId" | "rollbackCompletedRequestId" | "rollbackFailure"
  >,
  outbox: Option.Option<EffectOutboxV2Shape>,
): Effect.Effect<boolean> => {
  const requestId = thread.rollbackRequestId;
  if (
    requestId === undefined ||
    thread.rollbackCompletedRequestId !== null ||
    thread.rollbackFailure?.requestId === requestId
  ) {
    return Effect.succeed(false);
  }
  if (Option.isNone(outbox)) return Effect.succeed(true);
  return outbox.value.listByCommandId(requestId).pipe(
    Effect.map((effects) =>
      effects.some(
        (effect) =>
          effect.request.type === "provider-thread.rollback" &&
          (effect.status === "pending" || effect.status === "running"),
      ),
    ),
    Effect.orElseSucceed(() => true),
  );
};
const isCheckpointSnapshotUnavailableError = Schema.is(CheckpointSnapshotUnavailableError);

/** What a client waiting on a failed rollback is told. */
export function rollbackFailureMessage(cause: Cause.Cause<unknown>): string {
  for (const reason of cause.reasons) {
    if (
      Cause.isFailReason(reason) &&
      isCheckpointRollbackExecutionError(reason.error) &&
      reason.error.detail !== undefined
    ) {
      return reason.error.detail;
    }
  }
  return ROLLBACK_FAILED_MESSAGE;
}

const isCheckpointBackendError = Schema.is(CheckpointBackendError);

/**
 * The checkpoint store's own reason, when the failure came from a store
 * that reports one (Trellis unreachable or too old), for the client.
 */
function storeFailureDetail(cause: unknown): { readonly detail?: string } {
  let current: unknown = cause;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth++) {
    if (isCheckpointBackendError(current)) {
      return { detail: `Restoring the files failed: ${current.detail}` };
    }
    current = Predicate.hasProperty(current, "cause") ? current.cause : undefined;
  }
  return {};
}

const isWithin = (parent: string, child: string) => {
  const base = parent.replace(/\/+$/, "");
  return child === base || child.startsWith(`${base}/`);
};

export interface CheckpointRollbackServiceV2Shape {
  readonly execute: (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly checkpointId: CheckpointId;
    readonly scopeId: CheckpointScopeId;
    readonly restoreFiles?: boolean;
    readonly acknowledgeWork?: ReadonlyArray<OrchestrationV2AcknowledgedWork>;
    /** The rollback command, the same on every retry of its effect. */
    readonly requestId?: string;
  }) => Effect.Effect<void, CheckpointRollbackExecutionError>;
}

export class CheckpointRollbackServiceV2 extends Context.Service<
  CheckpointRollbackServiceV2,
  CheckpointRollbackServiceV2Shape
>()("t3/orchestration-v2/CheckpointRollbackService/CheckpointRollbackServiceV2") {}

export const layer: Layer.Layer<
  CheckpointRollbackServiceV2,
  never,
  | CheckpointServiceV2
  | EventSinkV2
  | IdAllocatorV2
  | ProjectionStoreV2
  | ProviderSessionManagerV2
  | RuntimePolicyV2
  | FileSystem.FileSystem
> = Layer.effect(
  CheckpointRollbackServiceV2,
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointServiceV2;
    const eventSink = yield* EventSinkV2;
    const ids = yield* IdAllocatorV2;
    const projections = yield* ProjectionStoreV2;
    const sessions = yield* ProviderSessionManagerV2;
    const runtimePolicy = yield* RuntimePolicyV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const restoreLease = yield* RestoreLease;
    const restoreRule = yield* CheckpointRestoreRule;

    // A restore that replaces the environment ends the providers running in
    // it, so their sessions are released first and reopen on the next turn.
    const releaseSessionsWithin = (directory: string) =>
      Effect.gen(function* () {
        const shell = yield* projections.getShellSnapshot();
        const released = new Set<string>();
        for (const thread of shell.threads) {
          const records = yield* projections.getThreadRecords(thread.id, ["providerSessions"]);
          for (const session of records.providerSessions) {
            if (session.status === "stopped" || released.has(session.id)) continue;
            if (!isWithin(directory, session.cwd)) continue;
            released.add(session.id);
            yield* sessions.release({
              providerSessionId: session.id,
              reason: "manual_shutdown",
              detail: "The workspace restarted to restore a checkpoint.",
            });
          }
        }
      });

    const execute = Effect.fn("orchestrationV2.checkpointRollback.execute")(function* (input: {
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly checkpointId: CheckpointId;
      readonly scopeId: CheckpointScopeId;
      readonly restoreFiles?: boolean;
      readonly acknowledgeWork?: ReadonlyArray<OrchestrationV2AcknowledgedWork>;
      readonly requestId?: string;
    }) {
      const projection = yield* projections.getThreadRecords(input.threadId, [
        "providerThreads",
        "providerSessions",
        "checkpoints",
        "checkpointScopes",
        "runs",
        "attempts",
        "nodes",
        "providerTurns",
      ]);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === input.providerThreadId,
      );
      const checkpoint = projection.checkpoints.find(
        (candidate) => candidate.id === input.checkpointId,
      );
      const scope = projection.checkpointScopes.find((candidate) => candidate.id === input.scopeId);
      if (
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        checkpoint === undefined ||
        scope === undefined ||
        checkpoint.scopeId !== scope.id ||
        checkpoint.status !== "ready"
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "rollback-target-invalid",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
          ...(checkpoint?.status === "missing" ? { detail: CHECKPOINT_EXPIRED_MESSAGE } : {}),
        });
      }
      // A newer rollback replaced this one while it waited to retry; running
      // it now would restore its older checkpoint over the newer one.
      if (
        input.requestId !== undefined &&
        projection.thread.rollbackRequestId !== undefined &&
        projection.thread.rollbackRequestId !== input.requestId
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "rollback-target-invalid",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
          detail: ROLLBACK_SUPERSEDED_MESSAGE,
        });
      }
      if (
        providerThread.id !== projection.thread.activeProviderThreadId ||
        providerThread.providerInstanceId !== projection.thread.modelSelection.instanceId
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "active-provider-changed",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }

      const restoreFiles = input.restoreFiles !== false;
      const targetAssignment = scopeAssignmentOf(scope, projection.checkpointScopes);
      // Held through the provider rewind and the file restore; released when
      // `execute` ends.
      yield* restoreLease.acquire(scope);
      // The decider resolved file restores into the thread's current project;
      // read again under the lease, a move since then puts this one across
      // the boundary.
      const current = (yield* projections.getThreadRecords(input.threadId, [])).thread;
      if (restoreFiles && targetAssignment !== workspaceAssignmentOf(current)) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "rollback-target-invalid",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
          detail: MOVE_BOUNDARY_RESTORE_MESSAGE,
        });
      }
      if (restoreFiles) {
        const refusal = yield* restoreRule.check(
          {
            thread: projection.thread,
            scope,
            checkpoint,
            acknowledgeWork: input.acknowledgeWork ?? [],
          },
          { fileSystem, projections },
        );
        if (refusal !== null) {
          return yield* new CheckpointRollbackExecutionError({
            reason: "shared-workspace",
            threadId: input.threadId,
            providerThreadId: input.providerThreadId,
            checkpointId: input.checkpointId,
            detail: refusal,
          });
        }
      }
      // Before anything is rewound: a checkpoint whose files are gone fails
      // here, and is marked missing so it is not offered again. Any other
      // failure (the store unreachable) leaves it as it is for a retry.
      const reservation = restoreFiles
        ? yield* checkpoints.reserve({ scope, checkpoint }).pipe(
            Effect.catchIf(
              (error) => isCheckpointSnapshotUnavailableError(error.cause),
              (cause) =>
                Effect.gen(function* () {
                  const now = yield* DateTime.now;
                  yield* eventSink.write({
                    events: [
                      {
                        id: yield* ids.allocate.event({ threadId: input.threadId }),
                        type: "checkpoint.captured",
                        threadId: input.threadId,
                        ...(checkpoint.runId === null ? {} : { runId: checkpoint.runId }),
                        nodeId: checkpoint.nodeId,
                        providerInstanceId: providerThread.providerInstanceId,
                        occurredAt: now,
                        payload: { ...checkpoint, status: "missing" },
                      },
                    ],
                  });
                  return yield* new CheckpointRollbackExecutionError({
                    reason: "rollback-target-invalid",
                    threadId: input.threadId,
                    providerThreadId: input.providerThreadId,
                    checkpointId: input.checkpointId,
                    cause,
                    detail: CHECKPOINT_EXPIRED_MESSAGE,
                  });
                }),
            ),
          )
        : null;

      const modelSelection = projection.thread.modelSelection;
      const resolvedRuntimePolicy = yield* runtimePolicy.resolve({
        thread: projection.thread,
        modelSelection,
      });
      const storedSession = projection.providerSessions.find(
        (candidate) => candidate.id === providerThread.providerSessionId,
      );
      // A thread that moved since its session opened rewinds in its new
      // workspace's session, as its next turn would run, never in a process
      // still serving the old workspace for other threads.
      const sessionKey = resolvedRuntimePolicy.launch?.sessionKey;
      const rebound = storedSession !== undefined && storedSession.sessionKey !== sessionKey;
      const providerSessionId = !rebound
        ? providerThread.providerSessionId
        : storedSession.capabilities.sessions.supportsMultipleProviderThreadsPerSession
          ? ids.derive.providerSession({
              providerInstanceId: providerThread.providerInstanceId,
              ...(sessionKey === undefined ? {} : { sessionKey }),
            })
          : providerThread.providerSessionId;
      const existingSession = rebound ? undefined : storedSession;
      const session = yield* sessions.open({
        threadId: input.threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
        ...(existingSession === undefined ? {} : { resumeFromSession: existingSession }),
        ...(providerThread.nativeThreadRef?.nativeId == null
          ? {}
          : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
        ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
          ? {}
          : {
              initialProviderItemIdentityVersion: providerThread.nativeMetadata.itemIdentityVersion,
            }),
      });

      const targetOrdinal = checkpointRunOrdinal(checkpoint, scope);
      // Stopped and failed runs after the target leave the provider
      // conversation too, so they must not stay visible.
      const runsToRollback = projection.runs.filter(
        (run) =>
          run.ordinal > targetOrdinal &&
          (run.status === "completed" ||
            run.status === "interrupted" ||
            run.status === "failed" ||
            run.status === "cancelled"),
      );
      // Rolled-back turns stay in the audit history, but no longer exist in
      // the provider conversation and must not be counted by a later rewind.
      const rolledBackRunIds = new Set(
        projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
      );
      const rolledBackAttemptIds = new Set(
        projection.attempts
          .filter((attempt) => rolledBackRunIds.has(attempt.runId))
          .map((attempt) => attempt.id),
      );
      const providerThreadTurns = projection.providerTurns.filter(
        (turn) =>
          turn.providerThreadId === providerThread.id &&
          (turn.runAttemptId === null || !rolledBackAttemptIds.has(turn.runAttemptId)),
      );
      const rollbackTarget: ProviderAdapterV2RollbackTarget =
        targetOrdinal === 0
          ? {
              type: "thread_start",
              checkpointId: checkpoint.id,
              appRunOrdinal: 0,
            }
          : yield* Effect.gen(function* () {
              const targetRun = projection.runs.find((run) => run.ordinal === targetOrdinal);
              const targetAttempt = projection.attempts.find(
                (attempt) => attempt.id === targetRun?.activeAttemptId,
              );
              const targetTurn = projection.providerTurns.find(
                (turn) =>
                  turn.id === targetAttempt?.providerTurnId ||
                  turn.runAttemptId === targetAttempt?.id,
              );
              if (targetTurn === undefined || targetTurn.providerThreadId !== providerThread.id) {
                return yield* new CheckpointRollbackExecutionError({
                  reason: "provider-turn-unavailable",
                  threadId: input.threadId,
                  providerThreadId: input.providerThreadId,
                  checkpointId: input.checkpointId,
                });
              }
              return {
                type: "provider_turn" as const,
                checkpointId: checkpoint.id,
                appRunOrdinal: targetOrdinal,
                providerTurn: targetTurn,
              };
            });

      const now = yield* DateTime.now;
      const makeEvent = <Event extends OrchestrationV2DomainEvent>(event: Omit<Event, "id">) =>
        Effect.map(
          ids.allocate.event({ threadId: event.threadId }),
          (id) =>
            ({
              ...event,
              id,
            }) as Event,
        );
      const snapshot =
        runsToRollback.length === 0
          ? { providerThread }
          : yield* session.rollbackThread({
              providerThread,
              target: rollbackTarget,
              providerThreadTurns,
            });
      // The rewind is recorded as soon as the provider made it, before the
      // files are restored: a retry after a failed restore then finds no run
      // left to roll back and never rewinds the conversation a second time.
      const conversationEvents: Array<OrchestrationV2DomainEvent> = [
        yield* makeEvent({
          type: "provider-thread.updated",
          threadId: input.threadId,
          driver: providerThread.driver,
          providerInstanceId: providerThread.providerInstanceId,
          occurredAt: now,
          payload: {
            ...snapshot.providerThread,
            providerSessionId,
            lastRunOrdinal: targetOrdinal === 0 ? null : targetOrdinal,
            updatedAt: now,
          },
        }),
      ];
      for (const run of runsToRollback) {
        const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
        conversationEvents.push(
          yield* makeEvent({
            type: "run.updated",
            threadId: input.threadId,
            runId: run.id,
            ...(rootNode === undefined ? {} : { nodeId: rootNode.id }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...run, status: "rolled_back", completedAt: now },
          }),
        );
        if (rootNode !== undefined) {
          conversationEvents.push(
            yield* makeEvent({
              type: "node.updated",
              threadId: input.threadId,
              runId: run.id,
              nodeId: rootNode.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              payload: { ...rootNode, status: "rolled_back", completedAt: now },
            }),
          );
        }
      }
      yield* eventSink.write({ events: conversationEvents });

      let notice: string | null = null;
      if (reservation !== null) {
        if (reservation.endsSessionsIn !== null) {
          yield* releaseSessionsWithin(reservation.endsSessionsIn);
        }
        notice = (yield* checkpoints.restore({
          scope,
          checkpoint,
          ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        })).notice;
      }
      const staleCheckpoints = projection.checkpoints.filter((candidate) => {
        if (candidate.status !== "ready") return false;
        if (candidate.scopeId === scope.id) {
          return candidate.appRunOrdinal !== null && candidate.appRunOrdinal > targetOrdinal;
        }
        // A rewind to before the thread moved also drops what the projects it
        // moved to captured after the target, their baselines included.
        const candidateScope = projection.checkpointScopes.find(
          (other) => other.id === candidate.scopeId,
        );
        // A project's baseline stays: the files it holds are still there, and
        // later turns in that project diff from it.
        return (
          candidateScope?.kind === "root_run" &&
          candidate.appRunOrdinal !== null &&
          scopeAssignmentOf(candidateScope, projection.checkpointScopes) > targetAssignment &&
          checkpointRunOrdinal(candidate, candidateScope) > targetOrdinal
        );
      });
      for (const staleScope of projection.checkpointScopes) {
        const stale = staleCheckpoints.filter((candidate) => candidate.scopeId === staleScope.id);
        if (stale.length === 0) continue;
        const deleted = checkpoints.deleteStaleRefs({ scope: staleScope, checkpoints: stale });
        // Refs of a project the thread left are only tidied: its folder may be gone.
        yield* scopeAssignmentOf(staleScope, projection.checkpointScopes) ===
        workspaceAssignmentOf(projection.thread)
          ? deleted
          : deleted.pipe(
              Effect.catch((error) =>
                Effect.logWarning("could not delete the refs of an earlier project's checkpoints", {
                  scopeId: staleScope.id,
                  detail: error.message,
                }),
              ),
            );
      }

      const events: Array<OrchestrationV2DomainEvent> = [];
      // The files are back to before every later run, including runs an
      // earlier conversation-only rewind removed; their changes are gone.
      if (reservation !== null) {
        const rewoundIds = new Set(runsToRollback.map((run) => run.id));
        for (const run of projection.runs) {
          if (run.ordinal <= targetOrdinal || run.rollbackRestoredFiles === true) continue;
          if (!rewoundIds.has(run.id) && run.status !== "rolled_back") continue;
          events.push(
            yield* makeEvent({
              type: "run.updated",
              threadId: input.threadId,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              payload: {
                ...run,
                status: "rolled_back",
                completedAt: rewoundIds.has(run.id) ? now : run.completedAt,
                rollbackRestoredFiles: true,
              },
            }),
          );
        }
      }
      for (const staleCheckpoint of staleCheckpoints) {
        events.push(
          yield* makeEvent({
            type: "checkpoint.captured",
            threadId: input.threadId,
            ...(staleCheckpoint.runId === null ? {} : { runId: staleCheckpoint.runId }),
            nodeId: staleCheckpoint.nodeId,
            providerInstanceId: providerThread.providerInstanceId,
            occurredAt: now,
            payload: { ...staleCheckpoint, status: "stale" },
          }),
        );
      }
      if (notice !== null) {
        // Shown after the target run (or at the top for a full rewind).
        const targetRun = projection.runs.find((run) => run.ordinal === targetOrdinal);
        const item: OrchestrationV2TurnItem = {
          // The same item on every retry of one rollback.
          id: TurnItemId.make(
            `turn-item:checkpoint-restore:${input.requestId ?? conversationEvents[0]!.id}`,
          ),
          type: "system_notice",
          message: notice,
          threadId: input.threadId,
          runId: targetRun?.id ?? null,
          nodeId: targetRun?.rootNodeId ?? null,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: yield* projections.getNextTurnItemOrdinal(input.threadId),
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        };
        events.push(
          yield* makeEvent({
            type: "turn-item.updated",
            threadId: input.threadId,
            ...(targetRun === undefined ? {} : { runId: targetRun.id }),
            ...(targetRun?.rootNodeId == null ? {} : { nodeId: targetRun.rootNodeId }),
            providerInstanceId: providerThread.providerInstanceId,
            occurredAt: now,
            payload: item,
          }),
        );
      }
      if (events.length > 0) yield* eventSink.write({ events });
    });

    return CheckpointRollbackServiceV2.of({
      execute: (input) =>
        execute(input).pipe(
          Effect.scoped,
          Effect.mapError((cause) =>
            isCheckpointRollbackExecutionError(cause)
              ? cause
              : new CheckpointRollbackExecutionError({
                  reason: "unexpected-failure",
                  threadId: input.threadId,
                  providerThreadId: input.providerThreadId,
                  checkpointId: input.checkpointId,
                  cause,
                  ...storeFailureDetail(cause),
                }),
          ),
        ),
    });
  }),
);
