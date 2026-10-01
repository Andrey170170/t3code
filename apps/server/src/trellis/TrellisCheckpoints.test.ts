// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  NodeId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import {
  CheckpointDiffQuery,
  layer as checkpointDiffQueryLayer,
} from "../checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { CheckpointBackendError } from "../checkpointing/Errors.ts";
import {
  CHECKPOINT_EXPIRED_MESSAGE,
  CheckpointRollbackServiceV2,
  layer as checkpointRollbackLayer,
} from "../orchestration-v2/CheckpointRollbackService.ts";
import { CheckpointRestoreRule } from "../orchestration-v2/CheckpointRestoreSafety.ts";
import {
  CheckpointServiceV2,
  checkpointRefForScopeOrdinal,
  layer as checkpointServiceLayer,
} from "../orchestration-v2/CheckpointService.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { layer as idAllocatorLayer } from "../orchestration-v2/IdAllocator.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { RestoreLease } from "../orchestration-v2/RestoreLease.ts";
import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { TurnAdmission } from "../orchestration-v2/TurnAdmission.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { makeTestTrellis, Trellis, type TrellisSnapshot } from "./Trellis.ts";
import * as TrellisCheckpointStore from "./TrellisCheckpointStore.ts";
import * as TrellisRestore from "./TrellisRestore.ts";

/**
 * A Trellis over real directories: `<root>/workspaces/<ws>/project` holds the
 * files, snapshots are copies under `<root>/snapshots/<ws>/<snap>`, and
 * rollbacks copy them back (an idea's folder, or the whole workspace).
 * `ws-s` is scratch with ideas `idea-a` and `idea-b`; `ws-d` is dedicated.
 */
function makeFakeTrellis(root: string) {
  const snapshots: Array<
    { -readonly [K in keyof TrellisSnapshot]: TrellisSnapshot[K] } & { removed?: boolean }
  > = [];
  const calls: Array<string> = [];
  let seq = 0;
  const failures = { create: 0 };
  /** Runs right after a turn snapshot is taken, as a process still writing would. */
  const hooks: { afterCreate?: () => void } = {};
  const workspacePath = (ws: string) => NodePath.join(root, "workspaces", ws, "project");
  for (const path of [
    NodePath.join(workspacePath("ws-s"), "idea-a"),
    NodePath.join(workspacePath("ws-s"), "idea-b"),
    workspacePath("ws-d"),
  ]) {
    NodeFS.mkdirSync(path, { recursive: true });
  }
  const workspaceOf = (target: string) =>
    NodePath.relative(NodePath.join(root, "workspaces"), target).split("/")[0]!;
  const ideaOf = (target: string) => {
    const relative = NodePath.relative(workspacePath("ws-s"), target);
    return workspaceOf(target) === "ws-s" && relative !== "" && !relative.startsWith("..")
      ? relative.split("/")[0]!
      : null;
  };
  const live = (id: string) =>
    snapshots.find((snapshot) => snapshot.id === id && !snapshot.removed);
  const take = (target: string, kind: string, turn: string | null) => {
    const ws = workspaceOf(target);
    const id = `snap-${++seq}`;
    NodeFS.cpSync(NodePath.join(root, "workspaces", ws), NodePath.join(root, "snapshots", ws, id), {
      recursive: true,
    });
    const snapshot = {
      id,
      workspace_id: ws,
      seq,
      kind,
      pinned: false,
      thread: null,
      turn,
      created_at: seq,
    } satisfies TrellisSnapshot;
    snapshots.push(snapshot);
    return snapshot;
  };
  const view = (ws: string) => ({
    id: ws,
    kind: ws === "ws-s" ? "scratch" : "dedicated",
    name: ws,
    path: workspacePath(ws),
    deleted_at: null,
  });
  const trellis = makeTestTrellis({
    env: { root, bin: "trellis", shimDir: "/shims" },
    listSnapshots: (target) =>
      Effect.sync(() =>
        snapshots.filter(
          (snapshot) => !snapshot.removed && snapshot.workspace_id === workspaceOf(target),
        ),
      ),
    createSnapshot: ({ target, turn }) =>
      Effect.suspend(() => {
        calls.push(`create ${turn}`);
        if (failures.create > 0) {
          failures.create -= 1;
          return Effect.fail({ _tag: "TrellisError", message: "Trellis is busy" } as never);
        }
        const snapshot = take(target, "turn", turn);
        hooks.afterCreate?.();
        return Effect.succeed(snapshot);
      }),
    setSnapshotPinned: (id, pinned) =>
      Effect.suspend(() => {
        calls.push(`${pinned ? "pin" : "unpin"} ${id}`);
        const snapshot = live(id);
        if (snapshot === undefined) {
          return Effect.fail({ _tag: "TrellisError", message: `unknown snapshot ${id}` } as never);
        }
        snapshot.pinned = pinned;
        return Effect.succeed(snapshot);
      }),
    resolve: (target) =>
      Effect.sync(() => {
        const ws = workspaceOf(target);
        const idea = ideaOf(target);
        return {
          workspace: view(ws),
          project:
            idea === null
              ? null
              : {
                  id: idea,
                  kind: "idea",
                  name: idea,
                  description: "",
                  workspace_id: ws,
                  path: NodePath.join(workspacePath(ws), idea),
                  updated_at: 0,
                  deleted_at: null,
                  graduated_to: null,
                  workspaces: [view(ws)],
                },
        };
      }),
    rollback: ({ target, snapshot: id }) =>
      Effect.sync(() => {
        calls.push(`rollback ${target} ${id}`);
        const ws = workspaceOf(target);
        const undo = take(target, "pre-rollback", null);
        const idea = ideaOf(target);
        const relative = idea === null ? "project" : NodePath.join("project", idea);
        const destination = NodePath.join(root, "workspaces", ws, relative);
        NodeFS.rmSync(destination, { recursive: true, force: true });
        NodeFS.cpSync(NodePath.join(root, "snapshots", ws, id, relative), destination, {
          recursive: true,
        });
        return { undoSnapshot: undo.id };
      }),
  });
  return {
    trellis,
    snapshots,
    calls,
    failures,
    hooks,
    workspacePath,
    /** Thinning or maintenance removing a snapshot. */
    remove: (id: string) => {
      const snapshot = live(id)!;
      snapshot.removed = true;
      NodeFS.rmSync(NodePath.join(root, "snapshots", snapshot.workspace_id, id), {
        recursive: true,
        force: true,
      });
    },
  };
}

