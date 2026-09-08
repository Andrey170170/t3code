import { describe, expect, it } from "vite-plus/test";
import type { CodexThreadsHistoryResult } from "@t3tools/contracts";
import { projectCodexHistory } from "./codexHistoryProjection.ts";

const importedAt = "2026-09-08T18:00:00.000Z";

function history(
  items: CodexThreadsHistoryResult["items"],
  boundary: CodexThreadsHistoryResult["boundary"] = {
    nativeThreadId: "native-thread",
    importedAt,
    replacesLegacyMessages: true,
  },
): CodexThreadsHistoryResult {
  return {
    imported: true,
    boundary,
    items,
    nextCursor: null,
  };
}

describe("Codex native history projection", () => {
  it("restores chronological timeline order from newest-first pages", () => {
    const projected = projectCodexHistory(
      history([
        {
          turnId: "turn-new",
          item: { id: "answer", type: "agentMessage", text: "Newest answer" },
        },
        {
          turnId: "turn-new",
          item: {
            id: "command",
            type: "commandExecution",
            command: "pwd",
            status: "completed",
          },
        },
        {
          turnId: "turn-old",
          item: { id: "question", type: "userMessage", content: [{ type: "text", text: "Old" }] },
        },
      ]),
    );

    const timelineIds = [...projected.messages, ...projected.workEntries]
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((entry) => entry.id);
    expect(timelineIds).toEqual([
      "codex-history:turn-old:item:question",
      "codex-history:turn-new:item:command",
      "codex-history:turn-new:item:answer",
    ]);
    expect(projected.messages.map((message) => message.text)).toEqual(["Old", "Newest answer"]);
    expect(projected.workEntries[0]).toMatchObject({ command: "pwd", label: "Ran command" });
  });

  it("keeps loaded row IDs and synthetic timestamps stable when an older page is appended", () => {
    const firstItems = [
      { turnId: "turn-2", item: { id: "native-2", type: "agentMessage", text: "two" } },
      { turnId: "turn-1", item: { type: "userMessage", text: "one" } },
    ];
    const first = projectCodexHistory(history(firstItems));
    const withOlderPage = projectCodexHistory(
      history([...firstItems, { turnId: "turn-0", item: { type: "agentMessage", text: "zero" } }]),
    );

    const firstByText = new Map(first.messages.map((message) => [message.text, message]));
    for (const message of withOlderPage.messages.filter((entry) => entry.text !== "zero")) {
      expect(message.id).toBe(firstByText.get(message.text)?.id);
      expect(message.createdAt).toBe(firstByText.get(message.text)?.createdAt);
    }
    expect(firstByText.get("one")?.id).toBe("codex-history:turn-1:index:1");
    expect(withOlderPage.messages.map((message) => message.text)).toEqual(["zero", "one", "two"]);
  });

  it("uses structured message content once and projects safe image previews", () => {
    const result = projectCodexHistory(
      history([
        {
          turnId: "turn-user",
          item: {
            id: "user",
            type: "userMessage",
            text: "duplicate fallback",
            content: [
              { type: "text", text: "Canonical prompt" },
              { type: "image", url: "data:image/png;base64,AAAA" },
              { type: "localImage", path: "/repo/private.png" },
            ],
          },
        },
        {
          turnId: "turn-system",
          item: { id: "system", type: "systemMessage", text: "System context" },
        },
      ]),
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe("Canonical prompt\n\nImage: /repo/private.png");
    expect(result.messages[0]?.text).not.toContain("duplicate fallback");
    expect(result.messages[0]?.attachments).toEqual([
      expect.objectContaining({
        type: "image",
        mimeType: "image/png",
        previewUrl: "data:image/png;base64,AAAA",
      }),
    ]);
    expect(result.messages[0]?.attachments?.[0]?.id).toMatch(/^[a-z0-9_-]{1,128}$/i);
    expect(result.workEntries[0]).toMatchObject({
      label: "System message",
      detail: "System context",
      tone: "info",
      toolData: expect.objectContaining({ type: "systemMessage", text: "System context" }),
    });
  });

  it("retains command, reasoning, file-change, tool, and unknown item details", () => {
    const unknown = {
      id: "future",
      type: "futureRichTool",
      nested: { values: [1, true, null] },
    };
    const projected = projectCodexHistory(
      history([
        { turnId: "turn", item: unknown },
        {
          turnId: "turn",
          item: {
            id: "mcp",
            type: "mcpToolCall",
            server: "browser",
            tool: "open",
            arguments: { url: "https://example.test" },
            result: { content: [{ type: "text", text: "done" }] },
            status: "completed",
          },
        },
        {
          turnId: "turn",
          item: {
            id: "files",
            type: "fileChange",
            status: "completed",
            changes: [
              { path: "src/a.ts", kind: "update", diff: "+a" },
              { path: "src/b.ts", kind: "add", diff: "+b" },
            ],
          },
        },
        {
          turnId: "turn",
          item: { id: "reason", type: "reasoning", summary: ["Checked assumptions"] },
        },
        {
          turnId: "turn",
          item: {
            id: "command",
            type: "commandExecution",
            command: "false",
            aggregatedOutput: "failed output",
            status: "completed",
            exitCode: 1,
          },
        },
      ]),
    );

    expect(projected.workEntries).toHaveLength(5);
    expect(projected.workEntries.find((entry) => entry.command === "false")).toMatchObject({
      detail: "failed output",
      itemType: "command_execution",
      tone: "error",
      toolLifecycleStatus: "failed",
    });
    expect(
      projected.workEntries.find((entry) => entry.itemType === "file_change")?.changedFiles,
    ).toEqual(["src/a.ts", "src/b.ts"]);
    expect(projected.workEntries.find((entry) => entry.label === "Reasoning")?.detail).toBe(
      "Checked assumptions",
    );
    expect(projected.workEntries.find((entry) => entry.itemType === "mcp_tool_call")).toMatchObject(
      {
        label: "browser · open",
        toolData: expect.objectContaining({ arguments: { url: "https://example.test" } }),
      },
    );
    expect(projected.workEntries.find((entry) => entry.label === "Future Rich Tool")).toMatchObject(
      {
        detail: expect.stringContaining('"values"'),
        toolData: unknown,
      },
    );
  });

  it("marks generated chronology as synthetic and keeps every timestamp before the import", () => {
    const projected = projectCodexHistory(
      history([
        { turnId: "turn", item: { id: "answer", type: "agentMessage", text: "Answer" } },
        { turnId: "turn", item: { id: "plan", type: "plan", text: "Plan" } },
      ]),
    );
    const rows = [...projected.messages, ...projected.workEntries];

    expect(rows.every((row) => row.createdAt < importedAt)).toBe(true);
    expect(rows.every((row) => row.codexHistory.timestampKind === "synthetic-before-import")).toBe(
      true,
    );
    expect(rows.map((row) => row.codexHistory.newestFirstIndex).toSorted()).toEqual([0, 1]);
    expect(projected.messages[0]).toMatchObject({
      streaming: false,
      turnId: "turn",
      updatedAt: projected.messages[0]?.createdAt,
      codexHistory: {
        source: "codex-native-history",
        nativeTurnId: "turn",
        nativeItemId: "answer",
      },
    });

    const withoutBoundary = projectCodexHistory(
      history([{ turnId: "turn", item: { type: "agentMessage", text: "Unanchored" } }], null),
    );
    expect(withoutBoundary.messages[0]?.codexHistory.timestampKind).toBe("synthetic-order-only");
  });
});
