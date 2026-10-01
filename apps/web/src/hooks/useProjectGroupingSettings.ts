import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { trellisKeepSeparate } from "~/lib/trellis";
import { type ProjectGroupingSettings, selectProjectGroupingSettings } from "~/logicalProject";
import { useProjects } from "~/state/entities";
import { trellisEnvironment } from "~/state/trellis";
import { useClientSettings } from "./useSettings";

/**
 * The project grouping settings every surface groups projects with: the
 * client settings, with Trellis workspaces kept apart. Each Trellis project
 * or fork is its own environment, so two clones of one repository there are
 * two projects (deleting one trashes only that one), not one grouped entry.
 */
export function useProjectGroupingSettings(): ProjectGroupingSettings {
  const base = useClientSettings(selectProjectGroupingSettings);
  // Keyed by content: status refreshes rebuild the map, and a new predicate
  // would regroup every list that uses it.
  const rootsKey = JSON.stringify([...useTrellisRootsByEnvironment()]);
  return useMemo(() => {
    const roots = new Map<EnvironmentId, ReadonlyArray<string>>(JSON.parse(rootsKey));
    return roots.size === 0 ? base : { ...base, keepSeparate: trellisKeepSeparate(roots) };
  }, [base, rootsKey]);
}

/** Every root Trellis projects may live under, per environment that has projects. */
function useTrellisRootsByEnvironment(): ReadonlyMap<EnvironmentId, ReadonlyArray<string>> {
  const projects = useProjects();
  const environmentKey = [...new Set(projects.map((project) => project.environmentId))]
    .toSorted()
    .join("\n");
  const rootsAtom = useMemo(
    () =>
      Atom.make((get) => {
        const roots = new Map<EnvironmentId, ReadonlyArray<string>>();
        for (const environmentId of environmentKey.split("\n")) {
          if (environmentId.length === 0) continue;
          const id = environmentId as EnvironmentId;
          const status = Option.getOrNull(
            AsyncResult.value(get(trellisEnvironment.status({ environmentId: id, input: {} }))),
          );
          const known = [
            ...new Set([...(status?.root ? [status.root] : []), ...(status?.knownRoots ?? [])]),
          ];
          if (known.length > 0) roots.set(id, known);
        }
        return roots;
      }),
    [environmentKey],
  );
  return useAtomValue(rootsAtom);
}