const PlatformLayer = NodeServices.layer;
const gitStoreLayer = CheckpointStore.layer.pipe(
  Layer.provide(
    VcsDriverRegistry.layer.pipe(
      Layer.provide(VcsProcess.layer),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-trellis-checkpoints-" })),
      Layer.provide(PlatformLayer),
    ),
  ),
);

const tempRoot = () =>
  NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-trellis-")));

/** The decorated store and the checkpoint service over it, against `fake`. */
const storeLayer = (fake: ReturnType<typeof makeFakeTrellis>) => {
  const store = TrellisCheckpointStore.layer.pipe(
    Layer.provide(gitStoreLayer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(PlatformLayer),
    Layer.provide(Layer.succeed(Trellis, fake.trellis)),
  );
  return Layer.mergeAll(
    store,
    checkpointServiceLayer.pipe(Layer.provide(idAllocatorLayer), Layer.provide(store)),
  );
};

const scopeAt = (cwd: string, name: string): OrchestrationV2CheckpointScope => ({
  id: CheckpointScopeId.make(`scope-${name}`),
  threadId: ThreadId.make(`thread-${name}`),
  runId: RunId.make(`run-${name}`),
  nodeId: NodeId.make(`node-${name}`),
  parentScopeId: null,
  providerThreadId: ProviderThreadId.make(`provider-thread-${name}`),
  kind: "root_run",
  ordinalWithinParent: 0,
  advancesAppRunCount: true,
  cwd,
  createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
});

const refOf = (scope: OrchestrationV2CheckpointScope, ordinal: number) =>
  checkpointRefForScopeOrdinal({ scopeId: scope.id, ordinalWithinScope: ordinal });

/** A run's checkpoint through V2's service: the baseline before it, the capture after. */
const runTurn = (scope: OrchestrationV2CheckpointScope, ordinal: number, edit: () => void) =>
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointServiceV2;
    // Run execution logs a failed baseline and runs the turn anyway.
    yield* checkpoints
      .captureBaseline({ scope, ordinalWithinScope: ordinal - 1 })
      .pipe(Effect.catchTag("CheckpointBaselineCaptureError", () => Effect.void));
    edit();
    return yield* checkpoints.capture({
      scope,
      runId: RunId.make(`run-${ordinal}`),
      nodeId: NodeId.make(`node-${ordinal}`),
      ordinalWithinScope: ordinal,
      appRunOrdinal: ordinal,
      capturedAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
    });
  });

