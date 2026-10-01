import type {
  OrchestrationV2AppThread,
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointScope,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";

export const SHARED_WORKSPACE_RESTORE_MESSAGE =
  "File restore requires an isolated worktree. This workspace may contain changes from another thread. Rewind the conversation without restoring files instead.";

// A checkpoint snapshots the whole checkout. Check at command admission and
// again before provider rollback so a newly shared worktree is rejected too.
export const isCheckpointRestoreIsolated = Effect.fn("orchestrationV2.isCheckpointRestoreIsolated")(
  function* (
    thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath">,
    scope: Pick<OrchestrationV2CheckpointScope, "cwd">,
    dependencies: {
      readonly fileSystem: FileSystem.FileSystem;
      readonly projections: ProjectionStoreV2["Service"];
    },
  ) {
    const { fileSystem, projections } = dependencies;
    const worktreePath = thread.worktreePath;
    let shared = worktreePath == null;
    if (!shared && worktreePath !== null) {
      const cwd = yield* fileSystem.realPath(scope.cwd);
      const worktreeCwd = yield* fileSystem.realPath(worktreePath);
      shared = cwd !== worktreeCwd;
      if (!shared) {
        const shell = yield* projections.getShellSnapshot();
        const checkedPaths = new Set<string>();
        for (const otherThread of [...shell.threads, ...shell.archivedThreads]) {
          if (otherThread.id === thread.id || otherThread.deletedAt !== null) continue;
          const other = yield* projections.getCheckpointContext(otherThread.id);
          const paths = [
            otherThread.worktreePath,
            ...other.checkpointScopes.map((candidate) => candidate.cwd),
          ].filter((value): value is string => value !== null);
          for (const candidate of paths) {
            if (checkedPaths.has(candidate)) continue;
            checkedPaths.add(candidate);
            const otherCwd = yield* fileSystem
              .realPath(candidate)
              .pipe(
                Effect.catch((error) =>
                  error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
                ),
              );
            if (otherCwd === cwd) {
              shared = true;
              break;
            }
          }
          if (shared) break;
        }
      }
    }
    return !shared;
  },
);

export class CheckpointRestoreRuleError extends Schema.TaggedError<CheckpointRestoreRuleError>()(
  "CheckpointRestoreRuleError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not check whether this checkpoint restore is safe.";
  }
}

export interface CheckpointRestoreRuleInput {
  readonly thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath">;
  readonly scope: OrchestrationV2CheckpointScope;
  readonly checkpoint: OrchestrationV2Checkpoint;
  /** Threads whose later work the user agreed to undo. */
  readonly acknowledgeThreads: ReadonlyArray<ThreadId>;
}

export interface CheckpointRestoreRuleShape {
  /**
   * Null when restoring `checkpoint`'s files may proceed, else the refusal
   * shown to the user. Checked at command admission and again under the
   * restore lease before the provider rewinds.
   */
  readonly check: (
    input: CheckpointRestoreRuleInput,
    dependencies: {
      readonly fileSystem: FileSystem.FileSystem;
      readonly projections: ProjectionStoreV2["Service"];
    },
  ) => Effect.Effect<string | null, CheckpointRestoreRuleError>;
}

/** V2's rule: file restores need an isolated worktree. */
export const isolatedWorktreeRestoreRule: CheckpointRestoreRuleShape = {
  check: (input, dependencies) =>
    isCheckpointRestoreIsolated(input.thread, input.scope, dependencies).pipe(
      Effect.map((isolated) => (isolated ? null : SHARED_WORKSPACE_RESTORE_MESSAGE)),
      Effect.mapError((cause) => new CheckpointRestoreRuleError({ cause })),
    ),
};

/** Seam for workspaces whose restores follow other rules (Trellis restore scopes). */
export class CheckpointRestoreRule extends Context.Reference<CheckpointRestoreRuleShape>(
  "t3/orchestration-v2/CheckpointRestoreRule",
  { defaultValue: () => isolatedWorktreeRestoreRule },
) {}
