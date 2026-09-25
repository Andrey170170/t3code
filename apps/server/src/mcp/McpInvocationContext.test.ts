import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  McpCapabilityUnavailableError,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  McpInvocationContext,
  requireMcpCapability,
  type McpCapability,
  type McpInvocationScope,
} from "./McpInvocationContext.ts";

const scope = (capabilities: ReadonlyArray<McpCapability>) => ({
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("caller"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: "session",
  issuedAt: 0,
  capabilities: new Set(capabilities),
});

it.effect("browser access does not authorize task operations", () =>
  Effect.gen(function* () {
    const result = yield* requireMcpCapability("tasks").pipe(
      Effect.result,
      Effect.provideService(McpInvocationContext, scope(["preview"])),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure._tag).toBe("TaskError");
  }),
);

it.effect("task access does not authorize browser operations", () =>
  Effect.gen(function* () {
    const result = yield* requireMcpCapability("preview").pipe(
      Effect.result,
      Effect.provideService(McpInvocationContext, scope(["tasks"])),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure._tag).toBe("PreviewAutomationUnavailableError");
    const invocation = yield* requireMcpCapability("tasks").pipe(
      Effect.provideService(McpInvocationContext, scope(["tasks"])),
    );
    expect(invocation.threadId).toBe("caller");
  }),
);

it.effect("reports the scoped credential context when preview capability is unavailable", () => {
  const invocation: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
    expect(error).toMatchObject({
      capability: "preview",
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
    expect(error.message).toContain("MCP credential does not grant the preview capability");
    expect(error.message).toContain("use a headless browser from the shell");
  });
});

it.effect("reports other missing capabilities with the neutral error", () => {
  const invocation: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["preview"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* requireMcpCapability("pull-requests").pipe(
      Effect.provideService(McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(McpCapabilityUnavailableError);
    expect(error).toMatchObject({ capability: "pull-requests", threadId: invocation.threadId });

    const scope = yield* requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext, invocation),
    );
    expect(scope).toBe(invocation);
  });
});
