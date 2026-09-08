import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { makeTaskOperationStore, TaskOperationStore } from "./TaskOperationStore.ts";
import { CodexThreadImport } from "../project/CodexThreadImport.ts";
import { makeTaskService } from "./TaskService.ts";

const at = "2026-09-08T12:00:00.000Z";
const projectId = ProjectId.make("project");
const otherProjectId = ProjectId.make("other-project");
const caller = ThreadId.make("caller");
const sibling = ThreadId.make("sibling");
const outsider = ThreadId.make("outsider");
const claude = ThreadId.make("claude");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

const baseLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-task-service-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const providerLayer = makeProviderRegistryLayer(
  ["codex", "claudeAgent"].map((driver) => ({
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    status: "ready",
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    checkedAt: at,
    version: "test",
    models: [],
    slashCommands: [],
    skills: [],
  })),
);
const startupLayer = Layer.mock(ServerRuntimeStartup)({ enqueueCommand: (effect) => effect });

const setup = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const sql = yield* SqlClient.SqlClient;
  for (const id of [projectId, otherProjectId]) {
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(id),
      projectId: id,
      title: id,
      workspaceRoot: `/tmp/${id}`,
      createdAt: at,
    });
  }
  for (const id of [caller, sibling, outsider, claude]) {
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(id),
      threadId: id,
      projectId: id === outsider ? otherProjectId : projectId,
      title: id,
      modelSelection:
        id === claude
          ? { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude" }
          : modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: "feature",
      worktreePath: "/tmp/project-worktree",
      createdAt: at,
    });
  }
  let history: CodexThreadImport["Service"]["history"] = () =>
    Effect.succeed({ imported: false, boundary: null, items: [], nextCursor: null });
  const nativeLayer = Layer.mock(CodexThreadImport)({
    history: (input) => Effect.suspend(() => history(input)),
  });
  const operations = yield* makeTaskOperationStore;
  const build = makeTaskService.pipe(
    Effect.provideService(TaskOperationStore, operations),
    Effect.provide(Layer.mergeAll(providerLayer, startupLayer, nativeLayer)),
  );
  const service = yield* build;
  return {
    engine,
    snapshots,
    sql,
    service,
    build,
    setHistory: (handler: CodexThreadImport["Service"]["history"]) => {
      history = handler;
    },
  };
});

it.effect("persists same-operation deduplication and rejects conflicting input", () =>
  Effect.gen(function* () {
    const { service, build, snapshots, sql } = yield* setup;
    const input = { operationId: "op", title: "Scout", prompt: "Inspect the code" };
    const results = yield* Effect.all(
      [service.create(caller, input), service.create(caller, input)],
      { concurrency: "unbounded" },
    );
    assert.deepEqual(results[0], results[1]);
    const rebuilt = yield* build;
    assert.deepEqual(yield* rebuilt.create(caller, input), results[0]);
    const conflict = yield* rebuilt
      .create(caller, { ...input, prompt: "Different task" })
      .pipe(Effect.flip);
    assert.include(conflict.message, "operationId");
    const threads =
      yield* sql`SELECT thread_id FROM projection_threads WHERE thread_id LIKE 'task:%'`;
    assert.lengthOf(threads, 1);
    const detail = yield* snapshots.getThreadDetailById(results[0]!.threadId);
    assert.isTrue(Option.isSome(detail));
    if (Option.isSome(detail)) {
      assert.lengthOf(detail.value.messages, 1);
      assert.deepEqual(detail.value.modelSelection, modelSelection);
      assert.equal(detail.value.runtimeMode, "approval-required");
      assert.equal(detail.value.branch, "feature");
      assert.equal(detail.value.worktreePath, "/tmp/project-worktree");
      assert.deepEqual(detail.value.messages[0]?.agentOrigin, {
        threadId: caller,
        operationId: "op",
      });
    }
  }).pipe(Effect.provide(baseLayer)),
);

it.effect("denies cross-project access and non-Codex sends before creating an operation", () =>
  Effect.gen(function* () {
    const { service, sql } = yield* setup;
    for (const action of [
      service.read(caller, { threadId: outsider }).pipe(Effect.asVoid),
      service
        .send(caller, { threadId: outsider, operationId: "cross", prompt: "hello" })
        .pipe(Effect.asVoid),
      service
        .send(caller, { threadId: claude, operationId: "claude", prompt: "hello" })
        .pipe(Effect.asVoid),
      service
        .create(claude, { operationId: "claude-create", title: "No", prompt: "hello" })
        .pipe(Effect.asVoid),
      service
        .send(caller, { threadId: caller, operationId: "self", prompt: "hello" })
        .pipe(Effect.asVoid),
    ]) {
      const result = yield* action.pipe(Effect.flip);
      assert.equal(result._tag, "TaskError");
    }
    assert.lengthOf(yield* sql`SELECT * FROM agent_task_operations`, 0);
  }).pipe(Effect.provide(baseLayer)),
);

