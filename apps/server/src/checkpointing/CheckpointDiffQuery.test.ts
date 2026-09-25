import {
  CheckpointRef,
  ProjectId,
  ThreadId,
  TurnId,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { checkpointRefForThreadTurn } from "./Utils.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { CheckpointThreadNotFoundError } from "./Errors.ts";

function makeThreadCheckpointContext(input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
}): ProjectionSnapshotQuery.ProjectionThreadCheckpointContext {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    workspaceRoot: input.workspaceRoot,
    worktreePath: input.worktreePath,
    checkpoints: [
      {
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: input.checkpointTurnCount,
        checkpointRef: input.checkpointRef,
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

describe("CheckpointDiffQuery.layer", () => {
  it.effect("uses the narrow full-thread context lookup for all-turns diffs", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-full-thread");
      const threadId = ThreadId.make("thread-full-thread");
      const toCheckpointRef = checkpointRefForThreadTurn(threadId, 4);
      let getThreadCheckpointContextCalls = 0;
      let getFullThreadDiffContextCalls = 0;
      const diffCheckpointsCalls: Array<{
        readonly fromCheckpointRef: CheckpointRef;
        readonly toCheckpointRef: CheckpointRef;
        readonly cwd: string;
        readonly ignoreWhitespace: boolean;
      }> = [];

      const checkpointStore: CheckpointStore.CheckpointStore["Service"] = {
        isGitRepository: () => Effect.succeed(true),
        captureCheckpoint: () => Effect.void,
        hasCheckpointRef: () => Effect.succeed(true),
        restoreCheckpoint: () => Effect.succeed(true),
        diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef, cwd, ignoreWhitespace }) =>
          Effect.sync(() => {
            diffCheckpointsCalls.push({
              fromCheckpointRef,
              toCheckpointRef,
              cwd,
              ignoreWhitespace,
            });
            return "full thread diff patch";
          }),
        deleteCheckpointRefs: () => Effect.void,
      };

      const layer = CheckpointDiffQuery.layer.pipe(
        Layer.provideMerge(Layer.succeed(CheckpointStore.CheckpointStore, checkpointStore)),
        Layer.provideMerge(
          Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
            getUserInputActivity: () => Effect.die("unused"),
            listActivitiesByKind: () => Effect.die("unused"),
            getCommandReadModel: () =>
              Effect.die("CheckpointDiffQuery should not request the command read model"),
            getSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
            getShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
            getDeletedWorktreeThreads: () => Effect.die("unused"),
            getArchivedShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
            getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
            getEventReplayStats: () => Effect.die("unused"),
            getActiveProjectByWorkspaceRoot: () => Effect.succeedNone,
            getProjectShells: () => Effect.die("unused"),
            getProjectShellById: () => Effect.succeedNone,
            getFirstActiveThreadIdByProjectId: () => Effect.succeedNone,
            getImportedAgentSessionSources: () => Effect.die("unused"),
            getThreadCheckpointContext: () =>
              Effect.sync(() => {
                getThreadCheckpointContextCalls += 1;
                return Option.none();
              }),
            getFullThreadDiffContext: () =>
              Effect.sync(() => {
                getFullThreadDiffContextCalls += 1;
                return Option.some({
                  threadId,
                  projectId,
                  workspaceRoot: "/tmp/workspace",
                  worktreePath: "/tmp/worktree",
                  latestCheckpointTurnCount: 4,
                  toCheckpointRef,
                });
              }),
            getThreadRuntimeContext: () => Effect.die("unused"),
            getTurnStartMessage: () => Effect.die("unused"),
            getThreadShellById: () => Effect.succeedNone,
            getThreadDetailById: () => Effect.succeedNone,
            getThreadDetailSnapshot: () => Effect.succeedNone,
            searchThreads: () => Effect.succeed({ matches: [] }),
          }),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        return yield* query.getFullThreadDiff({
          threadId,
          toTurnCount: 4,
          ignoreWhitespace: true,
        });
      }).pipe(Effect.provide(layer));

      expect(getThreadCheckpointContextCalls).toBe(0);
      expect(getFullThreadDiffContextCalls).toBe(1);
      expect(diffCheckpointsCalls).toEqual([
        {
          cwd: "/tmp/worktree",
          fromCheckpointRef: checkpointRefForThreadTurn(threadId, 0),
          toCheckpointRef,
          ignoreWhitespace: true,
        },
      ]);
      expect(result).toEqual({
        threadId,
        fromTurnCount: 0,
        toTurnCount: 4,
        diff: "full thread diff patch",
      });
    }),
  );

  it.effect("computes diffs using canonical turn-0 checkpoint refs", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-1");
      const threadId = ThreadId.make("thread-1");
      const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
      const diffCheckpointsCalls: Array<{
        readonly fromCheckpointRef: CheckpointRef;
        readonly toCheckpointRef: CheckpointRef;
        readonly cwd: string;
        readonly ignoreWhitespace: boolean;
      }> = [];

      const threadCheckpointContext = makeThreadCheckpointContext({
        projectId,
        threadId,
        workspaceRoot: "/tmp/workspace",
        worktreePath: null,
        checkpointTurnCount: 1,
        checkpointRef: toCheckpointRef,
      });

      const checkpointStore: CheckpointStore.CheckpointStore["Service"] = {
        isGitRepository: () => Effect.succeed(true),
        captureCheckpoint: () => Effect.void,
        hasCheckpointRef: () => Effect.succeed(true),
        restoreCheckpoint: () => Effect.succeed(true),
        diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef, cwd, ignoreWhitespace }) =>
          Effect.sync(() => {
            diffCheckpointsCalls.push({
              fromCheckpointRef,
              toCheckpointRef,
              cwd,
              ignoreWhitespace,
            });
            return "diff patch";
          }),
        deleteCheckpointRefs: () => Effect.void,
      };

      const layer = CheckpointDiffQuery.layer.pipe(
        Layer.provideMerge(Layer.succeed(CheckpointStore.CheckpointStore, checkpointStore)),
        Layer.provideMerge(
          Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
            getUserInputActivity: () => Effect.die("unused"),
            listActivitiesByKind: () => Effect.die("unused"),
            getCommandReadModel: () =>
              Effect.die("CheckpointDiffQuery should not request the command read model"),
            getSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
            getShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
            getDeletedWorktreeThreads: () => Effect.die("unused"),
            getArchivedShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
            getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
            getEventReplayStats: () => Effect.die("unused"),
            getActiveProjectByWorkspaceRoot: () => Effect.succeedNone,
            getProjectShells: () => Effect.die("unused"),
            getProjectShellById: () => Effect.succeedNone,
            getFirstActiveThreadIdByProjectId: () => Effect.succeedNone,
            getImportedAgentSessionSources: () => Effect.die("unused"),
            getThreadCheckpointContext: () => Effect.succeedSome(threadCheckpointContext),
            getFullThreadDiffContext: () => Effect.die("unused"),
            getThreadRuntimeContext: () => Effect.die("unused"),
            getTurnStartMessage: () => Effect.die("unused"),
            getThreadShellById: () => Effect.succeedNone,
            getThreadDetailById: () => Effect.succeedNone,
            getThreadDetailSnapshot: () => Effect.succeedNone,
            searchThreads: () => Effect.succeed({ matches: [] }),
          }),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          ignoreWhitespace: true,
        });
      }).pipe(Effect.provide(layer));

      const expectedFromRef = checkpointRefForThreadTurn(threadId, 0);
      expect(diffCheckpointsCalls).toEqual([
        {
          cwd: "/tmp/workspace",
          fromCheckpointRef: expectedFromRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        },
      ]);
      expect(result).toEqual({
        threadId,
        fromTurnCount: 0,
        toTurnCount: 1,
        diff: "diff patch",
      });
    }),
  );

  it.effect("defaults to hide whitespace changes", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-default-whitespace");
      const threadId = ThreadId.make("thread-default-whitespace");
      const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
      const diffCheckpointsCalls: Array<{ readonly ignoreWhitespace: boolean }> = [];

      const threadCheckpointContext = makeThreadCheckpointContext({
        projectId,
        threadId,
        workspaceRoot: "/tmp/workspace",
        worktreePath: null,
        checkpointTurnCount: 1,
        checkpointRef: toCheckpointRef,
      });

      const checkpointStore: CheckpointStore.CheckpointStore["Service"] = {
        isGitRepository: () => Effect.succeed(true),
        captureCheckpoint: () => Effect.void,
        hasCheckpointRef: () => Effect.succeed(true),
        restoreCheckpoint: () => Effect.succeed(true),
        diffCheckpoints: ({ ignoreWhitespace }) =>
          Effect.sync(() => {
            diffCheckpointsCalls.push({ ignoreWhitespace });
            return "diff patch";
          }),
        deleteCheckpointRefs: () => Effect.void,
      };

      const layer = CheckpointDiffQuery.layer.pipe(
        Layer.provideMerge(Layer.succeed(CheckpointStore.CheckpointStore, checkpointStore)),
        Layer.provideMerge(
          Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
            getUserInputActivity: () => Effect.die("unused"),
            listActivitiesByKind: () => Effect.die("unused"),
            getCommandReadModel: () =>
              Effect.die("CheckpointDiffQuery should not request the command read model"),
            getSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
            getShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
            getDeletedWorktreeThreads: () => Effect.die("unused"),
            getArchivedShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
            getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
            getEventReplayStats: () => Effect.die("unused"),
            getActiveProjectByWorkspaceRoot: () => Effect.succeedNone,
            getProjectShells: () => Effect.die("unused"),
            getProjectShellById: () => Effect.succeedNone,
            getFirstActiveThreadIdByProjectId: () => Effect.succeedNone,
            getImportedAgentSessionSources: () => Effect.die("unused"),
            getThreadCheckpointContext: () => Effect.succeedSome(threadCheckpointContext),
            getFullThreadDiffContext: () => Effect.die("unused"),
            getThreadRuntimeContext: () => Effect.die("unused"),
            getTurnStartMessage: () => Effect.die("unused"),
            getThreadShellById: () => Effect.succeedNone,
            getThreadDetailById: () => Effect.succeedNone,
            getThreadDetailSnapshot: () => Effect.succeedNone,
            searchThreads: () => Effect.succeed({ matches: [] }),
          }),
        ),
      );

      yield* Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        });
      }).pipe(Effect.provide(layer));

      expect(diffCheckpointsCalls).toEqual([{ ignoreWhitespace: true }]);
    }),
  );

  it.effect("does not preflight checkpoint refs before diffing", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-no-preflight");
      const threadId = ThreadId.make("thread-no-preflight");
      const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
      let hasCheckpointRefCallCount = 0;

      const threadCheckpointContext = makeThreadCheckpointContext({
        projectId,
        threadId,
        workspaceRoot: "/tmp/workspace",
        worktreePath: null,
        checkpointTurnCount: 1,
        checkpointRef: toCheckpointRef,
      });

      const checkpointStore: CheckpointStore.CheckpointStore["Service"] = {
        isGitRepository: () => Effect.succeed(true),
        captureCheckpoint: () => Effect.void,
        hasCheckpointRef: () =>
          Effect.sync(() => {
            hasCheckpointRefCallCount += 1;
            return true;
          }),
        restoreCheckpoint: () => Effect.succeed(true),
        diffCheckpoints: () => Effect.succeed("diff patch"),
        deleteCheckpointRefs: () => Effect.void,
      };

      const layer = CheckpointDiffQuery.layer.pipe(
        Layer.provideMerge(Layer.succeed(CheckpointStore.CheckpointStore, checkpointStore)),
        Layer.provideMerge(
          Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
            getUserInputActivity: () => Effect.die("unused"),
            listActivitiesByKind: () => Effect.die("unused"),
            getCommandReadModel: () =>
              Effect.die("CheckpointDiffQuery should not request the command read model"),
            getSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
            getShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
            getDeletedWorktreeThreads: () => Effect.die("unused"),
            getArchivedShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
            getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
            getEventReplayStats: () => Effect.die("unused"),
            getActiveProjectByWorkspaceRoot: () => Effect.succeedNone,
            getProjectShells: () => Effect.die("unused"),
            getProjectShellById: () => Effect.succeedNone,
            getFirstActiveThreadIdByProjectId: () => Effect.succeedNone,
            getImportedAgentSessionSources: () => Effect.die("unused"),
            getThreadCheckpointContext: () => Effect.succeedSome(threadCheckpointContext),
            getFullThreadDiffContext: () => Effect.die("unused"),
            getThreadRuntimeContext: () => Effect.die("unused"),
            getTurnStartMessage: () => Effect.die("unused"),
            getThreadShellById: () => Effect.succeedNone,
            getThreadDetailById: () => Effect.succeedNone,
            getThreadDetailSnapshot: () => Effect.succeedNone,
            searchThreads: () => Effect.succeed({ matches: [] }),
          }),
        ),
      );

      yield* Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          ignoreWhitespace: true,
        });
      }).pipe(Effect.provide(layer));

      expect(hasCheckpointRefCallCount).toBe(0);
    }),
  );

  it.effect("fails when the thread is missing from the snapshot", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-missing");

      const checkpointStore: CheckpointStore.CheckpointStore["Service"] = {
        isGitRepository: () => Effect.succeed(true),
        captureCheckpoint: () => Effect.void,
        hasCheckpointRef: () => Effect.succeed(true),
        restoreCheckpoint: () => Effect.succeed(true),
        diffCheckpoints: () => Effect.succeed(""),
        deleteCheckpointRefs: () => Effect.void,
      };

      const layer = CheckpointDiffQuery.layer.pipe(
        Layer.provideMerge(Layer.succeed(CheckpointStore.CheckpointStore, checkpointStore)),
        Layer.provideMerge(
          Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
            getUserInputActivity: () => Effect.die("unused"),
            listActivitiesByKind: () => Effect.die("unused"),
            getCommandReadModel: () =>
              Effect.die("CheckpointDiffQuery should not request the command read model"),
            getSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
            getShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
            getDeletedWorktreeThreads: () => Effect.die("unused"),
            getArchivedShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
            getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
            getEventReplayStats: () => Effect.die("unused"),
            getActiveProjectByWorkspaceRoot: () => Effect.succeedNone,
            getProjectShells: () => Effect.die("unused"),
            getProjectShellById: () => Effect.succeedNone,
            getFirstActiveThreadIdByProjectId: () => Effect.succeedNone,
            getImportedAgentSessionSources: () => Effect.die("unused"),
            getThreadCheckpointContext: () => Effect.succeedNone,
            getFullThreadDiffContext: () => Effect.succeedNone,
            getThreadRuntimeContext: () => Effect.die("unused"),
            getTurnStartMessage: () => Effect.die("unused"),
            getThreadShellById: () => Effect.succeedNone,
            getThreadDetailById: () => Effect.succeedNone,
            getThreadDetailSnapshot: () => Effect.succeedNone,
            searchThreads: () => Effect.succeed({ matches: [] }),
          }),
        ),
      );

      const error = yield* Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        });
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(CheckpointThreadNotFoundError);
      expect(error).toMatchObject({
        operation: "CheckpointDiffQuery.getTurnDiff",
        threadId,
      });
      expect(error.message).toBe(
        "Checkpoint invariant violation in CheckpointDiffQuery.getTurnDiff: Thread 'thread-missing' not found.",
      );
    }),
  );
});

