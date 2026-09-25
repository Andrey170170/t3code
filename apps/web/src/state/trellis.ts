import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Web-only: Trellis (an optional local workspace service) has no mobile
 * surface yet, so its atoms live here instead of in client-runtime.
 *
 * Status re-runs on every (re)connection and once a minute while mounted, so
 * a Trellis service started after T3 shows up without a reload. Servers that
 * predate the method fail the query, which reads as "unavailable".
 */
export const trellisEnvironment = {
  status: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:trellis:status",
    tag: WS_METHODS.trellisGetStatus,
    staleTimeMs: 30_000,
    refreshIntervalMs: 60_000,
  }),
  find: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:trellis:find",
    tag: WS_METHODS.trellisFind,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  }),
  newIdea: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:trellis:new-idea",
    tag: WS_METHODS.trellisNewIdea,
  }),
  newProject: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:trellis:new-project",
    tag: WS_METHODS.trellisNewProject,
  }),
};
