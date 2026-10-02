/**
 * Projects this client moved to the Trellis trash, kept visible as trashed
 * with an Undo until restored or until the page reloads (the Trellis trash in
 * Settings → Trellis holds them after that). Keyed `environmentId:projectId`.
 */
import type { EnvironmentId, ProjectId, TrellisRestoreInput } from "@t3tools/contracts";
import { create } from "zustand";

export interface TrellisTrashedProject {
  readonly name: string;
  readonly restore: TrellisRestoreInput;
}

interface TrellisTrashedStore {
  readonly projects: Readonly<Record<string, TrellisTrashedProject>>;
  readonly add: (key: string, project: TrellisTrashedProject) => void;
  readonly remove: (key: string) => void;
}

export const trellisTrashedKey = (environmentId: EnvironmentId, projectId: ProjectId) =>
  `${environmentId}:${projectId}`;

export const useTrellisTrashedStore = create<TrellisTrashedStore>((set) => ({
  projects: {},
  add: (key, project) => set((state) => ({ projects: { ...state.projects, [key]: project } })),
  remove: (key) =>
    set((state) => {
      if (!(key in state.projects)) return state;
      const { [key]: _removed, ...rest } = state.projects;
      return { projects: rest };
    }),
}));

/** The trash record of one project, or null when this client did not trash it. */
export const useTrellisTrashed = (environmentId: EnvironmentId, projectId: ProjectId) =>
  useTrellisTrashedStore(
    (state) => state.projects[trellisTrashedKey(environmentId, projectId)] ?? null,
  );
