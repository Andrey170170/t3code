import * as Effect from "effect/Effect";
import { requireMcpCapability } from "../../McpInvocationContext.ts";
import { TaskService } from "../../TaskService.ts";
import { TaskToolkit } from "./tools.ts";

export const TaskToolkitHandlersLive = TaskToolkit.toLayer({
  task_create: Effect.fn("TaskToolkit.create")(function* (input) {
    const scope = yield* requireMcpCapability("tasks");
    return yield* (yield* TaskService).create(scope.threadId, input);
  }),
  task_send_message: Effect.fn("TaskToolkit.send")(function* (input) {
    const scope = yield* requireMcpCapability("tasks");
    return yield* (yield* TaskService).send(scope.threadId, input);
  }),
  task_list: Effect.fn("TaskToolkit.list")(function* (input) {
    const scope = yield* requireMcpCapability("tasks");
    return yield* (yield* TaskService).list(scope.threadId, input);
  }),
  task_read: Effect.fn("TaskToolkit.read")(function* (input) {
    const scope = yield* requireMcpCapability("tasks");
    return yield* (yield* TaskService).read(scope.threadId, input);
  }),
});
