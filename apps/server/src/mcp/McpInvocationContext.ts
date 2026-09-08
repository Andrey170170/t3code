import {
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { TaskError } from "./TaskSchemas.ts";

export type McpCapability = "preview" | "tasks";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export function requireMcpCapability(
  capability: "preview",
): Effect.Effect<McpInvocationScope, PreviewAutomationUnavailableError, McpInvocationContext>;
export function requireMcpCapability(
  capability: "tasks",
): Effect.Effect<McpInvocationScope, TaskError, McpInvocationContext>;
export function requireMcpCapability(capability: McpCapability) {
  return requireCapability(capability);
}

const requireCapability = Effect.fn("mcp.requireCapability")(function* (capability: McpCapability) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    if (capability === "tasks") {
      return yield* new TaskError({ message: "Agent task access is disabled for this session." });
    }
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});