it.effect("a turn captures a tagged snapshot and the baseline once, pinned", () => {
  const fake = makeFakeTrellis(tempRoot());
  const idea = NodePath.join(fake.workspacePath("ws-s"), "idea-a");
  const scope = scopeAt(idea, "tagged");
  return Effect.gen(function* () {
    const first = yield* runTurn(scope, 1, () => NodeFS.writeFileSync(`${idea}/a.txt`, "one\n"));
    const second = yield* runTurn(scope, 2, () => NodeFS.writeFileSync(`${idea}/a.txt`, "two\n"));
    assert.equal(first.status, "ready");
    assert.equal(second.status, "ready");
    // One snapshot per ref, tagged with it; only the baseline is pinned.
    assert.deepEqual(
      fake.snapshots.map((snapshot) => [snapshot.turn, snapshot.pinned]),
      [
        [refOf(scope, 0), true],
        [refOf(scope, 1), false],
        [refOf(scope, 2), false],
      ],
    );
    // The non-git idea's files come from the snapshot pair.
    assert.deepEqual(
      first.files.map((file) => file.path),
      ["a.txt"],
    );
    assert.deepEqual(
      second.files.map((file) => [file.path, file.additions, file.deletions]),
      [["a.txt", 1, 1]],
    );
  }).pipe(Effect.provide(storeLayer(fake)));
});

it.effect("a thinned snapshot is still captured and never recaptured from newer files", () => {
  const fake = makeFakeTrellis(tempRoot());
  const idea = NodePath.join(fake.workspacePath("ws-s"), "idea-a");
  const scope = scopeAt(idea, "thinned");
  return Effect.gen(function* () {
    const store = yield* CheckpointStore.CheckpointStore;
    yield* runTurn(scope, 1, () => NodeFS.writeFileSync(`${idea}/a.txt`, "one\n"));
    fake.remove(fake.snapshots.find((snapshot) => snapshot.turn === refOf(scope, 1))!.id);
    assert.isTrue(yield* store.hasCheckpointRef({ cwd: idea, checkpointRef: refOf(scope, 1) }));
    const before = fake.snapshots.length;
    // Run 2's baseline is run 1's boundary, which stays established.
    yield* (yield* CheckpointServiceV2).captureBaseline({ scope, ordinalWithinScope: 1 });
    assert.equal(fake.snapshots.length, before);
  }).pipe(Effect.provide(storeLayer(fake)));
});

it.effect("a snapshot that cannot be taken is not a ready checkpoint", () => {
  const fake = makeFakeTrellis(tempRoot());
  const idea = NodePath.join(fake.workspacePath("ws-s"), "idea-a");
  const scope = scopeAt(idea, "failing");
  return Effect.gen(function* () {
    const checkpoints = yield* CheckpointServiceV2;
    // Every try fails (the first and two retries) for the baseline, then the turn.
    fake.failures.create = 6;
    const running = yield* Effect.forkChild(
      runTurn(scope, 1, () => NodeFS.writeFileSync(`${idea}/a.txt`, "one\n")),
    );
    // The retries wait a second each.
    while (running.pollUnsafe() === undefined) yield* TestClock.adjust("1 second");
    const turn = yield* Fiber.join(running);
    const baseline = yield* checkpoints.materializeBaselineCheckpoint({
      scope,
      ordinalWithinScope: 0,
    });
    assert.equal(baseline.status, "missing");
    assert.equal(turn.status, "error");
    assert.lengthOf(fake.snapshots, 0);
  }).pipe(Effect.provide(storeLayer(fake)));
});

