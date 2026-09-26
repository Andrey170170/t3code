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
function readTrellisStatus(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
): TrellisStatus | null {
  return Option.getOrNull(
    AsyncResult.value(registry.get(trellisEnvironment.status({ environmentId, input: {} }))),
  );
}

/**
 * A fresh Trellis status of an environment for an event handler: refetched,
 * since the cached one can be minutes old. Falls back to the cached one when
 * no answer arrives within `timeoutMs`.
 */
export function loadTrellisStatus(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  timeoutMs = 5_000,
): Promise<TrellisStatus | null> {
  const atom = trellisEnvironment.status({ environmentId, input: {} });
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const finish = (status: TrellisStatus | null) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(status);
    };
    const timer = setTimeout(() => finish(readTrellisStatus(registry, environmentId)), timeoutMs);
    unsubscribe = registry.subscribe(atom, (result) => {
      if (result.waiting) return;
      finish(Option.getOrNull(AsyncResult.value(result)));
    });
    registry.refresh(atom);
  });
}

/** Refetches an environment's Trellis status, e.g. after a trash or restore. */
export function refreshTrellisStatus(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
): void {
  registry.refresh(trellisEnvironment.status({ environmentId, input: {} }));
}
