import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import {
  CheckpointRollbackServiceV2,
  layer as checkpointRollbackLayer,
} from "./CheckpointRollbackService.ts";
import { layer as checkpointServiceLayer } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RestoreLease } from "./RestoreLease.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

const threadId = ThreadId.make("thread-restore-lease");
const providerThreadId = ProviderThreadId.make("provider-thread-restore-lease");
const checkpointId = CheckpointId.make("checkpoint-restore-lease");
const scopeId = CheckpointScopeId.make("checkpoint-scope-restore-lease");
const instanceId = ProviderInstanceId.make("restore-lease-instance");
const providerThread = {
  id: providerThreadId,
  providerSessionId: ProviderSessionId.make("provider-session-restore-lease"),
  providerInstanceId: instanceId,
};
const projection = {
  thread: {
    worktreePath: process.cwd(),
    activeProviderThreadId: providerThreadId,
    modelSelection: { instanceId, model: "test" },
  },
  providerThreads: [providerThread],
  providerSessions: [],
  providerTurns: [],
  nodes: [],
  attempts: [],
  checkpoints: [
    {
      id: checkpointId,
      scopeId,
      status: "ready",
      appRunOrdinal: null,
      ref: CheckpointRef.make("refs/t3/restore-lease"),
    },
  ],
  checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
  runs: [],
} as unknown as OrchestrationV2ThreadProjection;

/** A rollback through the real checkpoint service, which takes its per-cwd lock to restore. */
const rollbackLayer = (calls: Array<string>) =>
  checkpointRollbackLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        checkpointServiceLayer.pipe(
          Layer.provide(idAllocatorLayer),
          Layer.provide(
            Layer.mock(CheckpointStore.CheckpointStore)({
              reserve: () => Effect.succeed({ endsSessionsIn: null }),
              restoreCheckpoint: () =>
                Effect.sync(() => {
                  calls.push("restore");
                  return { restored: true };
                }),
            }),
          ),
        ),
        Layer.mock(EventSinkV2)({ write: () => Effect.succeed([]) }),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
          getCheckpointContext: () =>
            Effect.succeed({
              checkpointScopes: [{ cwd: process.cwd() }],
              runs: [],
              checkpoints: [],
            } as never),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            }),
        }),
        Layer.mock(ProviderSessionManagerV2)({ open: () => Effect.succeed({} as never) }),
        Layer.mock(RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

const rollback = CheckpointRollbackServiceV2.use((service) =>
  service.execute({ threadId, providerThreadId, checkpointId, scopeId }),
);

it.effect("completes a plain git rollback beneath the default restore lease", () =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    yield* rollback.pipe(Effect.provide(rollbackLayer(calls)));
    // Twice: the lease is released when a rollback ends.
    yield* rollback.pipe(Effect.provide(rollbackLayer(calls)));
    assert.deepEqual(calls, ["restore", "restore"]);
  }),
);

it.effect("holds the restore lease through the file restore", () =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const lease = RestoreLease.of({
      acquire: (scope) =>
        Effect.acquireRelease(
          Effect.sync(() => calls.push(`acquire ${scope.id}`)),
          () => Effect.sync(() => calls.push("release")),
        ).pipe(Effect.asVoid),
    });
    yield* rollback.pipe(
      Effect.provide(rollbackLayer(calls)),
      Effect.provideService(RestoreLease, lease),
    );
    assert.deepEqual(calls, [`acquire ${scopeId}`, "restore", "release"]);
  }),
);

it.effect("lets a rollback waiting for the default lease be interrupted", () =>
  Effect.gen(function* () {
    const lease = yield* RestoreLease;
    const scope = projection.checkpointScopes[0]!;
    const held = yield* Deferred.make<void>();
    const holder = yield* Effect.scoped(
      lease
        .acquire(scope)
        .pipe(Effect.andThen(Deferred.succeed(held, undefined)), Effect.andThen(Effect.never)),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(held);
    const waiter = yield* Effect.scoped(lease.acquire(scope)).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(waiter);
    yield* Fiber.interrupt(holder);
    // Both released: the gate is free again.
    yield* Effect.scoped(lease.acquire(scope));
  }),
);
