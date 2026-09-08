import type { CodexHistoryItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const RecordValue = Schema.Record(Schema.String, Schema.Unknown);
const isRecord = Schema.is(RecordValue);

/** A bounded textual tool view; the original rich item remains available in the chat UI. */
export function summarizeNativeTaskItem(entry: typeof CodexHistoryItem.Type) {
  let remaining = 4096;
  let visited = 0;
  let truncated = false;
  const parts: string[] = [];
  const append = (text: string) => {
    if (text.length > remaining) truncated = true;
    parts.push(text.slice(0, remaining));
    remaining = Math.max(0, remaining - text.length);
  };
  const visit = (value: unknown, label: string, depth: number): void => {
    if (remaining === 0 || depth > 8 || visited++ > 128) {
      truncated = true;
      return;
    }
    if (typeof value === "string") {
      if (value.startsWith("data:image/") || value.startsWith("data:audio/")) {
        append("[Media available in the conversation history]\n");
        truncated = true;
      } else {
        append(`${label ? `${label}: ` : ""}${value}\n`);
      }
    } else if (Array.isArray(value)) {
      for (const item of value.slice(0, 50)) visit(item, label, depth + 1);
      if (value.length > 50) truncated = true;
    } else if (isRecord(value)) {
      const entries = Object.entries(value);
      for (const [key, item] of entries.slice(0, 50)) {
        if (key === "id" || key === "type" || key === "turnId") continue;
        visit(item, key === "text" ? "" : key, depth + 1);
      }
      if (entries.length > 50) truncated = true;
    }
  };
  visit(entry.item, "", 0);
  const type = typeof entry.item.type === "string" ? entry.item.type : "native";
  return {
    id: typeof entry.item.id === "string" ? entry.item.id : entry.turnId,
    role: type === "userMessage" ? "user" : type === "agentMessage" ? "assistant" : "tool",
    text: parts.join("").trim() || `[${type}]`,
    truncated,
  };
}
