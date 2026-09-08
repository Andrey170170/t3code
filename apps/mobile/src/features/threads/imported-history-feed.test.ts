import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { withoutReplacedImportedMessages } from "./imported-history-feed";

const message = (id: string): ThreadFeedEntry => ({
  type: "message",
  id,
  createdAt: "2026-09-08T10:00:00.000Z",
  message: {
    id: MessageId.make(id),
    role: "user",
    text: "Continue",
    turnId: null,
    streaming: false,
    createdAt: "2026-09-08T10:00:00.000Z",
    updatedAt: "2026-09-08T10:00:00.000Z",
  },
});

describe("upgraded import visibility", () => {
  it("preserves live messages and activity while hiding only reserved imported copies", () => {
    const imported = message("import:codex:native:000001");
    const live = message("new-user-message");
    const activity: ThreadFeedEntry = {
      type: "thinking",
      id: "activity",
      createdAt: "2026-09-08T10:00:00.000Z",
      turnId: null,
    };
    const feed = [imported, live, activity];
    expect(withoutReplacedImportedMessages(feed, true)).toEqual([live, activity]);
    expect(withoutReplacedImportedMessages(feed, false)).toBe(feed);
  });
});
