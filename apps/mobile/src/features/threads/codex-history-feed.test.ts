import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { mergeCodexHistoryFeed } from "./codex-history-feed";

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

describe("Codex history feed", () => {
  it("replaces legacy previews, preserves live rows, and prepends native history", () => {
    const native = message("codex-history:message:native");
    const imported = message("import:codex:native:000001");
    const live = message("live-user-message");

    expect(mergeCodexHistoryFeed([imported, live], [native], true)).toEqual([native, live]);
    expect(mergeCodexHistoryFeed([imported, live], [native], false)).toEqual([
      native,
      imported,
      live,
    ]);
  });

  it("keeps a live T3 row when projected history has the same id", () => {
    const historical = message("shared-id");
    const live = { ...message("shared-id"), createdAt: "2026-09-08T11:00:00.000Z" };

    expect(mergeCodexHistoryFeed([live], [historical], false)).toEqual([live]);
  });
});
