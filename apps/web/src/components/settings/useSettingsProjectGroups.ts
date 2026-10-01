import { useMemo } from "react";

import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useProjectGroupingSettings } from "../../hooks/useProjectGroupingSettings";

/** Settings uses the same logical projects as the sidebar, sorted by display name. */
export function useSettingsProjectGroups() {
  const projects = useProjects();
  const settings = useProjectGroupingSettings();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  return useMemo(() => {
    const labels = new Map(environments.map((entry) => [entry.environmentId, entry.label]));
    return buildSidebarProjectSnapshots({
      projects,
      settings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (id) => labels.get(id) ?? null,
    }).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [environments, primaryEnvironmentId, projects, settings]);
}