it.effect("lists stable project pages and bounds read text while preserving agent authorship", () =>
  Effect.gen(function* () {
    const { service, engine } = yield* setup;
    const first = yield* service.list(caller, { limit: 2 });
    assert.lengthOf(first.tasks, 2);
    assert.isNotNull(first.nextCursor);
    const second = yield* service.list(caller, { limit: 2, cursor: first.nextCursor ?? undefined });
    assert.lengthOf(second.tasks, 1);
    assert.isNull(second.nextCursor);
    assert.deepEqual(
      new Set([...first.tasks, ...second.tasks].map((t) => t.threadId)),
      new Set([caller, sibling, claude]),
    );
    for (let i = 0; i < 10; i++) {
      yield* engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make(`message:${i}`),
        threadId: sibling,
        messageId: MessageId.make(`message:${i}`),
        delta: "x".repeat(5000),
        createdAt: at,
      });
    }
    const read = yield* service.read(caller, { threadId: sibling, limit: 10 });
    assert.isTrue(read.truncated);
    assert.isAtMost(
      read.messages.reduce((sum, m) => sum + m.text.length, 0),
      32_000,
    );
    assert.isNotNull(read.nextCursor);
    const rest = yield* service.read(caller, {
      threadId: sibling,
      cursor: read.nextCursor ?? undefined,
      limit: 10,
    });
    assert.equal(new Set([...read.messages, ...rest.messages].map((m) => m.id)).size, 10);
  }).pipe(Effect.provide(baseLayer)),
);

it.effect("recovers a persisted create claim after failure before its initial turn", () =>
  Effect.gen(function* () {
    const { engine, build, sql, snapshots } = yield* setup;
    const interrupted = yield* build.pipe(
      Effect.provideService(OrchestrationEngineService, {
        ...engine,
        dispatch: (command) =>
          command.type === "thread.turn.start"
            ? Effect.fail(
                new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "simulated interruption",
                }),
              )
            : engine.dispatch(command),
      }),
    );
    const input = {
      operationId: "interrupted",
      title: "Recover",
      prompt: "Continue after restart",
    };
    const error = yield* interrupted.create(caller, input).pipe(Effect.flip);
    assert.include(error.message, "simulated interruption");
    assert.lengthOf(
      yield* sql`SELECT thread_id FROM projection_threads WHERE thread_id LIKE 'task:%'`,
      1,
    );
    assert.lengthOf(yield* sql`SELECT message_id FROM projection_thread_messages`, 0);
    yield* engine.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("change-source-policy"),
      threadId: caller,
      runtimeMode: "full-access",
      createdAt: at,
    });
    const reconstructed = yield* build;
    const result = yield* reconstructed.create(caller, input);
    assert.equal(result.status, "accepted");
    assert.lengthOf(
      yield* sql`SELECT thread_id FROM projection_threads WHERE thread_id LIKE 'task:%'`,
      1,
    );
    const detail = yield* snapshots.getThreadDetailById(result.threadId);
    assert.isTrue(Option.isSome(detail));
    if (Option.isSome(detail)) {
      assert.lengthOf(detail.value.messages, 1);
      assert.equal(detail.value.runtimeMode, "approval-required");
    }
    const rows =
      yield* sql`SELECT result_sequence FROM agent_task_operations WHERE operation_id = 'interrupted'`;
    assert.equal(rows[0]?.result_sequence, result.sequence);
  }).pipe(Effect.provide(baseLayer)),
);

it.effect("deduplicates follow-ups and exposes their agent source when reading", () =>
  Effect.gen(function* () {
    const { service, build } = yield* setup;
    const input = { threadId: sibling, operationId: "followup", prompt: "Please check the parser" };
    const results = yield* Effect.all([service.send(caller, input), service.send(caller, input)], {
      concurrency: "unbounded",
    });
    assert.deepEqual(results[0], results[1]);
    const reconstructed = yield* build;
    assert.deepEqual(yield* reconstructed.send(caller, input), results[0]);
    const read = yield* service.read(caller, { threadId: sibling });
    assert.lengthOf(read.messages, 1);
    assert.equal(read.messages[0]?.role, "agent");
    assert.equal(read.messages[0]?.sourceThreadId, caller);
    assert.equal(read.messages[0]?.text, input.prompt);
    const conflict = yield* service
      .send(caller, { ...input, threadId: ThreadId.make("caller") })
      .pipe(Effect.flip);
    assert.equal(conflict._tag, "TaskError");
  }).pipe(Effect.provide(baseLayer)),
);

it.effect("reads native imported history instead of reporting an empty conversation", () =>
  Effect.gen(function* () {
    const { service, setHistory } = yield* setup;
    const calls: Array<{ cursor?: string | undefined; limit?: number | undefined }> = [];
    setHistory((input) => {
      calls.push(input);
      return Effect.succeed({
        imported: true,
        boundary: { nativeThreadId: "native-import", importedAt: at },
        items: [
          {
            turnId: "native-turn",
            item: {
              id: input.cursor ? "older" : "newest",
              type: "agentMessage",
              text: input.cursor ? "Earlier answer" : "Original answer",
            },
          },
        ],
        nextCursor: input.cursor ? null : "opaque-native-cursor",
      });
    });
    const newest = yield* service.read(caller, { threadId: sibling, limit: 5 });
    assert.equal(newest.messages[0]?.text, "Original answer");
    assert.equal(newest.messages[0]?.createdAt, null);
    assert.isNotNull(newest.nextCursor);
    const older = yield* service.read(caller, {
      threadId: sibling,
      cursor: newest.nextCursor!,
      limit: 5,
    });
    assert.equal(older.messages[0]?.text, "Earlier answer");
    assert.isNull(older.nextCursor);
    assert.equal(calls.at(-1)?.cursor, "opaque-native-cursor");
    assert.equal(calls.at(-1)?.limit, 5);
    const invalid = yield* service
      .read(caller, { threadId: sibling, limit: 51 })
      .pipe(Effect.result);
    assert.equal(invalid._tag, "Failure");
  }).pipe(Effect.provide(baseLayer)),
);
