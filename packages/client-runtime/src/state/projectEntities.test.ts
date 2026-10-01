import { EnvironmentId, TRELLIS_LANDING_PAD_PROJECT_ID } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { v2Project, v2ShellSnapshot } from "./orchestrationV2TestFixtures.ts";
import { createEnvironmentProjectAtoms } from "./projectEntities.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

describe("createEnvironmentProjectAtoms", () => {
  it("never lists the Trellis landing pad but still resolves it by id", () => {
    const catalog: EnvironmentCatalogState = {
      isReady: true,
      entries: new Map([[ENVIRONMENT_ID, { enabled: true } as ConnectionCatalogEntry]]),
    };
    const snapshot = Atom.make({
      ...v2ShellSnapshot,
      projects: [
        v2Project,
        { ...v2Project, id: TRELLIS_LANDING_PAD_PROJECT_ID, title: "New idea" },
      ],
    });
    const projects = createEnvironmentProjectAtoms({
      catalogValueAtom: Atom.make(catalog),
      snapshotAtom: () => snapshot,
    });
    const registry = AtomRegistry.make();

    expect(registry.get(projects.projectsAtom).map((project) => project.id)).toEqual([
      v2Project.id,
    ]);
    expect(
      registry.get(
        projects.projectAtom({
          environmentId: ENVIRONMENT_ID,
          projectId: TRELLIS_LANDING_PAD_PROJECT_ID,
        }),
      )?.title,
    ).toBe("New idea");
  });
});
