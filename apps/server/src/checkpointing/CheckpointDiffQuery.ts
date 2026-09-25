/**
 * CheckpointDiffQuery - Query interface for computed checkpoint diffs.
 *
 * Provides read-only diff operations across checkpoint snapshots used by
 * orchestration APIs.
 *
 * @module CheckpointDiffQuery
 */
import {
  type CheckpointRef,
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  CheckpointDiffResultInvalidError,
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
  CheckpointWorkspacePathMissingError,
} from "./Errors.ts";
import type { CheckpointServiceError } from "./Errors.ts";
import { checkpointRefForThreadTurn } from "./Utils.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { isTrellisCheckpointRef } from "../trellis/TrellisCheckpoints.ts";

/** Service tag for checkpoint diff queries. */
export class CheckpointDiffQuery extends Context.Service<
  CheckpointDiffQuery,
  {
    /**
     * Read the patch diff for a single turn checkpoint transition.
     *
     * Verifies checkpoint availability in both projection state and filesystem.
     */
    readonly getTurnDiff: (
      input: OrchestrationGetTurnDiffInput,
    ) => Effect.Effect<OrchestrationGetTurnDiffResultType, CheckpointServiceError>;

    /**
     * Read the full patch diff across a thread range of checkpoints.
     *
     * Uses turn-diff semantics with `fromTurnCount = 0`.
     */
    readonly getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointServiceError>;
  }
>()("t3/checkpointing/CheckpointDiffQuery") {}

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);

function buildTurnDiffResult(
  input: {
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  },
  diff: string,
): OrchestrationGetTurnDiffResultType {
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    diff,
  };
}

type CheckpointEntry = {
  readonly checkpointTurnCount: number;
  readonly checkpointRef: string;
};

/**
 * True when the thread's earliest checkpoints were recorded only as Trellis
 * snapshots (the folder was not a git repository yet), so no git baseline
 * exists before its first git checkpoint.
 */
export function startsWithTrellisOnlyTurns(checkpoints: ReadonlyArray<CheckpointEntry>): boolean {
  const first = checkpoints.toSorted(
    (left, right) => left.checkpointTurnCount - right.checkpointTurnCount,
  )[0];
  return first !== undefined && isTrellisCheckpointRef(first.checkpointRef);
}

/**
 * The first git checkpoint strictly between `afterTurnCount` and
 * `beforeTurnCount`: the base for the git part of a range that starts in
 * Trellis-only turns. Null when that range has no earlier git checkpoint, so
 * there is nothing to diff.
 */
