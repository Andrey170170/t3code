import type {
  TrellisDetails,
  TrellisHistorySettings,
  TrellisHistoryValues,
  TrellisWorkspaceRef,
} from "@t3tools/contracts";

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

export type HistoryKey = keyof TrellisHistoryValues;
type HistoryUnit = "minute" | "hour" | "day";

/** `1 day`, `30 days`. */
const formatAmount = (value: number, unit: HistoryUnit): string =>
  `${value} ${unit}${value === 1 ? "" : "s"}`;

const KEPT_ANYWAY = "checkpoints, pinned snapshots and each workspace's latest";

/**
 * The history settings Settings shows, in display order: the timer, turn
 * snapshots, timer snapshots, then trash and incoming expiry. Each
 * description says what 0 means for that setting.
 */
export const HISTORY_SETTINGS: ReadonlyArray<{
  readonly key: HistoryKey;
  readonly title: string;
  readonly unit: HistoryUnit;
  readonly description: string;
}> = [
  {
    key: "timerMinutes",
    title: "Snapshot timer",
    unit: "minute",
    description:
      "How often running workspaces are snapshotted when their files changed. 0 turns the timer off.",
  },
  {
    key: "turnKeepAllDays",
    title: "Turn snapshots: keep all",
    unit: "day",
    description:
      "Every snapshot taken at a turn is kept this long. 0 starts thinning them at once.",
  },
  {
    key: "turnKeepDailyDays",
    title: "Turn snapshots: then one a day",
    unit: "day",
    description: `Then one a day is kept until this age; no shorter than keep all. 0 keeps none but ${KEPT_ANYWAY}.`,
  },
  {
    key: "timerKeepAllHours",
    title: "Timer snapshots: keep all",
    unit: "hour",
    description:
      "Every timer snapshot is kept this long, then one per 15 minutes up to a day. 0 starts thinning them at once.",
  },
  {
    key: "timerKeepHourlyDays",
    title: "Timer snapshots: then one an hour",
    unit: "day",
    description: `Then one an hour is kept until this age. 0 keeps none but ${KEPT_ANYWAY}.`,
  },
  {
    key: "ideaTrashDays",
    title: "Trashed ideas expire after",
    unit: "day",
    description: "Ideas in the trash are removed for good after this. 0 keeps them until purged.",
  },
  {
    key: "forkTrashDays",
    title: "Discarded forks expire after",
    unit: "day",
    description:
      "Discarded forks with nothing unmerged are removed for good after this. 0 keeps them until purged.",
  },
  {
    key: "incomingDays",
    title: "Incoming copies expire after",
    unit: "day",
    description:
      "Copies of fork work neither merged nor discarded are removed after this. 0 keeps them.",
  },
];

/** `Default: 30 days` when the value differs from a known default, else null. */
export function historyDefaultNote(
  value: number | undefined,
  defaultValue: number | undefined,
  unit: HistoryUnit,
): string | null {
  if (value === undefined || defaultValue === undefined || value === defaultValue) return null;
  return `Default: ${formatAmount(defaultValue, unit)}`;
}

/**
 * What committing `input` to the setting `key` does: nothing when it equals
 * the current value, a refusal unless it is a whole number of at least 0, else
 * the update to send (that key only). Bounds are Trellis's to check.
 */
export function historyEdit(
  key: HistoryKey,
  input: number | null,
  current: number | undefined,
):
  | { readonly kind: "unchanged" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "change"; readonly patch: TrellisHistoryValues } {
  if (input === null || !Number.isInteger(input) || input < 0) {
    return { kind: "invalid", message: "Enter a whole number, 0 or more." };
  }
  if (input === current) return { kind: "unchanged" };
  return { kind: "change", patch: { [key]: input } };
}

/** The notice after a save that shortens retention; null when nothing would go. */
export function wouldRemoveText(wouldRemove: number): string | null {
  if (wouldRemove <= 0) return null;
  return `The next thinning removes ${wouldRemove} snapshot${wouldRemove === 1 ? "" : "s"}.`;
}

/** The live snapshot total and its kinds, most first: `40 turn · 12 timer`. */
export function snapshotCountsText(snapshots: TrellisHistorySettings["snapshots"]): {
  readonly total: number;
  readonly byKind: string | null;
} {
  const entries = Object.entries(snapshots).toSorted(
    ([a, x], [b, y]) => y - x || a.localeCompare(b),
  );
  return {
    total: entries.reduce((sum, [, count]) => sum + count, 0),
    byKind:
      entries.length === 0 ? null : entries.map(([kind, count]) => `${count} ${kind}`).join(" · "),
  };
}

/** The last thinning run in words. */
export function lastThinningText(
  lastThinning: TrellisHistorySettings["lastThinning"],
  formatTime: (unixSeconds: number) => string,
): string {
  if (lastThinning === null) return "Not since Trellis started";
  const removed = `${lastThinning.removed} snapshot${lastThinning.removed === 1 ? "" : "s"}`;
  return `${formatTime(lastThinning.at)}, removed ${removed}`;
}
