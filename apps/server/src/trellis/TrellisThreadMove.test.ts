import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  ContextTransferId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import {
  checkpointRefForScopeOrdinal,
  rootCheckpointScopeName,
} from "../orchestration-v2/CheckpointService.ts";
import { EffectOutboxV2 } from "../orchestration-v2/EffectOutbox.ts";
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
  runToCompletion,
  sendMessage,
  sessionIdOf,
  TrellisOrchestratorTestLayer,
  writeEvent,
} from "./TrellisOrchestrator.testkit.ts";

// `thread.project.move`: its guards, its event (live, replayed, rebuilt and
// compacted), the detach, and the moved thread's first turn opening in the
// new project's workspace.

const driver = ProviderDriverKind.make("codex");

it.layer(TrellisOrchestratorTestLayer)("thread.project.move", (it) => {
  it.effect(
    "moves a thread without history, detaches its session, and runs it in the new workspace",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const outbox = yield* EffectOutboxV2;
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
        const now = yield* DateTime.now;
        const nativeThreadRef = {
          driver,
          nativeId: "native-move-ok",
          strength: "strong" as const,
        };
        const providerThreadId = ProviderThreadId.make("provider-thread:move-ok");
        yield* writeEvent({
          id: EventId.make("move-ok:provider-thread"),
          type: "provider-thread.updated",
          threadId,
          driver,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: sessionA,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        });

        const moved = yield* move(threadId, to, "1", from);
        assert.deepEqual(
          moved.storedEvents.map((stored) => stored.event.type),
          ["thread.project-moved", "provider-session.detached"],
        );
        // The detach unloads the thread from the old workspace's process by
        // the native ref it had there.
        const [detach] = yield* outbox.listByCommandId(CommandId.make(`${threadId}:move:1`));
        assert.deepInclude(detach?.request, {
          type: "provider-session.detach",
          providerSessionId: sessionA,
          unloadProviderThreads: [{ providerThreadId, nativeThreadRef }],
        });
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

  it.effect("refuses a busy thread and an unforked fork", () =>
    Effect.gen(function* () {
      const to = yield* createProject("move-refused-target", "/trellis/workspaces/ws-d/project");
      const now = yield* DateTime.now;

      const busy = yield* createThread("move-busy", "/trellis/workspaces/ws-a/project/idea-3");
      yield* sendMessage(busy.threadId, "first");
      assert.include(yield* rejection(move(busy.threadId, to, "busy")), "thread_busy");

      const source = yield* createThread("move-source", "/trellis/workspaces/ws-a/project/idea-4");
      const fork = yield* createThread("move-fork", "/trellis/workspaces/ws-a/project/idea-5");
      yield* writeEvent({
        id: EventId.make("move-fork:transfer"),
        type: "context-transfer.updated",
        threadId: fork.threadId,
        occurredAt: now,
        payload: {
          id: ContextTransferId.make("move-fork:transfer"),
          type: "fork",
          sourceThreadId: source.threadId,
          targetThreadId: fork.threadId,
          sourcePoint: { threadId: source.threadId },
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
    "a thread with history moves as the same thread and native session, into a new scope",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const ideaPath = "/trellis/workspaces/ws-a/project/idea-history";
        const projectPath = "/trellis/workspaces/ws-f/project";
        const { threadId, projectId: from } = yield* createThread("move-history", ideaPath);
        const to = yield* createProject("move-history-target", projectPath);
        const first = yield* runToCompletion(threadId, "first");
        const before = yield* orchestrator.getThreadProjection(threadId);
        const providerThread = before.providerThreads.find(
          (candidate) => candidate.id === before.thread.activeProviderThreadId,
        )!;
        // The provider's own session, as resuming it records it.
        const nativeThreadRef = {
          driver,
          nativeId: "native-move-history",
          strength: "strong" as const,
        };
        yield* writeEvent({
          id: EventId.make("move-history:native"),
          type: "provider-thread.updated",
          threadId,
          driver,
          occurredAt: first.requestedAt,
          payload: { ...providerThread, nativeThreadRef },
        });

        yield* move(threadId, to, "history", from);
        const moved = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(moved.thread.projectId, to);
        assert.equal(moved.thread.workspaceAssignment, 1);

        yield* sendMessage(threadId, "second");
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.thread.activeProviderThreadId, providerThread.id);
        assert.deepEqual(
          after.providerThreads.find((candidate) => candidate.id === providerThread.id)
            ?.nativeThreadRef,
          nativeThreadRef,
        );
        // Each project keeps its own root scope; the old one keeps its folder.
        const ids = yield* IdAllocatorV2;
        const scopeIdOf = (assignment: number) =>
          ids.allocate.checkpointScope({ threadId, name: rootCheckpointScopeName(assignment) });
        assert.deepEqual(
          after.checkpointScopes.map((scope) => [scope.id, scope.cwd, scope.workspaceAssignment]),
          [
            [yield* scopeIdOf(0), ideaPath, undefined],
            [yield* scopeIdOf(1), projectPath, 1],
          ],
        );
        const second = after.runs.at(-1)!;
        const rootNode = after.nodes.find((node) => node.id === second.rootNodeId);
        assert.equal(rootNode?.checkpointScopeId, yield* scopeIdOf(1));
      }),
  );

  it.effect("a file restore across the move is refused; a conversation rewind is allowed", () =>
    Effect.gen(function* () {
      const ids = yield* IdAllocatorV2;
      const { threadId, projectId: from } = yield* createThread(
        "move-boundary",
        "/trellis/workspaces/ws-a/project/idea-boundary",
      );
      const to = yield* createProject("move-boundary-target", "/trellis/workspaces/ws-g/project");
      const run = yield* runToCompletion(threadId, "first");
      // The thread's start, captured in the idea before its first run.
      const scopeId = CheckpointScopeId.make(`checkpoint-scope:thread:${threadId}:name:root`);
      const checkpointId = yield* ids.allocate.checkpoint({
        checkpointScopeId: scopeId,
        name: "0",
      });
      yield* writeEvent({
        id: EventId.make("move-boundary:baseline"),
        type: "checkpoint.captured",
        threadId,
        occurredAt: run.requestedAt,
        payload: {
          id: checkpointId,
          threadId,
          scopeId,
          runId: null,
          nodeId: run.rootNodeId!,
          parentCheckpointId: null,
          ordinalWithinScope: 0,
          appRunOrdinal: null,
          ref: checkpointRefForScopeOrdinal({ scopeId, ordinalWithinScope: 0 }),
          status: "ready",
          files: [],
          capturedAt: run.requestedAt,
        },
      });
      yield* move(threadId, to, "boundary", from);

      const rollback = (label: string, restoreFiles: boolean) =>
        Effect.flatMap(OrchestratorV2, (orchestrator) =>
          orchestrator.dispatch({
            type: "checkpoint.rollback",
            commandId: CommandId.make(`${threadId}:rollback:${label}`),
            threadId,
            scopeId,
            checkpointId,
            restoreFiles,
          }),
        );
      assert.include(
        yield* rejection(rollback("files", true)),
        "before the thread moved to its current project",
      );
      const rewound = yield* rollback("conversation", false);
      assert.isAtLeast(rewound.sequence, 1);
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
