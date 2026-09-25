import {
  CommandId,
  CheckpointRef,
  EventId,
  MessageId,
  type ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";

import { parseTurnDiffFilesFromNumstat } from "../../checkpointing/Diffs.ts";
import {
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import * as Trellis from "../../trellis/Trellis.ts";
import * as TrellisBaseline from "../../trellis/TrellisBaseline.ts";
import {
  isTrellisCheckpointRef,
  TRELLIS_CHECKPOINT_REF_PREFIX,
  selectRollbackSnapshot,
  sessionsInScope,
  trellisRestoreScope,
} from "../../trellis/TrellisCheckpoints.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** Retries of a failed post-turn Trellis snapshot before it is reported. */
const TRELLIS_SNAPSHOT_RETRIES = 2;

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.make(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

/** Runs `first`, then `second` whatever `first`'s outcome, then returns `first`'s result. */
const thenAlways = <A, E, R, R2>(
  first: Effect.Effect<A, E, R>,
  second: Effect.Effect<void, never, R2>,
) =>
  Effect.exit(first).pipe(
    Effect.tap(() => second),
    Effect.flatMap((exit) =>
      Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause),
    ),
  );

function checkpointStatusFromRuntime(status: string | undefined): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const receiptBus = yield* RuntimeReceiptBus;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const trellis = yield* Effect.serviceOption(Trellis.Trellis);
  const trellisBaseline = yield* Effect.serviceOption(TrellisBaseline.TrellisBaseline);
  const queuedEntryRefreshes = new Set<string>();
  const entryRefreshWorker = yield* makeDrainableWorker((cwd: string) =>
    Effect.sync(() => queuedEntryRefreshes.delete(cwd)).pipe(
      Effect.andThen(workspaceEntries.refresh(cwd)),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        () =>
          Effect.logWarning("failed to refresh checkpoint workspace entries", {
            cwd,
          }),
      ),
    ),
  );
  const refreshWorkspaceEntries = Effect.fn("refreshWorkspaceEntries")(function* (cwd: string) {
    if (queuedEntryRefreshes.has(cwd)) return;
    queuedEntryRefreshes.add(cwd);
    yield* entryRefreshWorker.enqueue(cwd);
  });

  const startedTurns = new Map<ThreadId, TurnId>();
  const pending = new Set<ThreadId>();

  const appendRevertFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-revert-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.revert.failed",
            summary: "Checkpoint revert failed",
            payload: {
              turnCount: input.turnCount,
              detail: input.detail,
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-capture-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.capture.failed",
            summary: "Checkpoint capture failed",
            payload: {
              detail: input.detail,
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const resolveSessionRuntimeForThread = Effect.fn("resolveSessionRuntimeForThread")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>> {
    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);
    return session?.cwd
      ? Option.some({ threadId: session.threadId, cwd: session.cwd })
      : Option.none();
  });

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId, { activityKinds: [] })
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadProjects = Effect.fn("resolveThreadProjects")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    return project ? [project] : [];
  });

  // Resolves the workspace CWD, preferring the active provider session CWD
  // and falling back to the thread/project config.
  const resolveWorkspaceCwd = Effect.fn("resolveWorkspaceCwd")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined> {
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    });

    const cwd = input.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }));
    return cwd;
  });

  // The workspace CWD for git checkpoint operations; undefined when no CWD can
  // be determined or the workspace is not a git repository.
  const resolveCheckpointCwd = Effect.fn("resolveCheckpointCwd")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined, CheckpointStoreError> {
    return yield* gitCheckpointCwd(yield* resolveWorkspaceCwd(input));
  });

  const gitCheckpointCwd = Effect.fn("gitCheckpointCwd")(function* (
    cwd: string | undefined,
  ): Effect.fn.Return<string | undefined, CheckpointStoreError> {
    if (!cwd) {
      return undefined;
    }
    if (!(yield* checkpointStore.isGitRepository(cwd))) {
      return undefined;
    }
    return cwd;
  });

  // ---- Trellis snapshots
  //
  // A cwd inside a Trellis project path also gets whole-workspace snapshots:
  // one tagged as the thread's baseline before its first turn, and one per
  // completed or aborted turn. They are taken after the git capture so they
  // include its checkpoint refs. Failures are logged and never fail a turn.

  // Includes paths under the expected root while Trellis is down, so their
  // files are never restored through git; Trellis operations then fail.
  const trellisCwdOf = (cwd: string | undefined) =>
    Option.isNone(trellis)
      ? Effect.succeed(undefined)
      : Trellis.isTrellisPath(trellis.value, cwd).pipe(
          Effect.map((managed) => (managed ? cwd : undefined)),
        );

  // Shared with the provider command reactor, which takes the baseline
  // before it sends a turn and does not start the turn without it; here a
  // failure is only logged.
  const ensureTrellisBaseline = (threadId: ThreadId, cwd: string, turnsRan: boolean) =>
    Option.isNone(trellisBaseline)
      ? Effect.void
      : trellisBaseline.value.ensure(threadId, cwd, { turnsRan }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Trellis baseline snapshot failed", {
              threadId,
              cwd,
              detail: error.message,
            }),
          ),
        );

  // A turn's snapshot is retried briefly; a snapshot that still fails is
  // reported on the thread, because restoring files to that turn will not be
  // possible even when its git checkpoint is ready.
  const snapshotTrellisTurn = Effect.fn("snapshotTrellisTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly cwd: string;
    readonly createdAt: string;
  }) {
    if (Option.isNone(trellis)) return undefined;
    return yield* trellis.value
      .createSnapshot({ target: input.cwd, thread: input.threadId, turn: input.turnId })
      .pipe(
        Effect.retry({
          schedule: Schedule.exponential("250 millis"),
          times: TRELLIS_SNAPSHOT_RETRIES,
        }),
        Effect.catch((error) =>
          Effect.logWarning("Trellis turn snapshot failed", {
            threadId: input.threadId,
            turnId: input.turnId,
            cwd: input.cwd,
            detail: error.message,
          }).pipe(
            Effect.andThen(
              appendCaptureFailureActivity({
                threadId: input.threadId,
                turnId: input.turnId,
                detail: `Trellis could not snapshot the workspace after this turn (${error.message}), so its files cannot be restored to this point.`,
                createdAt: input.createdAt,
              }),
            ),
            Effect.catch(() => Effect.void),
            Effect.as(undefined),
          ),
        ),
      );
  });

  // Records a checkpoint for a turn captured only by a Trellis snapshot, so
  // the turn can be reverted. It has no file summary.
  const dispatchTrellisCheckpoint = Effect.fn("dispatchTrellisCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
      }>;
    };
    readonly snapshotId: string;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: string;
  }) {
    const checkpointRef = CheckpointRef.make(`${TRELLIS_CHECKPOINT_REF_PREFIX}${input.snapshotId}`);
    const assistantMessageId =
      input.assistantMessageId ??
      input.thread.messages
        .toReversed()
        .find((entry) => entry.role === "assistant" && entry.turnId === input.turnId)?.id ??
      MessageId.make(`assistant:${input.turnId}`);
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: yield* serverCommandId("trellis-turn-checkpoint"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef,
      status: input.status,
      files: [],
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef,
      status: input.status,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
  });

  // Capture the completed turn's files, then publish its summary and receipts.
  const captureAndDispatchCheckpoint = Effect.fn("captureAndDispatchCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
      }>;
    };
    readonly cwd: string;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: string;
  }) {
    const fromTurnCount = Math.max(0, input.turnCount - 1);
    const fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);

    const fromCheckpointExists = yield* checkpointStore
      .hasCheckpointRef({
        cwd: input.cwd,
        checkpointRef: fromCheckpointRef,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("checkpoint capture previous ref lookup failed", {
            threadId: input.threadId,
            checkpointRef: fromCheckpointRef,
            category: error._tag,
          }).pipe(Effect.as(false)),
        ),
      );
    if (!fromCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
        threadId: input.threadId,
        turnId: input.turnId,
        fromTurnCount,
      });
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: targetCheckpointRef,
    });

    // Refresh the workspace entry index so the @-mention file picker
    // reflects files created or deleted during this turn.
    yield* refreshWorkspaceEntries(input.cwd);

    // Git may have been initialized during this turn, leaving no pre-turn
    // snapshot. Keep the completion checkpoint for future turns, but do not
    // invent a baseline or attempt a diff against a ref that does not exist.
    const files = yield* (
      fromCheckpointExists
        ? checkpointStore.diffCheckpoints({
            cwd: input.cwd,
            fromCheckpointRef,
            toCheckpointRef: targetCheckpointRef,
            fallbackFromToHead: false,
            ignoreWhitespace: false,
            format: "numstat",
          })
        : Effect.succeed("")
    ).pipe(
      Effect.map((diff) =>
        parseTurnDiffFilesFromNumstat(diff).map((file) => ({
          path: file.path,
          kind: "modified" as const,
          additions: file.additions,
          deletions: file.deletions,
        })),
      ),
      Effect.tapError((error) =>
        appendCaptureFailureActivity({
          threadId: input.threadId,
          turnId: input.turnId,
          detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
          createdAt: input.createdAt,
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("failed to derive checkpoint file summary", {
          threadId: input.threadId,
          turnId: input.turnId,
          turnCount: input.turnCount,
          detail: error.message,
        }).pipe(Effect.as([])),
      ),
    );

    const assistantMessageId =
      input.assistantMessageId ??
      input.thread.messages
        .toReversed()
        .find((entry) => entry.role === "assistant" && entry.turnId === input.turnId)?.id ??
      MessageId.make(`assistant:${input.turnId}`);

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: yield* serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      files,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(yield* randomUUID),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: {
          turnCount: input.turnCount,
          status: input.status,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  // Capture the files left by a completed or interrupted turn.
  const captureCheckpointFromTurnCompletion = Effect.fn("captureCheckpointFromTurnCompletion")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      // When a primary turn is active, only that turn may produce completion checkpoints.
      if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
        return;
      }

      // Only skip if a real (non-placeholder) checkpoint already exists for this turn.
      // ProviderRuntimeIngestion may insert placeholder entries with status "missing"
      // before this reactor runs; those must not prevent real git capture.
      if (
        thread.checkpoints.some(
          (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
        )
      ) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const workspaceCwd = yield* resolveWorkspaceCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: true,
      });
      const trellisCwd = yield* trellisCwdOf(workspaceCwd);
      const checkpointCwd = yield* gitCheckpointCwd(workspaceCwd);
      if (!checkpointCwd && !trellisCwd) {
        return;
      }

      // If a placeholder checkpoint exists for this turn, reuse its turn count
      // instead of incrementing past it.
      const existingPlaceholder = thread.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
      );
      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const nextTurnCount = existingPlaceholder
        ? existingPlaceholder.checkpointTurnCount
        : currentTurnCount + 1;

      const status =
        event.type === "turn.aborted" ? "ready" : checkpointStatusFromRuntime(event.payload.state);
      const assistantMessageId = existingPlaceholder?.assistantMessageId ?? undefined;

      const captureTrellis = trellisCwd
        ? Effect.gen(function* () {
            const snapshot = yield* snapshotTrellisTurn({
              threadId: thread.id,
              turnId,
              cwd: trellisCwd,
              createdAt: event.createdAt,
            });
            if (checkpointCwd || snapshot === undefined) return;
            yield* dispatchTrellisCheckpoint({
              threadId: thread.id,
              turnId,
              thread,
              snapshotId: snapshot.id,
              turnCount: nextTurnCount,
              status,
              assistantMessageId,
              createdAt: event.createdAt,
            });
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to record Trellis turn checkpoint", {
                threadId: thread.id,
                turnId,
                detail: error.message,
              }),
            ),
          )
        : Effect.void;

      if (!checkpointCwd) {
        yield* captureTrellis;
        return;
      }
      yield* thenAlways(
        captureAndDispatchCheckpoint({
          threadId: thread.id,
          turnId,
          thread,
          cwd: checkpointCwd,
          turnCount: nextTurnCount,
          status,
          assistantMessageId,
          createdAt: event.createdAt,
        }),
        captureTrellis,
      );
    },
  );

  const ensurePreTurnBaselineFromTurnStart = Effect.fn("ensurePreTurnBaselineFromTurnStart")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      yield* ensurePreTurnBaselines({ thread, createdAt: event.createdAt });
    },
  );

  // Captures the git baseline ref for the next turn and, for a Trellis
  // project path, the thread's baseline snapshot before its first turn.
  const ensurePreTurnBaselines = Effect.fn("ensurePreTurnBaselines")(function* (input: {
    readonly thread: {
      readonly id: ThreadId;
      readonly projectId: ProjectId;
      readonly worktreePath: string | null;
      readonly checkpoints: ReadonlyArray<{ readonly checkpointTurnCount: number }>;
    };
    readonly createdAt: string;
  }) {
    const { thread } = input;
    const projects = yield* resolveThreadProjects(thread.projectId);
    const workspaceCwd = yield* resolveWorkspaceCwd({
      threadId: thread.id,
      thread,
      projects,
      preferSessionRuntime: false,
    });
    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const trellisCwd = yield* trellisCwdOf(workspaceCwd);
    // Fast (a Btrfs snapshot), so it goes before the git capture.
    if (trellisCwd !== undefined) {
      yield* ensureTrellisBaseline(thread.id, trellisCwd, currentTurnCount > 0);
    }

    const captureGitBaseline = Effect.gen(function* () {
      const checkpointCwd = yield* gitCheckpointCwd(workspaceCwd);
      if (!checkpointCwd) {
        return;
      }
      const baselineCheckpointRef = checkpointRefForThreadTurn(thread.id, currentTurnCount);
      const baselineExists = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      if (baselineExists) {
        return;
      }

      yield* checkpointStore.captureCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      yield* receiptBus.publish({
        type: "checkpoint.baseline.captured",
        threadId: thread.id,
        checkpointTurnCount: currentTurnCount,
        checkpointRef: baselineCheckpointRef,
        createdAt: input.createdAt,
      });
    });
    yield* captureGitBaseline;
  });

  const refreshLocalGitStatusFromTurnCompletion = Effect.fn(
    "refreshLocalGitStatusFromTurnCompletion",
  )(function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.threadId);
    if (Option.isNone(sessionRuntime)) {
      return;
    }

    const local = yield* vcsStatusBroadcaster.refreshLocalStatus(sessionRuntime.value.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh local git status after turn completion", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          cwd: sessionRuntime.value.cwd,
          detail: error.message,
        }).pipe(Effect.as(null)),
      ),
    );
    if (local !== null) {
      yield* followWorktreeBranchDrift({
        threadId: event.threadId,
        cwd: sessionRuntime.value.cwd,
        local,
      });
      yield* refreshPullRequestAfterTurn({
        threadId: event.threadId,
        turnId: toTurnId(event.turnId),
        cwd: sessionRuntime.value.cwd,
        local,
      });
    }
  });

  // Retry a missing PR after the agent finishes its push and PR creation.
  // Re-read the projected branch after drift adoption. A rejected metadata
  // update must not let this thread refresh another thread's checkout.
  const refreshPullRequestAfterTurn = Effect.fn("refreshPullRequestAfterTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly cwd: string;
    readonly local: VcsStatusLocalResult;
  }) {
    const checkedOutBranch = input.local.refName;
    if (checkedOutBranch === null || input.local.isDefaultRef) return;
    const thread = yield* projectionSnapshotQuery
      .getThreadShellById(input.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread || thread.branch !== checkedOutBranch) return;
    if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, input.turnId)) return;
    yield* vcsStatusBroadcaster.refreshPullRequestStatus(input.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh pull request status after turn completion", {
          threadId: input.threadId,
          cwd: input.cwd,
          detail: error.message,
        }),
      ),
    );
  });

  // A `git checkout` run inside a thread's dedicated worktree (by an agent or
  // the user) bypasses T3's commands, so the thread's recorded branch goes
  // stale. Since #4460 the client only attributes PR state to a thread when
  // the checked-out branch equals the recorded one, so stale metadata silently
  // orphans the thread's PR. Follow the drift here: adopt the checked-out
  // branch as the thread's branch, but only when the worktree belongs to
  // exactly this thread — for shared cwds the strict matching is the point.
  const followWorktreeBranchDrift = Effect.fn("followWorktreeBranchDrift")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly local: VcsStatusLocalResult;
  }) {
    // Detached HEAD has no branch to adopt; a temporary placeholder checkout
    // means the first-turn auto-rename is still in flight — don't race it.
    const checkedOutBranch = input.local.refName;
    if (checkedOutBranch === null || isTemporaryWorktreeBranch(checkedOutBranch)) {
      return;
    }

    yield* Effect.gen(function* () {
      const thread = yield* projectionSnapshotQuery
        .getThreadShellById(input.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (
        !thread ||
        thread.branch === null ||
        thread.branch === checkedOutBranch ||
        thread.worktreePath === null ||
        thread.worktreePath !== input.cwd
      ) {
        return;
      }

      const shell = yield* projectionSnapshotQuery.getShellSnapshot();
      const worktreeIsShared = shell.threads.some(
        (other) => other.id !== thread.id && other.worktreePath === thread.worktreePath,
      );
      if (worktreeIsShared) {
        return;
      }

      // expectedBranch makes this a compare-and-swap in the decider: if the
      // recorded branch moved between our read and the dispatch (rename,
      // concurrent drift-follow), the stale update is dropped.
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-drift"),
        threadId: thread.id,
        branch: checkedOutBranch,
        expectedBranch: thread.branch,
      });
      yield* Effect.logInfo("thread branch followed worktree checkout", {
        threadId: thread.id,
        previousBranch: thread.branch,
        branch: checkedOutBranch,
      });
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("failed to follow worktree branch drift", {
            threadId: input.threadId,
            cause: Cause.pretty(cause),
          }),
      ),
    );
  });

  // Refreshing git status ends in a remote PR lookup under the vcs status
  // write lock. Run it on its own worker so file capture for this turn (and
  // checkpoints for other threads) never wait behind that network call.
  const statusRefreshWorker = yield* makeDrainableWorker(
    (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) =>
      refreshLocalGitStatusFromTurnCompletion(event).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          () =>
            Effect.logWarning("failed to refresh git status after turn completion", {
              threadId: event.threadId,
            }),
        ),
      ),
  );

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fn(
    "ensurePreTurnBaselineFromDomainTurnStart",
  )(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      // A bootstrap message lands before the worktree exists; its baseline
      // would snapshot the project checkout. The turn-start event that
      // follows captures it against the right cwd.
      if (
        event.metadata.historyImport === true ||
        event.metadata.deferredTurn === true ||
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread) {
      return;
    }

    yield* ensurePreTurnBaselines({ thread, createdAt: event.occurredAt });
  });

  // Checkpoints contain the whole checkout, so restoring a shared cwd can erase a sibling's work.
  const isRestoreWorkspaceIsolated = Effect.fn("isRestoreWorkspaceIsolated")(function* (
    thread: { readonly id: ThreadId; readonly worktreePath: string | null },
    cwd: string,
  ) {
    if (thread.worktreePath === null) return false;
    const canonicalCwd = yield* fileSystem.realPath(cwd);
    if ((yield* fileSystem.realPath(thread.worktreePath)) !== canonicalCwd) return false;
    return yield* isScopeUnshared(thread.id, canonicalCwd);
  });

  // True when no other thread (active or archived) or open provider session
  // works inside, or above, the canonical `scope` path.
  const isScopeUnshared = Effect.fn("isScopeUnshared")(function* (
    threadId: ThreadId,
    scope: string,
  ) {
    const active = yield* projectionSnapshotQuery.getShellSnapshot();
    const archived = yield* projectionSnapshotQuery.getArchivedShellSnapshot();
    const projects = [...active.projects, ...archived.projects];
    const paths = new Set<string>();
    for (const other of [...active.threads, ...archived.threads]) {
      if (other.id === threadId) continue;
      const candidate =
        other.worktreePath ??
        projects.find((project) => project.id === other.projectId)?.workspaceRoot;
      if (candidate !== undefined) paths.add(candidate);
    }
    for (const session of yield* providerService.listSessions()) {
      if (session.threadId !== threadId && session.status !== "closed" && session.cwd !== undefined)
        paths.add(session.cwd);
    }
    for (const candidate of paths) {
      const otherCwd = yield* fileSystem
        .realPath(candidate)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
      if (otherCwd === null) continue;
      const isWithin = (parent: string, child: string) => {
        const relative = path.relative(parent, child);
        return (
          relative === "" ||
          (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
        );
      };
      // Parent and nested owners can both have files inside the restore target.
      if (isWithin(scope, otherCwd) || isWithin(otherCwd, scope)) return false;
    }
    return true;
  });

  // Titles of other threads with a provider session that is running (or
  // starting) a turn inside or above `scope`, a canonical path.
  const activeThreadTitlesInScope = Effect.fn("activeThreadTitlesInScope")(function* (
    threadId: ThreadId,
    scope: string,
  ) {
    const sessions = (yield* providerService.listSessions()).filter(
      (session) =>
        session.threadId !== threadId &&
        (session.status === "running" ||
          session.status === "connecting" ||
          session.activeTurnId !== undefined),
    );
    if (sessions.length === 0) return [];
    const ids = yield* sessionsInScope(scope, sessions, (path) =>
      fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path)),
    );
    if (ids.length === 0) return [];
    const shell = yield* projectionSnapshotQuery.getShellSnapshot();
    return ids.map(
      (id) => shell.threads.find((thread) => thread.id === id)?.title ?? "Another thread",
    );
  });

  // Rolls a Trellis project path back to the snapshot for checkpoint
  // `turnCount`. An idea restores only its folder; a dedicated workspace
  // restarts its container, so provider sessions inside it are stopped first
  // and resume on the next turn. Returns null after recording a failure.
  const restoreTrellisSnapshot = Effect.fn("restoreTrellisSnapshot")(function* (input: {
    readonly thread: {
      readonly id: ThreadId;
      readonly checkpoints: ReadonlyArray<{
        readonly checkpointTurnCount: number;
        readonly turnId: TurnId;
      }>;
    };
    readonly turnCount: number;
    readonly cwd: string;
    readonly createdAt: string;
  }) {
    const fail = (detail: string) =>
      appendRevertFailureActivity({
        threadId: input.thread.id,
        turnCount: input.turnCount,
        detail,
        createdAt: input.createdAt,
      }).pipe(
        Effect.catch(() => Effect.void),
        Effect.as(null),
      );
    if (Option.isNone(trellis)) return yield* fail("Trellis is unavailable.");
    const client = trellis.value;
    return yield* Effect.gen(function* () {
      const scope = trellisRestoreScope(yield* client.resolve(input.cwd));
      if (scope === null) {
        return yield* fail(
          "This folder is in the shared Trellis scratch workspace but not inside an idea, so restoring it would roll back every idea. Rewind the conversation without restoring files instead.",
        );
      }
      const canonicalScope = yield* fileSystem
        .realPath(scope.path)
        .pipe(Effect.orElseSucceed(() => scope.path));
      // Only work in progress blocks a restore: idle and archived threads
      // have nothing to lose that the undo snapshot does not keep.
      const busy = yield* activeThreadTitlesInScope(input.thread.id, canonicalScope);
      if (busy.length > 0) {
        return yield* fail(
          `${busy.map((title) => `"${title}"`).join(", ")} ${busy.length === 1 ? "is" : "are"} working in this ${scope.restartsWorkspace ? "Trellis workspace" : "Trellis idea"} right now, and restoring files would overwrite that work. Wait for ${busy.length === 1 ? "it" : "them"} to finish or stop ${busy.length === 1 ? "it" : "them"}, then try again.`,
        );
      }
      const selection = selectRollbackSnapshot({
        threadId: input.thread.id,
        turnCount: input.turnCount,
        checkpoints: input.thread.checkpoints,
        snapshots: yield* client.listSnapshots(input.cwd),
      });
      if (selection._tag === "Missing") return yield* fail(selection.detail);
      if (scope.restartsWorkspace) {
        // Idle sessions too, by canonical path: a symlinked root must not
        // leave a provider running through the restart.
        const threadIds = yield* sessionsInScope(
          canonicalScope,
          yield* providerService.listSessions(),
          (path) => fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path)),
        );
        for (const threadId of threadIds) {
          const sessionThreadId = ThreadId.make(threadId);
          yield* providerService.stopSession({ threadId: sessionThreadId }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to stop provider session before Trellis rollback", {
                threadId: sessionThreadId,
                detail: error.message,
              }),
            ),
          );
        }
      }
      const { undoSnapshot } = yield* client.rollback({
        target: input.cwd,
        snapshot: selection.snapshotId,
      });
      yield* Effect.logInfo("Trellis rollback restored files for a checkpoint revert", {
        threadId: input.thread.id,
        turnCount: input.turnCount,
        snapshot: selection.snapshotId,
        undoSnapshot,
      });
      yield* refreshWorkspaceEntries(input.cwd);
      return { undoSnapshot };
    }).pipe(
      Effect.catchTag("TrellisError", (error) => fail(`Trellis rollback failed: ${error.message}`)),
    );
  });

  const handleRevertRequested = Effect.fn("handleRevertRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);

    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Thread was not found in read model.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const trellisCwd = yield* trellisCwdOf(
      yield* resolveWorkspaceCwd({
        threadId: event.payload.threadId,
        thread,
        projects,
        preferSessionRuntime: true,
      }),
    );
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId: event.payload.threadId,
      thread,
      projects,
      preferSessionRuntime: true,
    }).pipe(
      Effect.catch((error) =>
        // Git state only matters for restoring files outside Trellis.
        event.payload.restoreFiles === false || trellisCwd !== undefined
          ? Effect.undefined
          : Effect.fail(error),
      ),
    );

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );

    if (event.payload.turnCount > currentTurnCount) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint turn count ${event.payload.turnCount} exceeds current turn count ${currentTurnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    yield* providerService.assertConversationRollbackSupported(event.payload.threadId);

    let trellisRestore: { readonly undoSnapshot: string | null } | null = null;
    if (event.payload.restoreFiles !== false && trellisCwd !== undefined) {
      // Trellis owns the files of its project paths: never git-restore them.
      trellisRestore = yield* restoreTrellisSnapshot({
        thread,
        turnCount: event.payload.turnCount,
        cwd: trellisCwd,
        createdAt: now,
      });
      if (trellisRestore === null) return;
    } else if (event.payload.restoreFiles !== false) {
      if (!checkpointCwd) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: "Checkpoint workspace is unavailable or is not a git repository.",
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      if (!(yield* isRestoreWorkspaceIsolated(thread, checkpointCwd))) {
        yield* appendRevertFailureActivity({
          threadId: thread.id,
          turnCount: event.payload.turnCount,
          detail:
            "File restore requires an isolated worktree. This workspace may contain changes from another thread. Rewind the conversation without restoring files instead.",
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      const targetCheckpointRef =
        event.payload.turnCount === 0
          ? checkpointRefForThreadTurn(event.payload.threadId, 0)
          : thread.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
            )?.checkpointRef;

      if (!targetCheckpointRef) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: `Checkpoint ref for turn ${event.payload.turnCount} is unavailable in read model.`,
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      const restored = yield* checkpointStore.restoreCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: targetCheckpointRef,
        fallbackToHead: event.payload.turnCount === 0,
      });
      if (!restored) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: `Filesystem checkpoint is unavailable for turn ${event.payload.turnCount}.`,
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      // Refresh the workspace entry index so the @-mention file picker
      // reflects the reverted filesystem state.
      yield* refreshWorkspaceEntries(checkpointCwd);
    }

    const rolledBackTurns = Math.max(0, currentTurnCount - event.payload.turnCount);
    if (rolledBackTurns > 0) {
      const rewound = yield* providerService
        .rollbackConversation({
          threadId: event.payload.threadId,
          numTurns: rolledBackTurns,
        })
        .pipe(
          Effect.as(true),
          Effect.catch((error) => {
            // Files already moved back: tell the user how to undo that.
            if (trellisRestore === null) return Effect.fail(error);
            const undo = trellisRestore.undoSnapshot;
            return appendRevertFailureActivity({
              threadId: event.payload.threadId,
              turnCount: event.payload.turnCount,
              detail: `Trellis restored the files, but rewinding the conversation failed: ${error.message}${
                undo === null
                  ? ""
                  : ` To undo the file restore, roll back to Trellis snapshot ${undo} (\`trellis rollback --target ${trellisCwd} ${undo}\`).`
              }`,
              createdAt: now,
            }).pipe(
              Effect.catch(() => Effect.void),
              Effect.as(false),
            );
          }),
        );
      if (!rewound) return;
    }

    const staleCheckpointRefs: Array<CheckpointRef> = [];
    for (const checkpoint of thread.checkpoints) {
      if (
        checkpoint.checkpointTurnCount > event.payload.turnCount &&
        !isTrellisCheckpointRef(checkpoint.checkpointRef)
      ) {
        staleCheckpointRefs.push(checkpoint.checkpointRef);
      }
    }

    if (checkpointCwd && staleCheckpointRefs.length > 0) {
      yield* checkpointStore.deleteCheckpointRefs({
        cwd: checkpointCwd,
        checkpointRefs: staleCheckpointRefs,
      });
    }

    yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId: yield* serverCommandId("checkpoint-revert-complete"),
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        createdAt: now,
      })
      .pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: now,
          }),
        ),
        Effect.asVoid,
      );
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      if (event.type === "thread.turn-start-requested") pending.add(event.payload.threadId);
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendRevertFailureActivity({
              threadId: event.payload.threadId,
              turnCount: event.payload.turnCount,
              detail: error.message,
              createdAt,
            }),
          ),
        ),
      );
      return;
    }
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type === "session.exited") {
      startedTurns.delete(event.threadId);
      pending.delete(event.threadId);
      return;
    }

    if (event.type === "turn.started") {
      const turnId = toTurnId(event.turnId);
      const activeTurnId = (yield* providerService.listSessions()).find((session) =>
        sameId(session.threadId, event.threadId),
      )?.activeTurnId;
      const mayReplace = pending.has(event.threadId) && sameId(activeTurnId, turnId);
      if (turnId !== null && (!startedTurns.has(event.threadId) || mayReplace)) {
        startedTurns.set(event.threadId, turnId);
        pending.delete(event.threadId);
      }
      yield* ensurePreTurnBaselineFromTurnStart(event);
      return;
    }

    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      const turnId = toTurnId(event.turnId);
      const thread = yield* resolveThreadDetail(event.threadId);
      const startedTurnId = startedTurns.get(event.threadId);
      const isTrackedTurn = sameId(startedTurnId, turnId);
      if (isTrackedTurn) startedTurns.delete(event.threadId);
      if (event.type === "turn.completed") {
        yield* statusRefreshWorker.enqueue(event);
      }
      if (
        turnId !== null &&
        thread !== undefined &&
        (isTrackedTurn ||
          sameId(thread.session?.activeTurnId, turnId) ||
          (startedTurnId === undefined && !thread.session?.activeTurnId))
      ) {
        pending.delete(event.threadId);
        yield* pullRequests.refreshAfterTurn(thread.projectId);
      }
      if (
        event.type === "turn.aborted" &&
        !isTrackedTurn &&
        !sameId(thread?.session?.activeTurnId, turnId)
      ) {
        return;
      }
      yield* captureCheckpointFromTurnCompletion(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.threadId,
              turnId,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      );
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<
    void,
    CheckpointStoreError | OrchestrationDispatchError | PlatformError.PlatformError,
    never
  > =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("checkpoint reactor failed to process input", {
            source: input.source,
            eventType: input.event.type,
            cause: Cause.pretty(cause),
          }),
      ),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: CheckpointReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.checkpoint-revert-requested"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (
          event.type !== "turn.started" &&
          event.type !== "turn.completed" &&
          event.type !== "turn.aborted" &&
          event.type !== "session.exited"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain.pipe(
      Effect.andThen(statusRefreshWorker.drain),
      Effect.andThen(entryRefreshWorker.drain),
    ),
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make);
