import * as NodeCrypto from "node:crypto";
import {
  AgentOrigin,
  CommandId,
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { TaskOperationStore, TaskOperationStoreLive } from "./TaskOperationStore.ts";
import {
  TaskError,
  TaskCreateInput,
  TaskCreateResult,
  TaskSendInput,
  TaskListInput,
  TaskListResult,
  TaskReadInput,
  TaskReadResult,
} from "./TaskSchemas.ts";

interface TaskServiceShape {
  readonly create: (
    caller: ThreadId,
    input: typeof TaskCreateInput.Type,
  ) => Effect.Effect<typeof TaskCreateResult.Type, TaskError>;
  readonly send: (
    caller: ThreadId,
    input: typeof TaskSendInput.Type,
  ) => Effect.Effect<typeof TaskCreateResult.Type, TaskError>;
  readonly list: (
    caller: ThreadId,
    input: typeof TaskListInput.Type,
  ) => Effect.Effect<typeof TaskListResult.Type, TaskError>;
  readonly read: (
    caller: ThreadId,
    input: typeof TaskReadInput.Type,
  ) => Effect.Effect<typeof TaskReadResult.Type, TaskError>;
}

/** Creates ordinary durable T3 chats; their runtimes do not belong to the requesting agent. */
export class TaskService extends Context.Service<TaskService, TaskServiceShape>()(
  "t3/mcp/TaskService",
) {}

const PageCursor = Schema.fromJsonString(
  Schema.Struct({ createdAt: Schema.String, id: Schema.String }),
);
const TaskRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  status: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const MessageRow = Schema.Struct({
  id: Schema.String,
  role: Schema.String,
  text: Schema.String,
  textLength: Schema.Number,
  createdAt: Schema.String,
  agentOrigin: Schema.NullOr(Schema.fromJsonString(AgentOrigin)),
});
const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const taskFailure = (cause: unknown) =>
  Schema.is(TaskError)(cause)
    ? cause
    : new TaskError({ message: cause instanceof Error ? cause.message : "Task operation failed." });
const pageCursor = (createdAt: string, id: string) => JSON.stringify({ createdAt, id });

export const makeTaskService = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const providers = yield* ProviderRegistry;
  const startup = yield* ServerRuntimeStartup;
  const operations = yield* TaskOperationStore;
  const sql = yield* SqlClient.SqlClient;

  const requireThread = Effect.fn("TaskService.requireThread")(function* (threadId: ThreadId) {
    const thread = yield* snapshots.getThreadShellById(threadId);
    if (Option.isNone(thread) || thread.value.archivedAt !== null) {
      return yield* new TaskError({ message: "This conversation is unavailable or archived." });
    }
    return thread.value;
  });
  const requireCodex = Effect.fn("TaskService.requireCodex")(function* (
    thread: OrchestrationThreadShell,
  ) {
    const available = yield* providers.getProviders;
    const provider = available.find(
      (entry) => entry.instanceId === thread.modelSelection.instanceId,
    );
    if (!provider || provider.driver !== "codex") {
      return yield* new TaskError({
        message:
          "Agent-authored task messages are currently supported only for Codex conversations.",
      });
    }
  });
  const requireTarget = Effect.fn("TaskService.requireTarget")(function* (
    caller: ThreadId,
    targetId: ThreadId,
  ) {
    const source = yield* requireThread(caller);
    const target = targetId === caller ? source : yield* requireThread(targetId);
    if (source.projectId !== target.projectId) {
      return yield* new TaskError({
        message:
          "Task tools can access only conversations in the requesting conversation's project.",
      });
    }
    return { source, target };
  });

  const deliver = Effect.fn("TaskService.deliver")(function* (
    caller: ThreadId,
    input: typeof TaskCreateInput.Type | typeof TaskSendInput.Type,
    create: boolean,
  ) {
    if (create) yield* Schema.decodeUnknownEffect(TaskCreateInput)(input);
    else yield* Schema.decodeUnknownEffect(TaskSendInput)(input);
    const source = yield* requireThread(caller);
    yield* requireCodex(source);
    const operationKey = digest([caller, input.operationId]);
    const targetId = create
      ? ThreadId.make(`task:${operationKey}`)
      : (input as typeof TaskSendInput.Type).threadId;
    if (!create && targetId === caller) {
      return yield* new TaskError({
        message:
          "Send a task message to a separate conversation, not to the requesting conversation.",
      });
    }
    const target = create ? source : (yield* requireTarget(caller, targetId)).target;
    yield* requireCodex(target);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const claim = yield* operations.claim({
      sourceThreadId: caller,
      operationId: input.operationId,
      requestHash: digest([
        create ? "create" : "send",
        input.operationId,
        targetId,
        create ? (input as typeof TaskCreateInput.Type).title : null,
        input.prompt,
      ]),
      threadId: targetId,
      createdAt,
      createCommand: create
        ? {
            type: "thread.create",
            commandId: CommandId.make(`task-create:${operationKey}`),
            threadId: targetId,
            projectId: source.projectId,
            title: (input as typeof TaskCreateInput.Type).title,
            modelSelection: source.modelSelection,
            runtimeMode: source.runtimeMode,
            interactionMode: source.interactionMode,
            branch: source.branch,
            worktreePath: source.worktreePath,
            createdAt,
          }
        : null,
    });
    if (
      claim.createCommand &&
      (claim.createCommand.type !== "thread.create" ||
        claim.createCommand.projectId !== source.projectId)
    ) {
      return yield* new TaskError({
        message:
          "The source project changed since this task was requested. Start a new request in the intended project.",
      });
    }
    if (claim.sequence !== null) {
      yield* requireThread(claim.threadId);
      return { threadId: claim.threadId, sequence: claim.sequence, status: "accepted" as const };
    }
    const accepted = yield* startup.enqueueCommand(
      Effect.gen(function* () {
        if (claim.createCommand) {
          // The immutable create command and deterministic command IDs let a retry
          // finish a partially accepted operation without starting another chat.
          yield* engine.dispatch(claim.createCommand);
        }
        return yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`task-send:${operationKey}`),
          threadId: claim.threadId,
          agentOrigin: { threadId: caller, operationId: input.operationId },
          message: {
            messageId: MessageId.make(`task-message:${operationKey}`),
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          runtimeMode:
            claim.createCommand?.type === "thread.create"
              ? claim.createCommand.runtimeMode
              : target.runtimeMode,
          interactionMode:
            claim.createCommand?.type === "thread.create"
              ? claim.createCommand.interactionMode
              : target.interactionMode,
          createdAt: IsoDateTime.make(claim.createdAt),
        });
      }),
    );
    yield* operations.complete(caller, input.operationId, accepted.sequence);
    return { threadId: claim.threadId, sequence: accepted.sequence, status: "accepted" as const };
  }, Effect.mapError(taskFailure));

  const list: TaskServiceShape["list"] = Effect.fn("TaskService.list")(function* (caller, input) {
    yield* Schema.decodeUnknownEffect(TaskListInput)(input);
    const source = yield* requireThread(caller);
    const cursor = input.cursor
      ? yield* Schema.decodeUnknownEffect(PageCursor)(input.cursor)
      : null;
    const limit = input.limit ?? 25;
    const rows = yield* sql`
      SELECT t.thread_id AS "threadId", t.project_id AS "projectId", t.title,
        COALESCE(s.status, 'idle') AS status, t.created_at AS "createdAt", t.updated_at AS "updatedAt"
      FROM projection_threads t
      LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
      WHERE t.project_id = ${source.projectId} AND t.deleted_at IS NULL AND t.archived_at IS NULL
        ${cursor ? sql`AND (t.created_at, t.thread_id) < (${cursor.createdAt}, ${cursor.id})` : sql``}
      ORDER BY t.created_at DESC, t.thread_id DESC LIMIT ${limit + 1}
    `;
    const tasks = yield* Schema.decodeUnknownEffect(Schema.Array(TaskRow))(rows);
    const page = tasks.slice(0, limit);
    const last = page.at(-1);
    return {
      tasks: page,
      nextCursor: tasks.length > limit && last ? pageCursor(last.createdAt, last.threadId) : null,
    };
  }, Effect.mapError(taskFailure));

  const read: TaskServiceShape["read"] = Effect.fn("TaskService.read")(function* (caller, input) {
    yield* Schema.decodeUnknownEffect(TaskReadInput)(input);
    yield* requireTarget(caller, input.threadId);
    const cursor = input.cursor
      ? yield* Schema.decodeUnknownEffect(PageCursor)(input.cursor)
      : null;
    const limit = input.limit ?? 25;
    const rows = yield* sql`
      SELECT message_id AS id, role, substr(text, 1, 4096) AS text, length(text) AS "textLength",
        created_at AS "createdAt", agent_origin_json AS "agentOrigin"
      FROM projection_thread_messages WHERE thread_id = ${input.threadId}
        ${cursor ? sql`AND (created_at, message_id) < (${cursor.createdAt}, ${cursor.id})` : sql``}
      ORDER BY created_at DESC, message_id DESC LIMIT ${limit + 1}
    `;
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(MessageRow))(rows);
    const messages: Array<(typeof TaskReadResult.Type)["messages"][number]> = [];
    let remaining = 32_000;
    let truncated = false;
    for (const row of decoded.slice(0, limit)) {
      if (remaining === 0) break;
      const text = row.text.slice(0, remaining);
      truncated ||= text.length < row.textLength;
      remaining -= text.length;
      messages.push({
        id: row.id,
        role: row.agentOrigin ? "agent" : row.role,
        text,
        createdAt: row.createdAt,
        ...(row.agentOrigin ? { sourceThreadId: row.agentOrigin.threadId } : {}),
      });
    }
    const last = messages.at(-1);
    const nextCursor =
      decoded.length > messages.length && last ? pageCursor(last.createdAt ?? "", last.id) : null;
    return { threadId: input.threadId, messages: messages.reverse(), nextCursor, truncated };
  }, Effect.mapError(taskFailure));

  return TaskService.of({
    create: (caller, input) => deliver(caller, input, true),
    send: (caller, input) => deliver(caller, input, false),
    list,
    read,
  });
});

export const TaskServiceLive = Layer.effect(TaskService, makeTaskService).pipe(
  Layer.provide(TaskOperationStoreLive),
);
