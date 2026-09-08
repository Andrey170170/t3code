import { OrchestrationCommand, ThreadId, type IsoDateTime } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { TaskError } from "./TaskSchemas.ts";

const OperationRow = Schema.Struct({
  requestHash: Schema.String,
  threadId: ThreadId,
  createCommand: Schema.NullOr(Schema.fromJsonString(OrchestrationCommand)),
  createdAt: Schema.String,
  sequence: Schema.NullOr(Schema.Number),
});
type Operation = typeof OperationRow.Type;
interface Claim {
  readonly sourceThreadId: ThreadId;
  readonly operationId: string;
  readonly requestHash: string;
  readonly threadId: ThreadId;
  readonly createCommand: Extract<OrchestrationCommand, { type: "thread.create" }> | null;
  readonly createdAt: IsoDateTime;
}

/** An immutable request claim survives a crash between creating a chat and starting its turn. */
export class TaskOperationStore extends Context.Service<
  TaskOperationStore,
  {
    readonly claim: (input: Claim) => Effect.Effect<Operation, TaskError>;
    readonly complete: (
      sourceThreadId: ThreadId,
      operationId: string,
      sequence: number,
    ) => Effect.Effect<void, TaskError>;
  }
>()("t3/mcp/TaskOperationStore") {}

export const makeTaskOperationStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const claim = Effect.fn("TaskOperationStore.claim")(
    function* (input: Claim) {
      const createCommandJson = input.createCommand
        ? yield* Schema.encodeEffect(Schema.fromJsonString(OrchestrationCommand))(
            input.createCommand,
          )
        : null;
      yield* sql`
      INSERT INTO agent_task_operations (
        source_thread_id, operation_id, request_hash, target_thread_id,
        create_command_json, created_at
      ) VALUES (
        ${input.sourceThreadId}, ${input.operationId}, ${input.requestHash}, ${input.threadId},
        ${createCommandJson}, ${input.createdAt}
      ) ON CONFLICT (source_thread_id, operation_id) DO NOTHING
    `;
      const rows = yield* sql`
      SELECT request_hash AS "requestHash", target_thread_id AS "threadId",
        create_command_json AS "createCommand", created_at AS "createdAt", result_sequence AS sequence
      FROM agent_task_operations
      WHERE source_thread_id = ${input.sourceThreadId} AND operation_id = ${input.operationId}
    `;
      const operation = yield* Schema.decodeUnknownEffect(OperationRow)(rows[0]);
      if (operation.requestHash !== input.requestHash) {
        return yield* new TaskError({
          message:
            "This operationId was already used for different task input. Use a new operationId for a new request.",
        });
      }
      return operation;
    },
    Effect.catch((cause) =>
      Effect.fail(
        Schema.is(TaskError)(cause)
          ? cause
          : new TaskError({ message: "Could not persist the task request." }),
      ),
    ),
  );

  const complete = Effect.fn("TaskOperationStore.complete")(
    function* (sourceThreadId: ThreadId, operationId: string, sequence: number) {
      yield* sql`
      UPDATE agent_task_operations SET result_sequence = ${sequence}
      WHERE source_thread_id = ${sourceThreadId} AND operation_id = ${operationId}
    `;
    },
    Effect.mapError(
      () =>
        new TaskError({
          message:
            "The task was accepted, but its result could not be recorded. Retry with the same operationId.",
        }),
    ),
  );
  return TaskOperationStore.of({ claim, complete });
});

export const TaskOperationStoreLive = Layer.effect(TaskOperationStore, makeTaskOperationStore);
