import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/** On-demand, bounded discovery and import requests shared by every client. */
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
    importRecent: createEnvironmentRpcCommand(runtime, {
      label: "agent-sessions:import",
      tag: WS_METHODS.agentSessionsImport,
    }),
  };
}
