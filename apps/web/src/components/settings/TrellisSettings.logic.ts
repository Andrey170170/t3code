import type { TrellisDetails, TrellisWorkspaceRef } from "@t3tools/contracts";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** `512 B`, `1.5 GB`, `120 GB`, `1 TB` (binary multiples, as `df -h` shows them). */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${BYTE_UNITS[unit]}`;
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
