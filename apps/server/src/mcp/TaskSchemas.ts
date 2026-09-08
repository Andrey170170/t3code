import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const OperationId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Prompt = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(30_000));
const PageFields = {
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(8000))),
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 50 })),
  ),
};
export const TaskCreateInput = Schema.Struct({
  operationId: OperationId,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  prompt: Prompt,
});
export const TaskSendInput = Schema.Struct({
  threadId: ThreadId,
  operationId: OperationId,
  prompt: Prompt,
});
export const TaskListInput = Schema.Struct(PageFields);
export const TaskReadInput = Schema.Struct({ threadId: ThreadId, ...PageFields });
export const TaskCreateResult = Schema.Struct({
  threadId: ThreadId,
  sequence: Schema.Number,
  status: Schema.Literal("accepted"),
});
export const TaskSendResult = TaskCreateResult;
export const TaskSummary = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  status: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export const TaskListResult = Schema.Struct({
  tasks: Schema.Array(TaskSummary),
  nextCursor: Schema.NullOr(Schema.String),
});
export const TaskReadResult = Schema.Struct({
  threadId: ThreadId,
  messages: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      role: Schema.String,
      text: Schema.String,
      createdAt: Schema.NullOr(Schema.String),
      sourceThreadId: Schema.optional(ThreadId),
    }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
  truncated: Schema.Boolean,
});
export class TaskError extends Schema.TaggedError<TaskError>()("TaskError", {
  message: Schema.String,
}) {}
