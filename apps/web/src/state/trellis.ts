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
  // Agents discard forks and file purge requests while the page is open.
  trash: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:trellis:trash",
    tag: WS_METHODS.trellisListTrash,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshIntervalMs: 30_000,
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
  restoreConflicts: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:trellis:restore-conflicts",
    tag: WS_METHODS.trellisRestoreConflicts,
  }),
  emptyTrash: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:trellis:empty-trash",
    tag: WS_METHODS.trellisEmptyTrash,
  }),
  resolvePreviewUrl: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:trellis:resolve-preview-url",
    tag: WS_METHODS.trellisResolvePreviewUrl,
  }),
  /**
   * A Trellis project's workspaces, worker forks and discarded forks included.
   * Agents spawn and discard forks on their own, so it refreshes while shown.
   */
  workspaces: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:trellis:workspaces",
    tag: WS_METHODS.trellisListWorkspaces,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshIntervalMs: 15_000,
  }),
  checkpoints: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:trellis:checkpoints",
    tag: WS_METHODS.trellisListCheckpoints,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  }),
  forkWorkspace: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:trellis:fork-workspace",
    tag: WS_METHODS.trellisForkWorkspace,
  }),
  purge: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:trellis:purge",
    tag: WS_METHODS.trellisPurge,
  }),
  bases: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:trellis:bases",
    tag: WS_METHODS.trellisListBases,
    staleTimeMs: 30_000,
    idleTtlMs: 60_000,
  }),
  /** The service's version, uptime, disk, bases and running workspaces, for Settings. */
  details: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:trellis:details",
    tag: WS_METHODS.trellisGetDetails,
    staleTimeMs: 30_000,
    idleTtlMs: 60_000,
    refreshIntervalMs: 60_000,
  }),
  /** Rebuilds a base from its built-in definition; takes minutes. */
  buildBase: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:trellis:build-base",
    tag: WS_METHODS.trellisBuildBase,
  }),
  graduate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:trellis:graduate",
    tag: WS_METHODS.trellisGraduate,
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
