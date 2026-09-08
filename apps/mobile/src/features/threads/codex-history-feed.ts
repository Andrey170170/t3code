import { withoutLegacyHistoryPreviews } from "@t3tools/client-runtime/state/codex-threads";
import type { ThreadFeedEntry } from "../../lib/threadActivity";

/** Prepend native rows while keeping live T3 rows authoritative on any id collision. */
export function mergeCodexHistoryFeed(
  feed: ReadonlyArray<ThreadFeedEntry>,
  history: ReadonlyArray<ThreadFeedEntry>,
  replacesLegacyMessages: boolean,
): ReadonlyArray<ThreadFeedEntry> {
  const liveFeed = withoutLegacyHistoryPreviews(feed, replacesLegacyMessages);
  if (history.length === 0) return liveFeed;

  const liveIds = new Set(liveFeed.map((entry) => entry.id));
  return [...history.filter((entry) => !liveIds.has(entry.id)), ...liveFeed];
}
