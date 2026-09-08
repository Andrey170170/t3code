import { Tool, Toolkit } from "effect/unstable/ai";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { TaskService } from "../../TaskService.ts";
import * as S from "../../TaskSchemas.ts";

const dependencies = [McpInvocationContext, TaskService];
export const TaskToolkit = Toolkit.make(
  Tool.make("task_create", {
    description:
      "Create and start a separate Codex chat in this T3 project, visible in the sidebar. Only create tasks explicitly requested by the user. Reuse operationId when retrying the same request. Returns durable acceptance, not completion.",
    parameters: S.TaskCreateInput,
    success: S.TaskCreateResult,
    failure: S.TaskError,
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false),
  Tool.make("task_send_message", {
    description:
      "Send an agent-authored follow-up to another Codex chat in this T3 project. Only send messages authorized by the user. Reuse operationId when retrying the same request. Returns durable acceptance, not completion.",
    parameters: S.TaskSendInput,
    success: S.TaskSendResult,
    failure: S.TaskError,
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false),
  Tool.make("task_list", {
    description:
      "List chats in this T3 project with status and pagination. Does not discover external CLI sessions.",
    parameters: S.TaskListInput,
    success: S.TaskListResult,
    failure: S.TaskError,
    dependencies,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("task_read", {
    description:
      "Read a bounded page of messages from a chat in this T3 project. Follow nextCursor for more messages; truncated indicates text omitted from the page.",
    parameters: S.TaskReadInput,
    success: S.TaskReadResult,
    failure: S.TaskError,
    dependencies,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