export function firstGitCheckpointBetween(
  checkpoints: ReadonlyArray<CheckpointEntry>,
  afterTurnCount: number,
  beforeTurnCount: number,
): CheckpointRef | null {
  const base = checkpoints
    .filter(
      (checkpoint) =>
        checkpoint.checkpointTurnCount > afterTurnCount &&
        checkpoint.checkpointTurnCount < beforeTurnCount &&
        !isTrellisCheckpointRef(checkpoint.checkpointRef),
    )
    .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)[0];
  return base === undefined ? null : (base.checkpointRef as CheckpointRef);
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;

  const diffFromOrEmpty = <E>(
    base: CheckpointRef | null,
    diffFrom: (from: CheckpointRef) => Effect.Effect<string, E>,
  ): Effect.Effect<string, E> => (base === null ? Effect.succeed("") : diffFrom(base));

  /**
   * After a diff from the turn-0 git baseline failed: if that ref is really
   * absent because the thread's first turns were Trellis-only, diff from its
   * first git checkpoint. Any other failure, such as a timeout, stays an error.
   */
  const fallbackForMissingBaseline = <E>(input: {
    readonly error: E;
    readonly cwd: string;
    readonly baselineRef: CheckpointRef;
    readonly checkpoints: ReadonlyArray<CheckpointEntry>;
    readonly toTurnCount: number;
    readonly diffFrom: (from: CheckpointRef) => Effect.Effect<string, E>;
  }): Effect.Effect<string, E> =>
    startsWithTrellisOnlyTurns(input.checkpoints)
      ? checkpointStore.hasCheckpointRef({ cwd: input.cwd, checkpointRef: input.baselineRef }).pipe(
          Effect.catch(() => Effect.succeed(true)),
          Effect.flatMap((exists) =>
            exists
              ? Effect.fail(input.error)
              : diffFromOrEmpty(
                  firstGitCheckpointBetween(input.checkpoints, 0, input.toTurnCount),
                  input.diffFrom,
                ),
          ),
        )
      : Effect.fail(input.error);

  const getTurnDiff: CheckpointDiffQuery["Service"]["getTurnDiff"] = Effect.fn("getTurnDiff")(
    function* (input) {
      const operation = "CheckpointDiffQuery.getTurnDiff";
      const ignoreWhitespace = input.ignoreWhitespace ?? true;
      yield* Effect.annotateCurrentSpan({
        "checkpoint.thread_id": input.threadId,
        "checkpoint.from_turn_count": input.fromTurnCount,
        "checkpoint.to_turn_count": input.toTurnCount,
        "checkpoint.ignore_whitespace": ignoreWhitespace,
      });

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff: OrchestrationGetTurnDiffResultType = {
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          diff: "",
        };
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointDiffResultInvalidError({
            operation,
            threadId: input.threadId,
          });
        }
        return emptyDiff;
      }

      const threadContext = yield* projectionSnapshotQuery
        .getThreadCheckpointContext(input.threadId)
        .pipe(Effect.withSpan("checkpoint.turnDiff.lookupContext"));
      if (Option.isNone(threadContext)) {
        return yield* new CheckpointThreadNotFoundError({
          operation,
          threadId: input.threadId,
        });
      }

      const maxTurnCount = threadContext.value.checkpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
        0,
      );
      if (input.toTurnCount > maxTurnCount) {
        return yield* new CheckpointTurnRangeUnavailableError({
          operation,
          threadId: input.threadId,
          requestedTurnCount: input.toTurnCount,
          availableTurnCount: maxTurnCount,
        });
      }

      const workspaceCwd = threadContext.value.worktreePath ?? threadContext.value.workspaceRoot;
      if (!workspaceCwd) {
        return yield* new CheckpointWorkspacePathMissingError({
          operation,
          threadId: input.threadId,
        });
      }

      const fromCheckpointRef =
        input.fromTurnCount === 0
          ? checkpointRefForThreadTurn(input.threadId, 0)
          : threadContext.value.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === input.fromTurnCount,
            )?.checkpointRef;
      if (!fromCheckpointRef) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          checkpoint: "from",
        });
      }

      const toCheckpointRef = threadContext.value.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === input.toTurnCount,
      )?.checkpointRef;
      if (!toCheckpointRef) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          checkpoint: "to",
        });
      }

      const diffFrom = (from: CheckpointRef) =>
        checkpointStore.diffCheckpoints({
          cwd: workspaceCwd,
          fromCheckpointRef: from,
          toCheckpointRef,
          fallbackFromToHead: false,
          ignoreWhitespace,
        });
      const checkpoints = threadContext.value.checkpoints;
      // Turns recorded only as Trellis snapshots have no git diff: a range
      // ending in one has none, and one starting in one diffs its git part.
      const diff = isTrellisCheckpointRef(toCheckpointRef)
        ? ""
        : isTrellisCheckpointRef(fromCheckpointRef)
          ? yield* diffFromOrEmpty(
              firstGitCheckpointBetween(checkpoints, input.fromTurnCount, input.toTurnCount),
              diffFrom,
            )
          : yield* diffFrom(fromCheckpointRef).pipe(
              Effect.catch((error) =>
                input.fromTurnCount === 0
                  ? fallbackForMissingBaseline({
                      error,
                      cwd: workspaceCwd,
                      baselineRef: fromCheckpointRef,
                      checkpoints,
                      toTurnCount: input.toTurnCount,
                      diffFrom,
                    })
                  : Effect.fail(error),
              ),
              Effect.withSpan("checkpoint.turnDiff.diffCheckpoints"),
            );

      const turnDiff = buildTurnDiffResult(input, diff);
      if (!isTurnDiffResult(turnDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }

      return turnDiff;
    },
  );

  const getFullThreadDiff: CheckpointDiffQuery["Service"]["getFullThreadDiff"] = Effect.fn(
    "CheckpointDiffQuery.getFullThreadDiff",
  )(function* (input) {
    const operation = "CheckpointDiffQuery.getFullThreadDiff";
    const ignoreWhitespace = input.ignoreWhitespace ?? true;
    yield* Effect.annotateCurrentSpan({
      "checkpoint.thread_id": input.threadId,
      "checkpoint.from_turn_count": 0,
      "checkpoint.to_turn_count": input.toTurnCount,
      "checkpoint.ignore_whitespace": ignoreWhitespace,
      "checkpoint.diff_kind": "full-thread",
    });

    if (input.toTurnCount === 0) {
      const emptyDiff = buildTurnDiffResult(
        {
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: 0,
        },
        "",
      );
      if (!isTurnDiffResult(emptyDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }
      return emptyDiff satisfies OrchestrationGetFullThreadDiffResult;
    }

    const threadContext = yield* projectionSnapshotQuery
      .getFullThreadDiffContext(input.threadId, input.toTurnCount)
      .pipe(Effect.withSpan("checkpoint.fullThread.lookupContext"));

    if (Option.isNone(threadContext)) {
      return yield* new CheckpointThreadNotFoundError({
        operation,
        threadId: input.threadId,
      });
    }

    if (input.toTurnCount > threadContext.value.latestCheckpointTurnCount) {
      return yield* new CheckpointTurnRangeUnavailableError({
        operation,
        threadId: input.threadId,
        requestedTurnCount: input.toTurnCount,
        availableTurnCount: threadContext.value.latestCheckpointTurnCount,
      });
    }

    const workspaceCwd = threadContext.value.worktreePath ?? threadContext.value.workspaceRoot;
    if (!workspaceCwd) {
      return yield* new CheckpointWorkspacePathMissingError({
        operation,
        threadId: input.threadId,
      });
    }

    if (!threadContext.value.toCheckpointRef) {
      return yield* new CheckpointRefUnavailableError({
        operation,
        threadId: input.threadId,
        turnCount: input.toTurnCount,
        checkpoint: "to",
      });
    }

    const toCheckpointRef = threadContext.value.toCheckpointRef as CheckpointRef;
    const diffFrom = (from: CheckpointRef) =>
      checkpointStore.diffCheckpoints({
        cwd: workspaceCwd,
        fromCheckpointRef: from,
        toCheckpointRef,
        fallbackFromToHead: false,
        ignoreWhitespace,
      });
    const baselineRef = checkpointRefForThreadTurn(input.threadId, 0);
    const diff = isTrellisCheckpointRef(toCheckpointRef)
      ? ""
      : yield* diffFrom(baselineRef).pipe(
          Effect.catch((error) =>
            projectionSnapshotQuery.getThreadCheckpointContext(input.threadId).pipe(
              Effect.catch(() => Effect.fail(error)),
              Effect.flatMap((context) =>
                Option.isNone(context)
                  ? Effect.fail(error)
                  : fallbackForMissingBaseline({
                      error,
                      cwd: workspaceCwd,
                      baselineRef,
                      checkpoints: context.value.checkpoints,
                      toTurnCount: input.toTurnCount,
                      diffFrom,
                    }),
              ),
            ),
          ),
          Effect.withSpan("checkpoint.fullThread.diffCheckpoints"),
        );

    const turnDiff = buildTurnDiffResult(
      {
        threadId: input.threadId,
        fromTurnCount: 0,
        toTurnCount: input.toTurnCount,
      },
      diff,
    );
    if (!isTurnDiffResult(turnDiff)) {
      return yield* new CheckpointDiffResultInvalidError({
        operation,
        threadId: input.threadId,
      });
    }

    return turnDiff satisfies OrchestrationGetFullThreadDiffResult;
  });

  return CheckpointDiffQuery.of({
    getTurnDiff,
    getFullThreadDiff,
  });
});

export const layer = Layer.effect(CheckpointDiffQuery, make);
