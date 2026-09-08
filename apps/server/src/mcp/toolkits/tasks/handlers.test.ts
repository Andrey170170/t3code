import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { McpInvocationContext, type McpCapability } from "../../McpInvocationContext.ts";
import { TaskService } from "../../TaskService.ts";
import { TaskToolkitHandlersLive } from "./handlers.ts";
import { TaskToolkit } from "./tools.ts";

const caller = ThreadId.make("credential-caller");
const target = ThreadId.make("target");
const invocation = (capabilities: ReadonlyArray<McpCapability>) => ({
  environmentId: EnvironmentId.make("environment"),
  threadId: caller,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: "session",
  issuedAt: 0,
  capabilities: new Set(capabilities),
});

it.effect("derives the sender from the credential, independently of the target", () =>
  Effect.gen(function* () {
    const calls: Array<unknown> = [];
    const service = TaskService.of({
      create: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      read: () => Effect.die("unused"),
      send: (source, input) =>
        Effect.sync(() => {
          calls.push({ source, input });
          return { threadId: target, sequence: 1, status: "accepted" as const };
        }),
    });
    const toolkit = yield* TaskToolkit.pipe(Effect.provide(TaskToolkitHandlersLive));
    const input = { threadId: target, operationId: "op", prompt: "Continue" };
    yield* toolkit
      .handle("task_send_message", input)
      .pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provideService(TaskService, service),
        Effect.provideService(McpInvocationContext, invocation(["tasks"])),
      );
    expect(calls).toEqual([{ source: caller, input }]);
  }),
);

it.effect("denies a task call before reaching the service when capability is absent", () =>
  Effect.gen(function* () {
    const service = TaskService.of({
      create: () => Effect.die("unauthorized service call"),
      send: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      read: () => Effect.die("unused"),
    });
    const toolkit = yield* TaskToolkit.pipe(Effect.provide(TaskToolkitHandlersLive));
    const result = yield* toolkit
      .handle("task_create", { operationId: "op", title: "Task", prompt: "Work" })
      .pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.result,
        Effect.provideService(TaskService, service),
        Effect.provideService(McpInvocationContext, invocation(["preview"])),
      );
    expect(result._tag).toBe("Failure");
  }),
);
