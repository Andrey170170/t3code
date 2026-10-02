import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, TrellisStatus } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { isHiddenRetiredProject, isHiddenWorkerProject } from "~/lib/trellis";
import { useProjects, useThreadShells } from "~/state/entities";
import { trellisEnvironment } from "~/state/trellis";
import { reconcileTrellisTrashed, useTrellisTrashedStore } from "~/state/trellisTrashed";

const NO_THREADS = { leads: 0, workers: 0, forkWorkers: 0 } as const;

/**
 * The projects the sidebars list: every project, minus Trellis projects whose
 * item is in the trash and worker forks (forks delegated workers run in),
 * unless a lead thread or a draft is there. With `keepTrashedHere` (the
 * sidebars), a project this client just moved to the trash stays, listed as
 * trashed with an Undo; elsewhere (new-thread targets) it is gone. Archived conversations stay in
 * Settings → Archive; worker forks are listed in their project's settings.
 */
export function useSidebarProjects(
  options: { readonly keepTrashedHere?: boolean } = {},
): ReadonlyArray<EnvironmentProject> {
  const keepTrashedHere = options.keepTrashedHere === true;
  const projects = useProjects();
  const threads = useThreadShells();
  const environmentKey = [...new Set(projects.map((project) => project.environmentId))]
    .toSorted()
    .join("\n");
  const statusAtom = useMemo(
    () =>
      Atom.make((get) => {
        const statuses = new Map<EnvironmentId, TrellisStatus>();
        for (const environmentId of environmentKey.split("\n")) {
          if (environmentId.length === 0) continue;
          const id = environmentId as EnvironmentId;
          const status = Option.getOrNull(
            AsyncResult.value(get(trellisEnvironment.status({ environmentId: id, input: {} }))),
          );
          if (status !== null) statuses.set(id, status);
        }
        return statuses;
      }),
    [environmentKey],
  );
  const statuses = useAtomValue(statusAtom);
  const trashedHere = useTrellisTrashedStore((state) => state.projects);
  // Every status read settles this client's trashed entries.
  useEffect(() => {
    for (const [environmentId, status] of statuses) reconcileTrellisTrashed(environmentId, status);
  }, [statuses]);
  // Active lead and worker threads per project; a fork worker's lead is in another project.
  const activeThreads = useMemo(() => {
    const projectOf = new Map(
      threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread.projectId]),
    );
    const counts = new Map<string, { leads: number; workers: number; forkWorkers: number }>();
    for (const thread of threads) {
      if (thread.archivedAt !== null) continue;
      const key = `${thread.environmentId}:${thread.projectId}`;
      const entry = counts.get(key) ?? { leads: 0, workers: 0, forkWorkers: 0 };
      if (thread.lineage.relationshipToParent === "subagent") {
        entry.workers += 1;
        const parent = thread.lineage.parentThreadId;
        const leadProject =
          parent === null ? undefined : projectOf.get(`${thread.environmentId}:${parent}`);
        if (leadProject !== undefined && leadProject !== thread.projectId) entry.forkWorkers += 1;
      } else entry.leads += 1;
      counts.set(key, entry);
    }
    return counts;
  }, [threads]);
  const candidates = useMemo(
    () =>
      statuses.size === 0
        ? []
        : projects.filter((project) => {
            if (keepTrashedHere && `${project.environmentId}:${project.id}` in trashedHere) {
              return false;
            }
            const status = statuses.get(project.environmentId);
            if (status === undefined) return false;
            const counts =
              activeThreads.get(`${project.environmentId}:${project.id}`) ?? NO_THREADS;
            const retired =
              status.retiredRoots === undefined || status.retiredRoots.length === 0
                ? undefined
                : new Set(status.retiredRoots);
            return (
              isHiddenRetiredProject(project, retired, counts.leads + counts.workers > 0, false) ||
              isHiddenWorkerProject(project, status, counts, false)
            );
          }),
    [activeThreads, keepTrashedHere, projects, statuses, trashedHere],
  );
  const draftKeys = useComposerDraftStore((store) =>
    candidates
      .filter(
        (project) =>
          store.getDraftThreadByProjectRef(scopeProjectRef(project.environmentId, project.id)) !==
          null,
      )
      .map((project) => `${project.environmentId}:${project.id}`)
      .join("\n"),
  );
  return useMemo(() => {
    if (candidates.length === 0) return projects;
    const withDrafts = new Set(draftKeys.split("\n"));
    const hidden = new Set(
      candidates
        .map((project) => `${project.environmentId}:${project.id}`)
        .filter((key) => !withDrafts.has(key)),
    );
    return projects.filter((project) => !hidden.has(`${project.environmentId}:${project.id}`));
  }, [candidates, draftKeys, projects]);
}
