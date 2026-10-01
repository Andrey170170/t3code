/**
 * TrellisRestore - what a checkpoint restore in a Trellis project covers, and
 * what it waits for and refuses.
 *
 * A Trellis restore rewrites a *restore scope*: an idea's folder (the scratch
 * workspace keeps running for other ideas) or a whole dedicated workspace
 * (its container restarts). Threads share scopes freely, so V2's "isolated
 * worktree" rule would refuse every Trellis restore; instead the restore is
 * refused while another thread works in the scope, and needs the user to
 * acknowledge other threads whose later work it would undo.
 *
 * One path gate orders the operations that rewrite a scope (restores, trash)
 * against each other and against turn starts: a restore holds its scope from
 * before the safety check through the file restore, and a turn starting
 * inside a held scope waits until it is released.
 *
 * Provides V2's `RestoreLease`, `TurnAdmission` and `CheckpointRestoreRule`
 * seams; without the Trellis service each is V2's default.
 *
 * @module trellis/TrellisRestore
 */
import type {
  OrchestrationV2Run,
  OrchestrationV2ThreadShellSnapshot,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { pathsOverlap } from "@t3tools/shared/trellis";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import {
  CheckpointRestoreRule,
  CheckpointRestoreRuleError,
  type CheckpointRestoreRuleShape,
  isolatedWorktreeRestoreRule,
} from "../orchestration-v2/CheckpointRestoreSafety.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import {
  makeCwdRestoreLease,
  RestoreLease,
  type RestoreLeaseShape,
} from "../orchestration-v2/RestoreLease.ts";
import { TurnAdmission, type TurnAdmissionShape } from "../orchestration-v2/TurnAdmission.ts";
import { Trellis, trellisRootOf, trellisWorkspaceOf } from "./Trellis.ts";

export interface TrellisRestoreGateShape {
  /**
   * Holds `paths` until the surrounding scope closes, once no other hold
   * overlaps any of them (one path containing the other).
   */
  readonly hold: (paths: ReadonlyArray<string>) => Effect.Effect<void, never, Scope.Scope>;
  /** Waits until no hold overlaps `path`; true when it had to wait. */
  readonly waitFree: (path: string) => Effect.Effect<boolean>;
}

/** The gate shared by restores, trash and turn admission of one server. */
export class TrellisRestoreGate extends Context.Service<
  TrellisRestoreGate,
  TrellisRestoreGateShape
>()("t3/trellis/TrellisRestore/TrellisRestoreGate") {}

function makeRestoreGate(): TrellisRestoreGateShape {
  const holds = new Map<number, ReadonlyArray<string>>();
  let nextId = 0;
  // Completed and replaced on every release; waiters capture it before they
  // check, so a release between the check and the wait is never missed.
  let released = Deferred.makeUnsafe<void>();
  const overlapsHold = (paths: ReadonlyArray<string>) =>
    [...holds.values()].some((held) =>
      held.some((heldPath) => paths.some((path) => pathsOverlap(heldPath, path))),
    );
  const release = (id: number) =>
    Effect.sync(() => {
      holds.delete(id);
      const previous = released;
      released = Deferred.makeUnsafe<void>();
      Deferred.doneUnsafe(previous, Effect.void);
    });
  return {
    hold: (paths) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          while (true) {
            const wake = released;
            if (!overlapsHold(paths)) {
              const id = nextId++;
              holds.set(id, paths);
              yield* Effect.addFinalizer(() => release(id));
              return;
            }
            yield* restore(Deferred.await(wake));
          }
        }),
      ),
    waitFree: (path) =>
      Effect.gen(function* () {
        let waited = false;
        while (true) {
          const wake = released;
          if (!overlapsHold([path])) return waited;
          waited = true;
          yield* Deferred.await(wake);
        }
      }),
  };
}

export const gateLayer = Layer.sync(TrellisRestoreGate, makeRestoreGate);

export interface TrellisRestoreScope {
  /** The directory a restore rewrites: the idea folder or the workspace's project. */
  readonly path: string;
  /** True when the restore replaces the workspace and restarts its container. */
  readonly restartsWorkspace: boolean;
}

