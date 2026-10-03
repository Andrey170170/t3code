import { EnvironmentId, ProjectId, type TrellisStatus } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  reconcileTrellisTrashed,
  trellisTrashedKey,
  useTrellisTrashedStore,
} from "./trellisTrashed";

const environmentId = EnvironmentId.make("env-1");
const key = trellisTrashedKey(environmentId, ProjectId.make("p-1"));
const root = "/trellis/workspaces/ws-1/project";
const status = (retiredRoots: ReadonlyArray<string>): TrellisStatus =>
  ({
    state: "ready",
    root: "/trellis",
    knownRoots: [],
    socketPath: "/s",
    retiredRoots,
  }) as TrellisStatus;
// The status cached when the project was trashed: from before the trash.
const before = status([]);
const phase = () => useTrellisTrashedStore.getState().projects[key]?.phase ?? null;

describe("reconcileTrellisTrashed", () => {
  beforeEach(() => {
    useTrellisTrashedStore.setState({ projects: {} });
    useTrellisTrashedStore.getState().add(key, {
      name: "Project",
      environmentId,
      workspaceRoot: `${root}/`,
      restore: { kind: "project", id: "prj-1" },
      phase: "trashing",
      staleStatus: before,
    });
  });

  it("keeps a fresh entry against the status from before the trash", () => {
    reconcileTrellisTrashed(environmentId, before);
    expect(phase()).toBe("trashing");
    reconcileTrellisTrashed(environmentId, status([root]));
    expect(phase()).toBe("trashed");
  });

  it("drops an entry once a status shows it restored, here or elsewhere", () => {
    reconcileTrellisTrashed(environmentId, status([root]));
    reconcileTrellisTrashed(environmentId, status([]));
    expect(phase()).toBeNull();
  });

  it("keeps a restoring entry listed until the status shows the restore", () => {
    reconcileTrellisTrashed(environmentId, status([root]));
    useTrellisTrashedStore.getState().setPhase(key, "restoring");
    reconcileTrellisTrashed(environmentId, status([root]));
    expect(phase()).toBe("restoring");
    reconcileTrellisTrashed(environmentId, status([]));
    expect(phase()).toBeNull();
  });

  it("drops an entry restored elsewhere before any status showed it trashed", () => {
    reconcileTrellisTrashed(environmentId, status([]));
    expect(phase()).toBeNull();
  });

  it("ignores other environments and statuses that are not ready", () => {
    reconcileTrellisTrashed(environmentId, status([root]));
    reconcileTrellisTrashed(EnvironmentId.make("env-2"), status([]));
    reconcileTrellisTrashed(environmentId, { ...status([]), state: "unavailable" });
    expect(phase()).toBe("trashed");
  });
});
