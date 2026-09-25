import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

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
  resolvePreviewUrl: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:trellis:resolve-preview-url",
    tag: WS_METHODS.trellisResolvePreviewUrl,
  }),
};

/** Environments with a new-idea request in flight, shared by every entry point. */
export const trellisIdeaPendingAtom = Atom.make<ReadonlyArray<EnvironmentId>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("trellis:idea-pending"),
);

/**
 * Runs `create` unless an idea is already being created in the environment,
 * so a repeated shortcut or a second entry point creates one idea. Returns
 * whether `create` ran.
 */
export async function runExclusiveTrellisIdea(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  create: () => Promise<void>,
): Promise<boolean> {
  if (registry.get(trellisIdeaPendingAtom).includes(environmentId)) return false;
  registry.update(trellisIdeaPendingAtom, (pending) => [...pending, environmentId]);
  try {
    await create();
    return true;
  } finally {
    registry.update(trellisIdeaPendingAtom, (pending) =>
      pending.filter((pendingId) => pendingId !== environmentId),
    );
  }
}