/**
 * The restore scope of `cwd`, or null for a path outside Trellis. When
 * Trellis cannot say, the whole workspace (the widest scope) is assumed.
 */
export const restoreScopeOf = Effect.fn("TrellisRestore.restoreScopeOf")(function* (
  trellis: Trellis["Service"],
  cwd: string,
) {
  const roots = yield* trellis.expectedRoots;
  const path = yield* trellis.canonicalPath(cwd);
  const root = trellisRootOf(roots, path);
  const workspaceId = trellisWorkspaceOf(roots, path);
  if (root === null || workspaceId === null) return null;
  const resolved = yield* trellis.resolve(path).pipe(Effect.option);
  if (Option.isNone(resolved)) {
    return {
      path: `${root}/workspaces/${workspaceId}/project`,
      restartsWorkspace: true,
    } satisfies TrellisRestoreScope;
  }
  const { workspace, project } = resolved.value;
  return (
    workspace.kind === "scratch" && project?.kind === "idea"
      ? { path: yield* trellis.canonicalPath(project.path), restartsWorkspace: false }
      : { path: yield* trellis.canonicalPath(workspace.path), restartsWorkspace: true }
  ) satisfies TrellisRestoreScope;
});

const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);
// Every run that may have written files, including ones that ended early.
const ENDED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

export interface TrellisRestoreConflicts {
  /** Other threads with an active or queued run in the scope. */
  readonly running: ReadonlyArray<{ readonly threadId: ThreadId; readonly title: string }>;
  /** Other threads with runs in the scope that ended after the checkpoint. */
  readonly later: ReadonlyArray<{ readonly threadId: ThreadId; readonly title: string }>;
}

/** What restore conflicts are computed from, so both the rule and the RPC can share it. */
export interface TrellisRestoreConflictReads<E> {
  readonly shell: Effect.Effect<OrchestrationV2ThreadShellSnapshot, E>;
  readonly records: (threadId: ThreadId) => Effect.Effect<
    {
      readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "status" | "completedAt">>;
    },
    E
  >;
  readonly projectRoot: (projectId: ProjectId) => Effect.Effect<string | undefined>;
}

/**
 * Other threads that work in `scopePath` (by worktree or project folder):
 * those still running there, and those whose runs there ended after
 * `since`. Archived threads count as idle.
 */
export const restoreConflictsIn = Effect.fn("TrellisRestore.restoreConflictsIn")(function* <E>(
  trellis: Trellis["Service"],
  reads: TrellisRestoreConflictReads<E>,
  input: {
    readonly threadId: ThreadId;
    readonly scopePath: string;
    readonly since: DateTime.Utc;
  },
) {
  const shell = yield* reads.shell;
  const archived = new Set(shell.archivedThreads.map((thread) => thread.id));
  const running: Array<{ threadId: ThreadId; title: string }> = [];
  const later: Array<{ threadId: ThreadId; title: string }> = [];
  for (const thread of [...shell.threads, ...shell.archivedThreads]) {
    if (thread.id === input.threadId || thread.deletedAt !== null) continue;
    // A thread works in its worktree or project folder (its checkpoint
    // scopes lie there), so other projects' records are never read.
    const paths = [thread.worktreePath, yield* reads.projectRoot(thread.projectId)].filter(
      (path): path is string => path != null,
    );
    let inScope = false;
    for (const path of paths) {
      if (pathsOverlap(input.scopePath, yield* trellis.canonicalPath(path))) {
        inScope = true;
        break;
      }
    }
    if (!inScope) continue;
    const records = yield* reads.records(thread.id);
    const entry = { threadId: thread.id, title: thread.title };
    if (
      !archived.has(thread.id) &&
      records.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))
    ) {
      running.push(entry);
    } else if (
      records.runs.some(
        (run) =>
          ENDED_RUN_STATUSES.has(run.status) &&
          run.completedAt !== null &&
          DateTime.isGreaterThan(run.completedAt, input.since),
      )
    ) {
      later.push(entry);
    }
  }
  return { running, later } satisfies TrellisRestoreConflicts;
});