describe("Trellis-only turns", () => {
  const threadId = ThreadId.make("thread-trellis");
  const baselineRef = checkpointRefForThreadTurn(threadId, 0);
  const gitRef = (turn: number) => `refs/t3/checkpoints/x/turn/${turn}`;
  const checkpoint = (turnCount: number, ref: string) => ({
    turnId: TurnId.make(`turn-${turnCount}`),
    checkpointTurnCount: turnCount,
    checkpointRef: CheckpointRef.make(ref),
    status: "ready" as const,
    files: [],
    assistantMessageId: null,
    completedAt: "2026-01-01T00:00:00.000Z",
  });
  const mixed = [
    checkpoint(1, "trellis:snap-1"),
    checkpoint(2, "trellis:snap-2"),
    checkpoint(3, gitRef(3)),
    checkpoint(4, gitRef(4)),
    checkpoint(5, gitRef(5)),
  ];
  const context = {
    threadId,
    projectId: ProjectId.make("p"),
    workspaceRoot: "/trellis/workspaces/ws/project/idea",
    worktreePath: null,
  };
  const timeout = (cwd: string) =>
    new VcsProcessTimeoutError({ operation: "test.diff", command: "git", cwd, timeoutMs: 1 });

  // A store whose turn-0 baseline diff fails; `baselineExists` says whether
  // that is a missing ref or some other failure such as a timeout.
  const makeLayer = (input: {
    readonly checkpoints: ReadonlyArray<ReturnType<typeof checkpoint>>;
    readonly baselineExists: boolean;
    readonly froms: Array<string>;
  }) =>
    CheckpointDiffQuery.layer.pipe(
      Layer.provide(
        Layer.mock(CheckpointStore.CheckpointStore)({
          hasCheckpointRef: ({ checkpointRef }) =>
            Effect.succeed(checkpointRef === baselineRef ? input.baselineExists : true),
          diffCheckpoints: ({ fromCheckpointRef, cwd }) =>
            Effect.suspend(() => {
              input.froms.push(fromCheckpointRef);
              return fromCheckpointRef === baselineRef
                ? Effect.fail(timeout(cwd))
                : Effect.succeed(`patch from ${fromCheckpointRef}`);
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getFullThreadDiffContext: () =>
            Effect.succeed(
              Option.some({
                ...context,
                latestCheckpointTurnCount: 5,
                toCheckpointRef: CheckpointRef.make(gitRef(5)),
              }),
            ),
          getThreadCheckpointContext: () =>
            Effect.succeed(Option.some({ ...context, checkpoints: input.checkpoints })),
        }),
      ),
    );

  const fullThread = (layer: ReturnType<typeof makeLayer>) =>
    Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      return yield* query.getFullThreadDiff({ threadId, toTurnCount: 5 });
    }).pipe(Effect.provide(layer));
  const turnDiff = (
    layer: ReturnType<typeof makeLayer>,
    fromTurnCount: number,
    toTurnCount: number,
  ) =>
    Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      return yield* query.getTurnDiff({ threadId, fromTurnCount, toTurnCount });
    }).pipe(Effect.provide(layer));

  it("finds leading Trellis-only turns and the first git checkpoint of a range", () => {
    expect(CheckpointDiffQuery.startsWithTrellisOnlyTurns(mixed)).toBe(true);
    expect(CheckpointDiffQuery.startsWithTrellisOnlyTurns(mixed.slice(2))).toBe(false);
    expect(CheckpointDiffQuery.firstGitCheckpointBetween(mixed, 1, 5)).toBe(gitRef(3));
    // The first git checkpoint itself has nothing earlier to diff against.
    expect(CheckpointDiffQuery.firstGitCheckpointBetween(mixed, 2, 3)).toBeNull();
  });

  it.effect("diffs a full thread from its first git checkpoint when the baseline is absent", () =>
    Effect.gen(function* () {
      const froms: Array<string> = [];
      const result = yield* fullThread(
        makeLayer({ checkpoints: mixed, baselineExists: false, froms }),
      );
      expect(result.diff).toBe(`patch from ${gitRef(3)}`);
      expect(froms).toEqual([baselineRef, gitRef(3)]);
    }),
  );

  it.effect("diffs a turn-0 range from the first git checkpoint when the baseline is absent", () =>
    Effect.gen(function* () {
      const result = yield* turnDiff(
        makeLayer({ checkpoints: mixed, baselineExists: false, froms: [] }),
        0,
        5,
      );
      expect(result.diff).toBe(`patch from ${gitRef(3)}`);
    }),
  );

  it.effect("keeps a timeout an error when the baseline exists or turns are all git", () =>
    Effect.gen(function* () {
      const present = yield* fullThread(
        makeLayer({ checkpoints: mixed, baselineExists: true, froms: [] }),
      ).pipe(Effect.flip);
      expect(present._tag).toBe("VcsProcessTimeoutError");
      const gitOnly = yield* turnDiff(
        makeLayer({ checkpoints: mixed.slice(2), baselineExists: false, froms: [] }),
        0,
        5,
      ).pipe(Effect.flip);
      expect(gitOnly._tag).toBe("VcsProcessTimeoutError");
    }),
  );

  it.effect("diffs the git part of a range that starts in Trellis-only turns", () =>
    Effect.gen(function* () {
      const froms: Array<string> = [];
      const layer = makeLayer({ checkpoints: mixed, baselineExists: false, froms });
      expect((yield* turnDiff(layer, 1, 5)).diff).toBe(`patch from ${gitRef(3)}`);
      expect((yield* turnDiff(layer, 2, 3)).diff).toBe("");
      expect(froms).toEqual([gitRef(3)]);
    }),
  );
});