it.effect("an interrupted capture adopts the snapshot it took, but never a retired one", () => {
  const fake = makeFakeTrellis(tempRoot());
  const idea = NodePath.join(fake.workspacePath("ws-s"), "idea-a");
  const scope = scopeAt(idea, "reconciled");
  return Effect.gen(function* () {
    const store = yield* CheckpointStore.CheckpointStore;
    const baselineRef = refOf(scope, 0);
    // Trellis took the snapshot, then T3 stopped before mapping (or pinning) it.
    yield* fake.trellis.createSnapshot({ target: idea, turn: baselineRef });
    yield* store.captureCheckpoint({ cwd: idea, checkpointRef: baselineRef });
    assert.lengthOf(fake.snapshots, 1);
    assert.isTrue(fake.snapshots[0]!.pinned);
    assert.isTrue(yield* store.hasCheckpointRef({ cwd: idea, checkpointRef: baselineRef }));

    // A rollback past a ref retires its snapshot: capturing the ref again
    // (the next run's baseline) takes the current files, not the old tag.
    const ref = refOf(scope, 1);
    yield* store.captureCheckpoint({ cwd: idea, checkpointRef: ref });
    const old = fake.snapshots.at(-1)!.id;
    yield* store.deleteCheckpointRefs({ cwd: idea, checkpointRefs: [ref] });
    assert.isFalse(yield* store.hasCheckpointRef({ cwd: idea, checkpointRef: ref }));
    yield* store.captureCheckpoint({ cwd: idea, checkpointRef: ref });
    assert.notEqual(fake.snapshots.at(-1)!.id, old);
    assert.lengthOf(fake.snapshots, 3);
  }).pipe(Effect.provide(storeLayer(fake)));
});

const diffLayer = (
  fake: ReturnType<typeof makeFakeTrellis>,
  scope: OrchestrationV2CheckpointScope,
) =>
  checkpointDiffQueryLayer.pipe(
    Layer.provideMerge(storeLayer(fake)),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getCheckpointContext: () =>
          Effect.succeed({
            runs: [
              { id: RunId.make("run-1"), ordinal: 1, status: "completed" },
              { id: RunId.make("run-2"), ordinal: 2, status: "completed" },
            ],
            checkpointScopes: [
              { id: scope.id, runId: scope.runId, kind: "root_run", cwd: scope.cwd },
            ],
            checkpoints: [1, 2].map((ordinal) => ({
              scopeId: scope.id,
              runId: RunId.make(`run-${ordinal}`),
              appRunOrdinal: ordinal,
              status: "ready" as const,
              ref: refOf(scope, ordinal),
            })),
          }),
      }),
    ),
  );

it.effect(
  "a non-git idea's diff lists the changed files, holding both snapshots while it reads",
  () => {
    const fake = makeFakeTrellis(tempRoot());
    const idea = NodePath.join(fake.workspacePath("ws-s"), "idea-a");
    const scope = scopeAt(idea, "diff");
    return Effect.gen(function* () {
      NodeFS.writeFileSync(`${idea}/kept.txt`, "same\n");
      NodeFS.writeFileSync(`${idea}/gone.txt`, "bye\n");
      yield* runTurn(scope, 1, () => NodeFS.writeFileSync(`${idea}/a.txt`, "one\n"));
      yield* runTurn(scope, 2, () => {
        NodeFS.writeFileSync(`${idea}/a.txt`, "two\n");
        NodeFS.writeFileSync(`${idea}/new.txt`, "new\n");
        NodeFS.rmSync(`${idea}/gone.txt`);
      });
      // Another idea's work in the same scratch snapshot is not this diff.
      NodeFS.writeFileSync(`${fake.workspacePath("ws-s")}/idea-b/other.txt`, "x\n");
      fake.calls.length = 0;
      const diff = yield* (yield* CheckpointDiffQuery).getTurnDiff({
        threadId: scope.threadId,
        fromTurnCount: 1,
        toTurnCount: 2,
      });
      assert.include(diff.diff, "diff --git a/a.txt b/a.txt");
      assert.include(diff.diff, "+++ b/new.txt");
      assert.include(diff.diff, "--- a/gone.txt");
      assert.notInclude(diff.diff, "kept.txt");
      assert.notInclude(diff.diff, "other.txt");
      // Pinned for the read and unpinned after: maintenance cannot remove them meanwhile.
      const [from, to] = [1, 2].map(
        (ordinal) => fake.snapshots.find((snapshot) => snapshot.turn === refOf(scope, ordinal))!.id,
      );
      assert.deepEqual(fake.calls.slice(0, 2), [`pin ${from}`, `pin ${to}`]);
      assert.sameMembers(fake.calls.slice(2), [`unpin ${from}`, `unpin ${to}`]);

      // A removed endpoint is an unavailable checkpoint, not an empty diff.
      fake.remove(from!);
      const error = yield* (yield* CheckpointDiffQuery)
        .getTurnDiff({ threadId: scope.threadId, fromTurnCount: 1, toTurnCount: 2 })
        .pipe(Effect.flip);
      assert.equal(error._tag, "CheckpointRefUnavailableError");
      assert.include(error.message, "turn 1");
    }).pipe(Effect.provide(diffLayer(fake, scope)));
  },
);

