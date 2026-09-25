import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type TrellisStatus, WS_METHODS } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, type AtomRegistry } from "effect/unstable/reactivity";

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
  trash: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:trellis:trash",
    tag: WS_METHODS.trellisListTrash,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  }),
  newIdea: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:trellis:new-idea",
    tag: WS_METHODS.trellisNewIdea,
  }),
  prepareIdeaDraft: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:trellis:prepare-idea-draft",
    tag: WS_METHODS.trellisPrepareIdeaDraft,
  }),
  newProject: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:trellis:new-project",
    tag: WS_METHODS.trellisNewProject,
  }),
  trashProject: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:trellis:trash-project",
    tag: WS_METHODS.trellisTrashProject,
  }),
  restore: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:trellis:restore",
    tag: WS_METHODS.trellisRestore,
  }),
  emptyTrash: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:trellis:empty-trash",
    tag: WS_METHODS.trellisEmptyTrash,
  }),
  resolvePreviewUrl: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:trellis:resolve-preview-url",
    tag: WS_METHODS.trellisResolvePreviewUrl,
  }),
};

/** The last Trellis status of an environment, for event handlers; null while unknown. */
export function readTrellisStatus(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
): TrellisStatus | null {
  return Option.getOrNull(
    AsyncResult.value(registry.get(trellisEnvironment.status({ environmentId, input: {} }))),
  );
}
