import { isImportedAgentSessionMessageId } from "@t3tools/contracts";
import type { ThreadFeedEntry } from "../../lib/threadActivity";

/** Hide the old text-only import only while its replacement native history is visible. */
export function withoutReplacedImportedMessages(
  feed: ReadonlyArray<ThreadFeedEntry>,
  replacing: boolean,
): ReadonlyArray<ThreadFeedEntry> {
  return replacing
    ? feed.filter(
        (entry) => entry.type !== "message" || !isImportedAgentSessionMessageId(entry.message.id),
      )
    : feed;
}