const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

it.effect("a git project diffs through refs built from the snapshot, not the live files", () => {
  const fake = makeFakeTrellis(tempRoot());
  const project = fake.workspacePath("ws-d");
  git(project, "init", "-q");
  git(project, "config", "user.email", "t@example.com");
  git(project, "config", "user.name", "T");
  NodeFS.writeFileSync(`${project}/.gitignore`, "build/\n");
  NodeFS.writeFileSync(`${project}/main.py`, "print(1)\n");
  git(project, "add", ".");
  git(project, "commit", "-qm", "init");
  const scope = scopeAt(project, "git");
  return Effect.gen(function* () {
    yield* runTurn(scope, 1, () => {
      NodeFS.writeFileSync(`${project}/main.py`, "print(2)\n");
      NodeFS.mkdirSync(`${project}/build`);
      NodeFS.writeFileSync(`${project}/build/out.bin`, "ignored\n");
    });
    // A process still writing after the snapshot: the ref holds the snapshot.
    fake.hooks.afterCreate = () => NodeFS.writeFileSync(`${project}/main.py`, "print(4)\n");
    const capture = yield* runTurn(scope, 2, () => {
      NodeFS.writeFileSync(`${project}/main.py`, "print(3)\n");
    });
    assert.equal(git(project, "show", `${refOf(scope, 2)}:main.py`), "print(3)");
    assert.deepEqual(
      capture.files.map((file) => file.path),
      ["main.py"],
    );
    const diff = yield* (yield* CheckpointDiffQuery).getTurnDiff({
      threadId: scope.threadId,
      fromTurnCount: 1,
      toTurnCount: 2,
    });
    assert.include(diff.diff, "-print(2)\n+print(3)");
    assert.notInclude(diff.diff, "build/");
  }).pipe(Effect.provide(diffLayer(fake, scope)));
});

// ---- rollback

const threadId = ThreadId.make("thread-main");
const otherThreadId = ThreadId.make("thread-other");
const providerThreadId = ProviderThreadId.make("provider-thread-main");
const providerSessionId = ProviderSessionId.make("provider-session-main");
const instanceId = ProviderInstanceId.make("codex");

interface RollbackFixture {
  readonly scope: OrchestrationV2CheckpointScope;
  /** Another thread with one run in `cwd`. */
  readonly other?: {
    readonly cwd: string;
    readonly runStatus: OrchestrationV2ThreadProjection["runs"][number]["status"];
    readonly completedAt?: string;
  };
  readonly sessions?: ReadonlyArray<{ readonly id: string; readonly cwd: string }>;
  /** Runs inside the file restore, before Trellis rolls back. */
  readonly beforeRestore?: () => Effect.Effect<void, CheckpointBackendError>;
}

/**
 * The rollback service over the Trellis store and restore seams, with V2's
 * projections, events and sessions faked. Runs follow the events it writes.
 * The layer also exposes the store (to capture checkpoints) and the seams.
 */