const quoted = (threads: ReadonlyArray<{ readonly title: string }>) =>
  threads.map((thread) => `"${thread.title}"`).join(", ");

/** The refusal for `conflicts`, or null when nothing unacknowledged stands in the way. */
function restoreRefusal(
  conflicts: TrellisRestoreConflicts,
  acknowledged: ReadonlyArray<ThreadId>,
): string | null {
  if (conflicts.running.length > 0) {
    const one = conflicts.running.length === 1;
    return `${quoted(conflicts.running)} ${one ? "is" : "are"} still working in this Trellis workspace, and restoring its files would undo that work. Wait for ${one ? "it" : "them"} to finish or stop ${one ? "it" : "them"}, then try again.`;
  }
  const unacknowledged = conflicts.later.filter(
    (thread) => !acknowledged.includes(thread.threadId),
  );
  if (unacknowledged.length === 0) return null;
  return `Restoring these files would also undo later work by ${quoted(unacknowledged)} in the same Trellis workspace. Confirm the restore to undo it too.`;
}

/**
 * V2's restore seams for Trellis projects: the lease and turn admission use
 * the gate by restore scope, and the rule reports conflicts instead of
 * requiring an isolated worktree. Paths outside Trellis keep V2's defaults.
 */
export const layer: Layer.Layer<never, never, ProjectStoreV2> = Layer.effectContext(
  Effect.gen(function* () {
    const trellisOption = yield* Effect.serviceOption(Trellis);
    const gateOption = yield* Effect.serviceOption(TrellisRestoreGate);
    const projects = yield* ProjectStoreV2;
    const cwdLease = makeCwdRestoreLease();
    const seams = (
      lease: RestoreLeaseShape,
      admission: TurnAdmissionShape,
      rule: CheckpointRestoreRuleShape,
      // References: their keys carry no service type.
    ): Context.Context<never> =>
      Context.make(RestoreLease, lease).pipe(
        Context.add(TurnAdmission, admission),
        Context.add(CheckpointRestoreRule, rule),
      );
    if (Option.isNone(trellisOption) || Option.isNone(gateOption)) {
      return seams(cwdLease, { start: () => Effect.succeed(false) }, isolatedWorktreeRestoreRule);
    }
    const trellis = trellisOption.value;
    const gate = gateOption.value;
    const projectRoot = (projectId: ProjectId) =>
      projects.get(projectId).pipe(
        Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot),
        Effect.orElseSucceed(() => undefined),
      );

    return seams(
      {
        acquire: (scope) =>
          Effect.gen(function* () {
            const restoreScope = yield* restoreScopeOf(trellis, scope.cwd);
            if (restoreScope === null) return yield* cwdLease.acquire(scope);
            yield* gate.hold([restoreScope.path]);
          }),
      },
      {
        start: ({ cwd }) =>
          Effect.gen(function* () {
            const path = yield* trellis.canonicalPath(cwd);
            if (trellisRootOf(yield* trellis.expectedRoots, path) === null) return false;
            return yield* gate.waitFree(path);
          }),
      },
      {
        check: (input, dependencies) =>
          Effect.gen(function* () {
            const restoreScope = yield* restoreScopeOf(trellis, input.scope.cwd);
            if (restoreScope === null) {
              return yield* isolatedWorktreeRestoreRule.check(input, dependencies);
            }
            const conflicts = yield* restoreConflictsIn(
              trellis,
              {
                shell: dependencies.projections.getShellSnapshot(),
                records: (threadId) =>
                  dependencies.projections.getThreadRecords(threadId, ["runs", "checkpointScopes"]),
                projectRoot,
              },
              {
                threadId: input.thread.id,
                scopePath: restoreScope.path,
                since: input.checkpoint.capturedAt,
              },
            ).pipe(Effect.mapError((cause) => new CheckpointRestoreRuleError({ cause })));
            return restoreRefusal(conflicts, input.acknowledgeThreads);
          }),
      },
    );
  }),
);
