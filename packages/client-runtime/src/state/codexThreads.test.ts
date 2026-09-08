import { describe, expect, it } from "vite-plus/test";
import { withoutLegacyHistoryPreviews } from "./codexThreads.ts";

describe("native history replaces legacy previews", () => {
  const messages = [
    { id: "import:codex:old:user", text: "Original prompt" },
    { id: "import:codex:old:assistant", text: "Original reply" },
    { id: "live-user", text: "Continue in T3" },
    { id: "live-assistant", text: "New reply" },
    { id: "agent-followup", text: "Delegated follow-up" },
  ];
  it("keeps all T3 continuation and delegated messages when the original history is visible", () => {
    expect(withoutLegacyHistoryPreviews(messages, true)).toEqual(messages.slice(2));
  });
  it("restores the existing preview without copying when history is closed or unavailable", () => {
    expect(withoutLegacyHistoryPreviews(messages, false)).toBe(messages);
  });
});