function rollbackHarness(fake: ReturnType<typeof makeFakeTrellis>, fixture: RollbackFixture) {
  const log: Array<string> = [];
  const released: Array<string> = [];
  const events: Array<OrchestrationV2DomainEvent> = [];
  const runs = [
    {
      id: RunId.make("run-1"),
      ordinal: 1,
      status: "completed",
      rootNodeId: null,
      activeAttemptId: null,
      providerInstanceId: instanceId,
      completedAt: DateTime.makeUnsafe("2026-10-01T00:01:00.000Z"),
    },
  ];
  const checkpoint = {
    id: CheckpointId.make("checkpoint-baseline"),
    threadId,
    scopeId: fixture.scope.id,
    runId: null,
    nodeId: fixture.scope.nodeId,
    parentCheckpointId: null,
    ordinalWithinScope: 0,
    appRunOrdinal: null,
    ref: refOf(fixture.scope, 0),
    status: "ready",
    files: [],
    capturedAt: fixture.scope.createdAt,
  } satisfies OrchestrationV2Checkpoint;
  const projection = {
    thread: {
      id: threadId,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId, model: "gpt" },
    },
    providerThreads: [
      { id: providerThreadId, providerSessionId, providerInstanceId: instanceId, driver: "codex" },
    ],
    providerSessions: (fixture.sessions ?? []).map((session) => ({
      id: ProviderSessionId.make(session.id),
      cwd: session.cwd,
      status: "ready",
    })),
    providerTurns: [],
    nodes: [],
    attempts: [],
    checkpoints: [checkpoint],
    checkpointScopes: [fixture.scope],
    runs,
  } as unknown as OrchestrationV2ThreadProjection;
  const other = fixture.other;
  const otherRecords = {
    thread: { id: otherThreadId },
    runs:
      other === undefined
        ? []
        : [
            {
              status: other.runStatus,
              completedAt:
                other.completedAt === undefined ? null : DateTime.makeUnsafe(other.completedAt),
            },
          ],
    checkpointScopes: other === undefined ? [] : [{ cwd: other.cwd }],
    providerSessions: [],
  };
  const shell = (id: ThreadId, title: string) =>
    ({ id, title, deletedAt: null, worktreePath: null, projectId: "p" }) as never;
  const trellisLayer = Layer.succeed(Trellis, fake.trellis);
  const seams = TrellisRestore.layer.pipe(
    Layer.provide(Layer.mock(ProjectStoreV2)({ get: () => Effect.succeed(Option.none()) })),
    Layer.provide(TrellisRestore.gateLayer),
    Layer.provide(trellisLayer),
  );
  const store = TrellisCheckpointStore.layer.pipe(
    Layer.provide(gitStoreLayer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(PlatformLayer),
    Layer.provide(trellisLayer),
  );
  const observedStore = Layer.effect(
    CheckpointStore.CheckpointStore,
    Effect.gen(function* () {
      const base = yield* CheckpointStore.CheckpointStore;
      return CheckpointStore.CheckpointStore.of({
        ...base,
        restoreCheckpoint: (input) =>
          Effect.gen(function* () {
            log.push("files");
            if (fixture.beforeRestore !== undefined) yield* fixture.beforeRestore();
            return yield* base.restoreCheckpoint(input);
          }),
      });
    }),
  ).pipe(Layer.provide(store));
  const service = checkpointRollbackLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        checkpointServiceLayer.pipe(Layer.provide(idAllocatorLayer), Layer.provide(observedStore)),
        Layer.mock(EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              events.push(...input.events);
              for (const event of input.events) {
                if (event.type !== "run.updated") continue;
                const run = runs.find((candidate) => candidate.id === event.payload.id);
                if (run !== undefined) run.status = event.payload.status;
              }
              return [];
            }),
        }),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: (id: ThreadId) =>
            Effect.succeed((id === threadId ? projection : otherRecords) as never),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [
                shell(threadId, "Main"),
                ...(other === undefined ? [] : [shell(otherThreadId, "Other")]),
              ],
              archivedThreads: [],
            }),
          getNextTurnItemOrdinal: () => Effect.succeed(10),
        }),
        Layer.mock(ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              rollbackThread: (input: { readonly providerThread: unknown }) =>
                Effect.sync(() => {
                  log.push("rewind");
                  return { providerThread: input.providerThread };
                }),
            } as never),
          release: (input) =>
            Effect.sync(() => {
              log.push(`release ${input.providerSessionId}`);
              released.push(input.providerSessionId);
            }),
        }),
        Layer.mock(RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
      ),
    ),
    Layer.provide(seams),
    Layer.provide(PlatformLayer),
  );
  const execute = (acknowledgeThreads?: ReadonlyArray<ThreadId>) =>
    Effect.flatMap(CheckpointRollbackServiceV2, (rollback) =>
      rollback.execute({
        threadId,
        providerThreadId,
        checkpointId: checkpoint.id,
        scopeId: fixture.scope.id,
        ...(acknowledgeThreads === undefined ? {} : { acknowledgeThreads }),
      }),
    );
  /** Captures the checkpoint the rollback targets. */
  const captureBaseline = Effect.flatMap(CheckpointStore.CheckpointStore, (checkpointStore) =>
    checkpointStore.captureCheckpoint({ cwd: fixture.scope.cwd, checkpointRef: checkpoint.ref }),
  );
  return {
    layer: Layer.mergeAll(service, store, seams),
    log,
    released,
    events,
    execute,
    captureBaseline,
    runs,
  };
}

const ideaScope = (fake: ReturnType<typeof makeFakeTrellis>, idea = "idea-a") => ({
  ...scopeAt(NodePath.join(fake.workspacePath("ws-s"), idea), `scope-${idea}`),
  threadId,
});

