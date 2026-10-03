import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { layer as mcpSessionRegistryTestLayer } from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../orchestration-v2/IdAllocator.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2LayerLive,
} from "../orchestration-v2/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { makeTestTrellis, Trellis } from "./Trellis.ts";

// Codex shares one app-server per session; in a Trellis workspace the shim
// routes that process into the container, so sessions are keyed by workspace.

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");

const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry)({ resolveLink: () => Effect.die("unused") }),
);
const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-trellis-session-keys-",
});
const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provide(
    VcsDriverRegistry.layer.pipe(
      Layer.provide(VcsProcess.layer),
      Layer.provide(ServerConfigLayer),
      Layer.provide(PlatformTestLayer),
    ),
  ),
);
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not opened by dispatch"),
  } as ProviderAdapterV2Shape,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const TestLayer = Layer.mergeAll(
  OrchestrationV2LayerLive,
  OrchestrationV2EventSinkLayerLive,
  ProjectStore.layer,
  idAllocatorLayer,
).pipe(
  Layer.provide(
    Layer.succeed(
      Trellis,
      makeTestTrellis({
        env: { root: "/trellis", bin: "trellis", shimDir: "/t3/trellis-shims" },
        primer: () => Effect.succeed("Trellis primer."),
      }),
    ),
  ),
  Layer.provide(mcpSessionRegistryTestLayer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(GitWorkflow.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
      createWorktree: () => Effect.succeed({} as never),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
  ),
  Layer.provide(PlatformTestLayer),
);

const projectEvent = (
  type: "project.created" | "project.meta-updated",
  projectId: ProjectId,
  workspaceRoot: string,
) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`${type}:${projectId}:${workspaceRoot}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: "2026-09-30T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      ...(type === "project.created"
        ? {
            type,
            payload: {
              projectId,
              title: projectId,
              workspaceRoot,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-09-30T00:00:00.000Z",
              updatedAt: "2026-09-30T00:00:00.000Z",
            },
          }
        : {
            type,
            payload: { projectId, workspaceRoot, updatedAt: "2026-09-30T00:00:01.000Z" },
          }),
    }),
  );

/** Creates a thread in a new project at `workspaceRoot` and sends its first message. */
const startThread = (name: string, workspaceRoot: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projectId = ProjectId.make(`${name}-project`);
    const threadId = ThreadId.make(name);
    yield* projectEvent("project.created", projectId, workspaceRoot);
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${name}:create`),
      threadId,
      projectId,
      title: name,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* sendMessage(threadId, "first");
    return { threadId, projectId };
  });

const sendMessage = (threadId: ThreadId, label: string) =>
  Effect.flatMap(OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${threadId}:message:${label}`),
      threadId,
      messageId: MessageId.make(`${threadId}:message:${label}`),
      text: label,
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
    }),
  );

const sessionIdOf = (threadId: ThreadId) =>
  Effect.flatMap(OrchestratorV2, (orchestrator) => orchestrator.getThreadProjection(threadId)).pipe(
    Effect.map((projection) => {
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === projection.thread.activeProviderThreadId,
      );
      return providerThread?.providerSessionId ?? null;
    }),
  );

/** Records that a live session serves `threadId`, as the session manager does on open. */
const attachSession = (threadId: ThreadId, providerSessionId: ProviderSessionId, key: string) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSinkV2;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${threadId}:attached:${providerSessionId}`),
          type: "provider-session.attached",
          threadId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            id: providerSessionId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            status: "ready",
            cwd: "/trellis/workspaces/ws-a/project",
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
            sessionKey: key,
          },
        },
      ],
    });
  });

it.layer(TestLayer)("Trellis provider session keys", (it) => {
  it.effect("give one Codex session per workspace, shared within it", () =>
    Effect.gen(function* () {
      const ids = yield* IdAllocatorV2;
      const a1 = yield* startThread("keys-a1", "/trellis/workspaces/ws-a/project");
      const a2 = yield* startThread("keys-a2", "/trellis/workspaces/ws-a/project/idea-2");
      const b = yield* startThread("keys-b", "/trellis/workspaces/ws-b/project");
      const host = yield* startThread("keys-host", "/home/me/code");

      const sessionA = ids.derive.providerSession({
        providerInstanceId: modelSelection.instanceId,
        sessionKey: "ws-a",
      });
      assert.equal(yield* sessionIdOf(a1.threadId), sessionA);
      assert.equal(yield* sessionIdOf(a2.threadId), sessionA);
      assert.equal(
        yield* sessionIdOf(b.threadId),
        ids.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
          sessionKey: "ws-b",
        }),
      );
      // Host threads keep V2's one shared session per instance.
      assert.equal(
        yield* sessionIdOf(host.threadId),
        ids.derive.providerSession({ providerInstanceId: modelSelection.instanceId }),
      );
    }),
  );

  it.effect("never reattach a moved thread to its old workspace's live session", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const ids = yield* IdAllocatorV2;
      const sessionA = ids.derive.providerSession({
        providerInstanceId: modelSelection.instanceId,
        sessionKey: "ws-a",
      });
      const moved = yield* startThread("keys-moved", "/trellis/workspaces/ws-a/project/idea-3");
      const staying = yield* startThread("keys-staying", "/trellis/workspaces/ws-a/project/idea-4");
      // The ws-a process is live and serves both threads.
      yield* attachSession(moved.threadId, sessionA, "ws-a");
      yield* attachSession(staying.threadId, sessionA, "ws-a");
      const firstRun = (yield* orchestrator.getThreadProjection(moved.threadId)).runs[0]!;
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("keys-moved:interrupt"),
        threadId: moved.threadId,
        runId: firstRun.id,
      });

      // The project now lives in workspace ws-b.
      yield* projectEvent(
        "project.meta-updated",
        moved.projectId,
        "/trellis/workspaces/ws-b/project",
      );
      yield* sendMessage(moved.threadId, "after-move");

      assert.equal(
        yield* sessionIdOf(moved.threadId),
        ids.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
          sessionKey: "ws-b",
        }),
      );
      assert.equal(yield* sessionIdOf(staying.threadId), sessionA);
      // The moved thread left the old process; the other thread keeps it.
      const sessionsOf = (threadId: ThreadId) =>
        orchestrator
          .getThreadProjection(threadId)
          .pipe(
            Effect.map((projection) => projection.providerSessions.map((session) => session.id)),
          );
      assert.notInclude(yield* sessionsOf(moved.threadId), sessionA);
      assert.include(yield* sessionsOf(staying.threadId), sessionA);
    }),
  );
});
