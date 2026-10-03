import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "./IdAllocator.ts";

it.effect.each([false, true, "interrupt"] as const)(
  "materializes baseline, lookup fails=%s",
  (lookupFails) => {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:materialize-baseline"),
      threadId: ThreadId.make("thread:materialize-baseline"),
      runId: RunId.make("run:materialize-baseline:3"),
      nodeId: NodeId.make("node:materialize-baseline:3"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:materialize-baseline"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const hasCheckpointRef = vi.fn((_input: CheckpointStore.RestoreCheckpointInput) =>
      lookupFails === "interrupt"
        ? Effect.interrupt
        : lookupFails
          ? Effect.fail(
              new VcsProcessTimeoutError({
                operation: "test.ref",
                command: "git",
                cwd: "/repo",
                timeoutMs: 30000,
              }),
            )
          : Effect.succeed(true),
    );
    const testLayer = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            isCheckpointable: () => Effect.succeed(true),
            hasCheckpointRef,
            captureCheckpoint: () => Effect.void,
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      if (lookupFails === "interrupt") {
        const exit = yield* Effect.exit(
          checkpoints.materializeBaselineCheckpoint({ scope, ordinalWithinScope: 2 }),
        );
        assert.isTrue(Exit.hasInterrupts(exit));
        const captureExit = yield* Effect.exit(
          checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          }),
        );
        assert.isTrue(Exit.hasInterrupts(captureExit));
        return;
      }
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 2,
      });

      assert.equal(baseline.ordinalWithinScope, 2);
      assert.equal(
        baseline.ref,
        CheckpointService.checkpointRefForScopeOrdinal({
          scopeId: scope.id,
          ordinalWithinScope: 2,
        }),
      );
      assert.equal(baseline.status, lookupFails ? "missing" : "ready");
      assert.deepEqual(hasCheckpointRef.mock.calls[0]?.[0], {
        cwd: scope.cwd,
        checkpointRef: baseline.ref,
      });
    }).pipe(Effect.provide(testLayer));
  },
);

it("restores files of a turn before a move only from the project the thread is in now", () => {
  const scope = (id: string, assignment?: number) => ({
    id: CheckpointScopeId.make(id),
    kind: "root_run" as const,
    parentScopeId: null,
    ...(assignment === undefined ? {} : { workspaceAssignment: assignment }),
  });
  const checkpoint = (scopeId: string, ordinal: number, appRunOrdinal: number | null) => ({
    scopeId: CheckpointScopeId.make(scopeId),
    status: "ready" as const,
    ordinalWithinScope: ordinal,
    appRunOrdinal,
  });
  // Runs 1 and 2 in the idea; the thread moved and ran turn 3 in the project.
  const idea = scope("idea");
  const project = scope("project", 1);
  const scopes = [idea, project];
  const checkpoints = [
    checkpoint("idea", 0, null),
    checkpoint("idea", 1, 1),
    checkpoint("idea", 2, 2),
    checkpoint("project", 2, null),
    checkpoint("project", 3, 3),
  ];
  const targetOf = (index: number, thread = { workspaceAssignment: 1 }) =>
    CheckpointService.fileRestoreTargetOf({
      thread,
      checkpoint: checkpoints[index]!,
      scope: checkpoints[index]!.scopeId === idea.id ? idea : project,
      checkpoints,
      scopes,
    });
  // Undoing turn 3 restores the state the thread arrived with, from the project.
  assert.deepEqual(targetOf(2), { checkpoint: checkpoints[3], scope: project });
  // Earlier states are in the idea's folder: across the boundary.
  assert.isNull(targetOf(1));
  assert.isNull(targetOf(0));
  assert.deepEqual(targetOf(4), { checkpoint: checkpoints[4], scope: project });
  // Before the move, the idea's own checkpoints restore as always.
  assert.deepEqual(targetOf(1, { workspaceAssignment: 0 }), {
    checkpoint: checkpoints[1],
    scope: idea,
  });
});