it.effect(
  "reverting a dedicated workspace releases its sessions and rolls back to its snapshot",
  () => {
    const fake = makeFakeTrellis(tempRoot());
    const project = fake.workspacePath("ws-d");
    const idea = NodePath.join(fake.workspacePath("ws-s"), "idea-a");
    NodeFS.writeFileSync(`${project}/notes.md`, "before\n");
    const harness = rollbackHarness(fake, {
      scope: { ...scopeAt(project, "dedicated"), threadId },
      sessions: [
        { id: "session-here", cwd: project },
        { id: "session-elsewhere", cwd: idea },
      ],
    });
    return Effect.gen(function* () {
      yield* harness.captureBaseline;
      const snapshot = fake.snapshots.at(-1)!.id;
      NodeFS.writeFileSync(`${project}/notes.md`, "after\n");
      yield* harness.execute();
      assert.deepEqual(harness.log, ["rewind", "release session-here", "files"]);
      assert.include(fake.calls, `rollback ${project} ${snapshot}`);
      assert.equal(NodeFS.readFileSync(`${project}/notes.md`, "utf8"), "before\n");
      const notice = harness.events.find((event) => event.type === "turn-item.updated");
      assert.include(
        notice?.type === "turn-item.updated" && notice.payload.type === "system_notice"
          ? notice.payload.message
          : "",
        "trellis rollback",
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("reverting an idea restores only its folder and keeps the sessions", () => {
  const fake = makeFakeTrellis(tempRoot());
  const scope = ideaScope(fake);
  const other = NodePath.join(fake.workspacePath("ws-s"), "idea-b");
  const harness = rollbackHarness(fake, {
    scope,
    sessions: [{ id: "codex-scratch", cwd: scope.cwd }],
  });
  return Effect.gen(function* () {
    yield* harness.captureBaseline;
    NodeFS.writeFileSync(`${scope.cwd}/a.txt`, "turn\n");
    NodeFS.writeFileSync(`${other}/b.txt`, "other idea\n");
    yield* harness.execute();
    assert.deepEqual(harness.log, ["rewind", "files"]);
    assert.deepEqual(harness.released, []);
    assert.isFalse(NodeFS.existsSync(`${scope.cwd}/a.txt`));
    assert.isTrue(NodeFS.existsSync(`${other}/b.txt`));
  }).pipe(Effect.provide(harness.layer));
});

it.effect("reverting to an expired checkpoint fails before the rewind and marks it missing", () => {
  const fake = makeFakeTrellis(tempRoot());
  const harness = rollbackHarness(fake, { scope: ideaScope(fake) });
  return Effect.gen(function* () {
    yield* harness.captureBaseline;
    fake.remove(fake.snapshots.at(-1)!.id);
    const error = yield* Effect.flip(harness.execute());
    assert.equal(error.reason, "rollback-target-invalid");
    assert.equal(error.detail, CHECKPOINT_EXPIRED_MESSAGE);
    assert.deepEqual(harness.log, []);
    assert.deepEqual(
      harness.events.map((event) =>
        event.type === "checkpoint.captured" ? event.payload.status : event.type,
      ),
      ["missing"],
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a retried revert never rewinds the conversation twice", () => {
  const fake = makeFakeTrellis(tempRoot());
  let failures = 1;
  const harness = rollbackHarness(fake, {
    scope: ideaScope(fake),
    beforeRestore: () =>
      failures-- > 0
        ? Effect.fail(new CheckpointBackendError({ operation: "restore", detail: "busy" }))
        : Effect.void,
  });
  return Effect.gen(function* () {
    yield* harness.captureBaseline;
    yield* Effect.flip(harness.execute());
    yield* harness.execute();
    assert.deepEqual(harness.log, ["rewind", "files", "files"]);
    assert.equal(harness.runs[0]!.status, "rolled_back");
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each([
  { status: "completed" },
  { status: "interrupted" },
  { status: "cancelled" },
  { status: "failed" },
] as const)(
  "a revert undoing another thread's later $status run needs acknowledging",
  ({ status }) => {
    const fake = makeFakeTrellis(tempRoot());
    const scope = ideaScope(fake);
    const harness = rollbackHarness(fake, {
      scope,
      other: { cwd: scope.cwd, runStatus: status, completedAt: "2026-10-01T00:05:00.000Z" },
    });
    return Effect.gen(function* () {
      yield* harness.captureBaseline;
      const refused = yield* Effect.flip(harness.execute());
      assert.equal(refused.reason, "shared-workspace");
      assert.include(refused.message, '"Other"');
      assert.include(refused.message, "later work");
      assert.deepEqual(harness.log, []);
      yield* harness.execute([otherThreadId]);
      assert.deepEqual(harness.log, ["rewind", "files"]);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("a revert is refused while another thread runs in the same idea, not in another", () =>
  Effect.gen(function* () {
    const fake = makeFakeTrellis(tempRoot());
    const scope = ideaScope(fake);
    const same = rollbackHarness(fake, {
      scope,
      other: { cwd: `${scope.cwd}/sub`, runStatus: "running" },
    });
    yield* Effect.gen(function* () {
      yield* same.captureBaseline;
      const refused = yield* Effect.flip(same.execute([otherThreadId]));
      assert.equal(refused.reason, "shared-workspace");
      assert.include(refused.message, '"Other" is still working');
      assert.deepEqual(same.log, []);
    }).pipe(Effect.provide(same.layer));

    const elsewhere = rollbackHarness(fake, {
      scope,
      other: {
        cwd: NodePath.join(fake.workspacePath("ws-s"), "idea-b"),
        runStatus: "running",
      },
    });
    yield* Effect.gen(function* () {
      yield* elsewhere.captureBaseline;
      yield* elsewhere.execute();
      assert.deepEqual(elsewhere.log, ["rewind", "files"]);
    }).pipe(Effect.provide(elsewhere.layer));
  }),
);

it.effect("a run admitted during a restore starts after it", () => {
  const fake = makeFakeTrellis(tempRoot());
  const scope = ideaScope(fake);
  const restoring = Deferred.makeUnsafe<void>();
  const proceed = Deferred.makeUnsafe<void>();
  const harness = rollbackHarness(fake, {
    scope,
    beforeRestore: () =>
      Deferred.succeed(restoring, undefined).pipe(Effect.andThen(Deferred.await(proceed))),
  });
  return Effect.gen(function* () {
    const admission = yield* TurnAdmission;
    yield* harness.captureBaseline;
    const rollback = yield* Effect.forkChild(harness.execute());
    yield* Deferred.await(restoring);
    const inScope = yield* Effect.forkChild(
      admission.start({
        threadId: otherThreadId,
        runId: RunId.make("run-x"),
        cwd: `${scope.cwd}/sub`,
      }),
    );
    // Another idea is not held back.
    const elsewhere = yield* admission.start({
      threadId: otherThreadId,
      runId: RunId.make("run-y"),
      cwd: NodePath.join(fake.workspacePath("ws-s"), "idea-b"),
    });
    assert.isFalse(elsewhere);
    yield* Effect.yieldNow;
    assert.isUndefined(inScope.pollUnsafe());
    yield* Deferred.succeed(proceed, undefined);
    yield* Fiber.join(rollback);
    assert.isTrue(yield* Fiber.join(inScope));
  }).pipe(Effect.provide(harness.layer));
});

it.effect("outside Trellis the seams are V2's: the cwd lease and the isolated-worktree rule", () =>
  Effect.gen(function* () {
    const admission = yield* TurnAdmission;
    const lease = yield* RestoreLease;
    const rule = yield* CheckpointRestoreRule;
    const scope = scopeAt(process.cwd(), "host");
    yield* Effect.scoped(lease.acquire(scope));
    assert.isFalse(
      yield* admission.start({ threadId, runId: RunId.make("run-host"), cwd: process.cwd() }),
    );
    assert.isNotNull(
      yield* rule.check(
        {
          thread: { id: threadId, worktreePath: null },
          scope,
          checkpoint: { capturedAt: scope.createdAt } as OrchestrationV2Checkpoint,
          acknowledgeThreads: [],
        },
        {
          fileSystem: yield* FileSystem.FileSystem,
          projections: ProjectionStoreV2.of({} as never),
        },
      ),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        TrellisRestore.layer.pipe(
          Layer.provide(Layer.mock(ProjectStoreV2)({})),
          Layer.provide(TrellisRestore.gateLayer),
          Layer.provide(Layer.succeed(Trellis, makeFakeTrellis(tempRoot()).trellis)),
        ),
        PlatformLayer,
      ),
    ),
  ),
);
