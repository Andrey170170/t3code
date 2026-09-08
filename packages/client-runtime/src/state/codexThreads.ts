import { WS_METHODS, isImportedAgentSessionMessageId } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/** On-demand, bounded discovery and history requests shared by every client. */
export function createCodexThreadCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcCommand(runtime, {
      label: "codex-threads:list",
      tag: WS_METHODS.codexThreadsList,
    }),
    import: createEnvironmentRpcCommand(runtime, {
      label: "codex-threads:import",
      tag: WS_METHODS.codexThreadsImport,
    }),
    history: createEnvironmentRpcCommand(runtime, {
      label: "codex-threads:history",
      tag: WS_METHODS.codexThreadsHistory,
    }),
    importRecent: createEnvironmentRpcCommand(runtime, {
      label: "agent-sessions:import",
      tag: WS_METHODS.agentSessionsImport,
    }),
  };
}

/** Hide only legacy import previews while their full native history is visible. */
export function withoutLegacyHistoryPreviews<T extends { readonly id: string }>(
  messages: readonly T[],
  nativeHistoryVisible: boolean,
): readonly T[] {
  return nativeHistoryVisible
    ? messages.filter((message) => !isImportedAgentSessionMessageId(message.id))
    : messages;
}
