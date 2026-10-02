/**
 * Projects this client moved to the Trellis trash, kept visible as trashed
 * with an Undo until restored or until the page reloads (the Trellis trash in
 * Settings → Trellis holds them after that). Keyed `environmentId:projectId`.
 *
 * Trellis status is the authority, applied by `reconcileTrellisTrashed`.
 * Each entry remembers the status that was cached when it was added
 * (`staleStatus`), from before the trash, and ignores it; any later status
 * settles it: its root retired keeps it (`trashing` becomes `trashed`), its
 * root live drops it, whether this client's Undo (`restoring`) or a restore
 * elsewhere brought it back.
 */
import type {
  EnvironmentId,
  ProjectId,
  TrellisRestoreInput,
  TrellisStatus,
} from "@t3tools/contracts";
import { create } from "zustand";

export interface TrellisTrashedProject {
  readonly name: string;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly restore: TrellisRestoreInput;
  readonly phase: "trashing" | "trashed" | "restoring";
  /** The status cached when the entry was added, from before the trash. */
  readonly staleStatus: TrellisStatus | null;
}

interface TrellisTrashedStore {
  readonly projects: Readonly<Record<string, TrellisTrashedProject>>;
  readonly add: (key: string, project: TrellisTrashedProject) => void;
  readonly setPhase: (key: string, phase: TrellisTrashedProject["phase"]) => void;
  readonly remove: (key: string) => void;
}

export const trellisTrashedKey = (environmentId: EnvironmentId, projectId: ProjectId) =>
  `${environmentId}:${projectId}`;

export const useTrellisTrashedStore = create<TrellisTrashedStore>((set) => ({
  projects: {},
  add: (key, project) => set((state) => ({ projects: { ...state.projects, [key]: project } })),
  setPhase: (key, phase) =>
    set((state) => {
      const project = state.projects[key];
      if (project === undefined || project.phase === phase) return state;
      return { projects: { ...state.projects, [key]: { ...project, phase } } };
    }),
  remove: (key) =>
    set((state) => {
      if (!(key in state.projects)) return state;
      const { [key]: _removed, ...rest } = state.projects;
      return { projects: rest };
    }),
}));

const trimTrailingSlashes = (path: string) => path.replace(/(.)\/+$/, "$1");

/** Applies one environment's Trellis status to that environment's entries. */
export function reconcileTrellisTrashed(environmentId: EnvironmentId, status: TrellisStatus) {
  if (status.state !== "ready") return;
  const retired = new Set(status.retiredRoots ?? []);
  const store = useTrellisTrashedStore.getState();
  for (const [key, project] of Object.entries(store.projects)) {
    if (project.environmentId !== environmentId || status === project.staleStatus) continue;
    if (retired.has(trimTrailingSlashes(project.workspaceRoot))) {
      if (project.phase === "trashing") store.setPhase(key, "trashed");
    } else {
      store.remove(key);
    }
  }
}
