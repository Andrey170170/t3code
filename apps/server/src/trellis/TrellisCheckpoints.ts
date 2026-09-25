// @effect-diagnostics nodeBuiltinImport:off
/**
 * TrellisCheckpoints - maps T3 checkpoint reverts onto Trellis snapshots.
 *
 * For a Trellis project path the checkpoint reactor tags one snapshot per
 * thread as the baseline (before its first turn) and one per completed turn.
 * Reverting to checkpoint N rolls back to the snapshot of the turn that
 * produced checkpoint N; reverting to 0 rolls back to the baseline.
 *
 * @module trellis/TrellisCheckpoints
 */
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import type { TrellisResolved, TrellisSnapshot } from "./Trellis.ts";

/** The `turn` tag of the snapshot taken before a thread's first turn. */
export const BASELINE_TURN = "baseline";

/**
 * Checkpoint refs of turns recorded only as Trellis snapshots (the cwd is not
 * a git repository). They have no git diff.
 */
export const TRELLIS_CHECKPOINT_REF_PREFIX = "trellis:";

export const isTrellisCheckpointRef = (ref: string) =>
  ref.startsWith(TRELLIS_CHECKPOINT_REF_PREFIX);

export type RollbackSnapshotSelection =
  | { readonly _tag: "Found"; readonly snapshotId: string }
  | { readonly _tag: "Missing"; readonly detail: string };

export function selectRollbackSnapshot(input: {
  readonly threadId: string;
  readonly turnCount: number;
  readonly checkpoints: ReadonlyArray<{
    readonly checkpointTurnCount: number;
    readonly turnId: string;
  }>;
  /** Oldest first, as Trellis lists them. */
  readonly snapshots: ReadonlyArray<TrellisSnapshot>;
}): RollbackSnapshotSelection {
  const ofThread = input.snapshots.filter((snapshot) => snapshot.thread === input.threadId);
  if (input.turnCount === 0) {
    // The first baseline is the state before the thread ever ran.
    const baseline = ofThread.find((snapshot) => snapshot.turn === BASELINE_TURN);
    return baseline
      ? { _tag: "Found", snapshotId: baseline.id }
      : {
          _tag: "Missing",
          detail: "No Trellis snapshot was taken before this thread's first turn.",
        };
  }
  const checkpoint = input.checkpoints.find(
    (entry) => entry.checkpointTurnCount === input.turnCount,
  );
  if (!checkpoint) {
    return {
      _tag: "Missing",
      detail: `Checkpoint for turn ${input.turnCount} is unavailable in read model.`,
    };
  }
  const snapshot = ofThread.findLast((entry) => entry.turn === checkpoint.turnId);
  return snapshot
    ? { _tag: "Found", snapshotId: snapshot.id }
    : {
        _tag: "Missing",
        detail: `No Trellis snapshot was taken after turn ${input.turnCount}.`,
      };
}

/**
 * What a rollback of a path restores: the idea folder for an idea in scratch,
 * or the whole dedicated workspace (which also restarts its container). Null
 * for a scratch path outside any live idea, where a rollback would reach
 * every idea.
 */
export function trellisRestoreScope(resolved: TrellisResolved): {
  readonly path: string;
  readonly restartsWorkspace: boolean;
} | null {
  if (resolved.workspace.kind === "scratch") {
    return resolved.project?.kind === "idea"
      ? { path: resolved.project.path, restartsWorkspace: false }
      : null;
  }
  return { path: resolved.workspace.path, restartsWorkspace: true };
}

/** True when either path contains the other. */
export function pathsOverlap(left: string, right: string): boolean {
  const within = (parent: string, child: string) => {
    const relative = NodePath.posix.relative(parent, child);
    return (
      relative === "" ||
      (!NodePath.posix.isAbsolute(relative) && relative !== ".." && !relative.startsWith("../"))
    );
  };
  return within(left, right) || within(right, left);
}

/**
 * Threads whose open provider session works inside or above `scope` (a
 * canonical path). Session cwds are canonicalized first, so a symlinked path
 * to the same workspace still counts.
 */
export const sessionsInScope = <E, R>(
  scope: string,
  sessions: ReadonlyArray<{
    readonly threadId: string;
    readonly status: string;
    readonly cwd?: string | undefined;
  }>,
  canonicalize: (path: string) => Effect.Effect<string, E, R>,
): Effect.Effect<ReadonlyArray<string>, E, R> =>
  Effect.forEach(sessions, (session) =>
    session.status === "closed" || session.cwd === undefined
      ? Effect.succeed(null)
      : canonicalize(session.cwd).pipe(
          Effect.map((cwd) => (pathsOverlap(scope, cwd) ? session.threadId : null)),
        ),
  ).pipe(Effect.map((ids) => ids.filter((id): id is string => id !== null)));
