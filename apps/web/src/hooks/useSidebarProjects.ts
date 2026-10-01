import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { isHiddenRetiredProject } from "~/lib/trellis";
import { useProjects, useThreadShells } from "~/state/entities";
import { trellisEnvironment } from "~/state/trellis";

/**
 * The projects the sidebars list: every project, minus Trellis projects whose
 * item is in the trash and that have no active thread or draft. Their
 * archived conversations stay in Settings → Archive.
 */
export function useSidebarProjects(): ReadonlyArray<EnvironmentProject> {
  const projects = useProjects();
  const threads = useThreadShells();
  const environmentKey = [...new Set(projects.map((project) => project.environmentId))]
    .toSorted()
    .join("\n");
  const retiredAtom = useMemo(
    () =>
      Atom.make((get) => {
        const retired = new Map<EnvironmentId, ReadonlySet<string>>();
        for (const environmentId of environmentKey.split("\n")) {
          if (environmentId.length === 0) continue;
          const id = environmentId as EnvironmentId;
          const status = Option.getOrNull(
            AsyncResult.value(get(trellisEnvironment.status({ environmentId: id, input: {} }))),
          );
          if (status?.retiredRoots !== undefined && status.retiredRoots.length > 0) {
            retired.set(id, new Set(status.retiredRoots));
          }
        }
        return retired;
      }),
    [environmentKey],
  );
  const retired = useAtomValue(retiredAtom);
  const activeKeys = useMemo(
    () =>
      new Set(
        threads
          .filter((thread) => thread.archivedAt === null)
          .map((thread) => `${thread.environmentId}:${thread.projectId}`),
      ),
    [threads],
  );
  const candidates = useMemo(
    () =>
      retired.size === 0
        ? []
        : projects.filter((project) =>
            isHiddenRetiredProject(
              project,
              retired.get(project.environmentId),
              activeKeys.has(`${project.environmentId}:${project.id}`),
              false,
            ),
          ),
    [activeKeys, projects, retired],
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
