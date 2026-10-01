import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  ContextTransferId,
  EventId,
  NodeId,
  ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { IdAllocatorV2 } from "../orchestration-v2/IdAllocator.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionMaintenanceV2 } from "../orchestration-v2/ProjectionMaintenance.ts";
import {
  attachSession,
  createProject,
  createThread,
  modelSelection,
  move,
  rejection,
  sendMessage,
  sessionIdOf,
  TrellisOrchestratorTestLayer,
  writeEvent,
} from "./TrellisOrchestrator.testkit.ts";

// `thread.project.move`: its guards, its event (live, replayed, rebuilt and
// compacted), the detach, and the moved thread's first turn opening in the
// new project's workspace.

it.layer(TrellisOrchestratorTestLayer)("thread.project.move", (it) => {
  it.effect(
    "moves a thread without history, detaches its session, and runs it in the new workspace",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const ids = yield* IdAllocatorV2;
        const { threadId, projectId: from } = yield* createThread(
          "move-ok",
          "/trellis/workspaces/ws-a/project/idea-1",
        );
        const to = yield* createProject("move-ok-target", "/trellis/workspaces/ws-b/project");
        const sessionA = ids.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
          sessionKey: "ws-a",
        });
        yield* attachSession(threadId, sessionA, "ws-a");

        const moved = yield* move(threadId, to, "1", from);
        assert.deepEqual(
          moved.storedEvents.map((stored) => stored.event.type),
          ["thread.project-moved", "provider-session.detached"],
        );
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(projection.thread.projectId, to);
        assert.isNull(projection.thread.worktreePath);

        // The first turn opens the destination workspace's session.
        yield* sendMessage(threadId, "first");
        assert.equal(
          yield* sessionIdOf(threadId),
          ids.derive.providerSession({
            providerInstanceId: modelSelection.instanceId,
            sessionKey: "ws-b",
          }),
        );
      }),
  );

  it.effect("refuses a missing project and a thread that moved meanwhile", () =>
    Effect.gen(function* () {
      const { threadId, projectId: from } = yield* createThread(
        "move-guards",
        "/trellis/workspaces/ws-a/project/idea-2",
      );
      const to = yield* createProject("move-guards-target", "/trellis/workspaces/ws-c/project");
      assert.include(
        yield* rejection(move(threadId, ProjectId.make("no-such-project"), "missing")),
        "does not exist",
      );
      assert.include(
        yield* rejection(move(threadId, to, "expected", ProjectId.make("elsewhere"))),
        "moved to another project",
      );
      // The same command is idempotent through its receipt.
      yield* move(threadId, to, "once", from);
      const again = yield* move(threadId, to, "once", from);
      assert.isAtLeast(again.sequence, 1);
    }),
  );

  it.effect("refuses a busy thread, a thread with history and an unforked fork", () =>
    Effect.gen(function* () {
      const to = yield* createProject("move-refused-target", "/trellis/workspaces/ws-d/project");
      const now = yield* DateTime.now;

      const busy = yield* createThread("move-busy", "/trellis/workspaces/ws-a/project/idea-3");
      yield* sendMessage(busy.threadId, "first");
      assert.include(yield* rejection(move(busy.threadId, to, "busy")), "thread_busy");

      const history = yield* createThread(
        "move-history",
        "/trellis/workspaces/ws-a/project/idea-4",
      );
      yield* writeEvent({
        id: EventId.make("move-history:scope"),
        type: "checkpoint-scope.created",
        threadId: history.threadId,
        occurredAt: now,
        payload: {
          id: CheckpointScopeId.make("checkpoint-scope:thread:move-history:name:root"),
          threadId: history.threadId,
          runId: null,
          nodeId: NodeId.make("move-history:node"),
          parentScopeId: null,
          providerThreadId: null,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/trellis/workspaces/ws-a/project/idea-4",
          createdAt: now,
        },
      });
      assert.include(yield* rejection(move(history.threadId, to, "history")), "thread_has_history");

      const fork = yield* createThread("move-fork", "/trellis/workspaces/ws-a/project/idea-5");
      yield* writeEvent({
        id: EventId.make("move-fork:transfer"),
        type: "context-transfer.updated",
        threadId: fork.threadId,
        occurredAt: now,
        payload: {
          id: ContextTransferId.make("move-fork:transfer"),
          type: "fork",
          sourceThreadId: history.threadId,
          targetThreadId: fork.threadId,
          sourcePoint: { threadId: history.threadId },
          basePoint: null,
          sourceProviderInstanceId: modelSelection.instanceId,
          targetProviderInstanceId: modelSelection.instanceId,
          targetRunId: null,
          status: "pending",
          resolution: null,
          createdBy: "user",
          error: null,
          createdAt: now,
          updatedAt: now,
          consumedAt: null,
        },
      });
      assert.include(yield* rejection(move(fork.threadId, to, "fork")), "thread_pending_fork");
    }),
  );

  it.effect(
    "delivers the move live and by replay, and keeps it through rebuild and compaction",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const maintenance = yield* ProjectionMaintenanceV2;
        const { threadId } = yield* createThread(
          "move-delivery",
          "/trellis/workspaces/ws-a/project/idea-6",
        );
        const to = yield* createProject("move-delivery-target", "/trellis/workspaces/ws-e/project");
        const before = yield* orchestrator.getThreadEventSequence(threadId);
        const live = yield* orchestrator
          .streamStoredEventsFrom({ threadId, afterSequence: before })
          .pipe(
            Stream.filter((stored) => stored.event.type === "thread.project-moved"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          );
        yield* move(threadId, to, "delivery");
        const delivered = yield* Fiber.join(live);
        assert.equal(delivered[0]?.event.type, "thread.project-moved");
        assert.equal(
          delivered[0]?.event.type === "thread.project-moved"
            ? delivered[0].event.payload.projectId
            : null,
          to,
        );

        const replayed = yield* orchestrator.streamStoredEventsFrom({ threadId }).pipe(
          Stream.filter((stored) => stored.event.type === "thread.project-moved"),
          Stream.take(1),
          Stream.runCollect,
        );
        assert.equal(replayed.length, 1);

        yield* maintenance.rebuild;
        assert.equal((yield* orchestrator.getThreadShell(threadId))?.projectId, to);
        yield* maintenance.compactEventStore;
        yield* maintenance.rebuild;
        assert.equal((yield* orchestrator.getThreadShell(threadId))?.projectId, to);
      }),
  );
});
