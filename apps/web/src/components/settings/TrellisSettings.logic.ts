import type { TrellisDetails, TrellisWorkspaceRef } from "@t3tools/contracts";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** `512 B`, `1.5 GB`, `120 GB`, `1 TB` (decimal multiples, as `df -H` shows them). */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const rounded = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

/**
 * A warning for details whose latest refresh failed while older ones are
 * still shown; null when they are current or there is nothing to show.
 */
export function staleDetailsNotice(input: {
  readonly hasData: boolean;
  readonly error: string | null;
  /** Epoch ms of the shown data. */
  readonly updatedAt: number;
  readonly formatTime?: (epochMs: number) => string;
}): string | null {
  if (!input.hasData || input.error === null) return null;
  const formatTime =
    input.formatTime ?? ((epochMs: number) => new Date(epochMs).toLocaleTimeString());
  return `Could not refresh: ${input.error}. Showing details from ${formatTime(input.updatedAt)}.`;
}

/**
 * How a base relates to its definition (`base_states`), for its row: a
 * description, whether it is worth rebuilding, and whether T3 may rebuild it
 * (only from its built-in definition: a `custom` one would be replaced).
 */
export function baseStateView(state: string | null): {
  readonly description: string | null;
  readonly warn: boolean;
  readonly rebuildable: boolean;
} {
  switch (state) {
    case "current":
      return { description: "Built from its current definition.", warn: false, rebuildable: true };
    case "stale":
      return {
        description:
          "Built from an older definition. Rebuild it so new workspaces get the current one.",
        warn: true,
        rebuildable: true,
      };
    case "unrecorded":
      return {
        description:
          "Its definition was not recorded when it was built; rebuild to be sure it is current.",
        warn: false,
        rebuildable: true,
      };
    case "custom":
      return {
        description: "Built from a custom definition; rebuild it with `trellis base build --file`.",
        warn: false,
        rebuildable: false,
      };
    default:
      return { description: null, warn: false, rebuildable: true };
  }
}

/** `0.1.0 (abc1234)`; null when Trellis does not report a version. */
export function trellisVersionText(
  details: Pick<TrellisDetails, "version" | "commit">,
): string | null {
  if (details.version === null) return details.commit;
  return details.commit === null ? details.version : `${details.version} (${details.commit})`;
}

/** The workspace's project name when T3 knows it, else its id. */
export const workspaceLabel = (workspace: TrellisWorkspaceRef): string =>
  workspace.name ?? workspace.id;
