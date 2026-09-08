import {
  MessageId,
  TurnId,
  type ChatAttachment,
  type ChatImageAttachment,
  type CodexThreadsHistoryResult,
  type OrchestrationMessage,
  type RuntimeItemStatus,
  type ToolLifecycleItemType,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const HISTORY_ID_PREFIX = "codex-history";
const FALLBACK_ANCHOR_MS = Date.UTC(2000, 0, 1);
const MAX_DETAIL_LENGTH = 12_000;
const SAFE_IMAGE_PREVIEW_URL = /^(?:https?:\/\/|data:image\/(?:avif|gif|jpe?g|png|webp);base64,)/iu;

type NativeItem = Readonly<Record<string, unknown>>;

export interface CodexHistoryMetadata {
  readonly source: "codex-native-history";
  readonly nativeTurnId: string;
  readonly nativeItemId: string | null;
  readonly newestFirstIndex: number;
  /** Codex history pages do not expose item timestamps. */
  readonly timestampKind: "synthetic-before-import" | "synthetic-order-only";
}

export interface CodexHistoryImageAttachment extends ChatImageAttachment {
  readonly previewUrl: string;
}

export type CodexHistoryAttachment = ChatAttachment | CodexHistoryImageAttachment;

export interface CodexHistoryMessage extends Omit<OrchestrationMessage, "attachments"> {
  readonly attachments?: ReadonlyArray<CodexHistoryAttachment>;
  readonly codexHistory: CodexHistoryMetadata;
}

export interface CodexHistoryWorkEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly turnId: TurnId;
  readonly label: string;
  readonly tone: "thinking" | "tool" | "info" | "error";
  readonly detail?: string;
  readonly command?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly viewedImagePath?: string;
  readonly toolTitle?: string;
  readonly toolData: NativeItem;
  readonly itemType?: ToolLifecycleItemType;
  readonly toolCallId?: string;
  readonly toolLifecycleStatus?: RuntimeItemStatus | "stopped";
  readonly codexHistory: CodexHistoryMetadata;
}

export interface CodexHistoryProjection {
  readonly messages: ReadonlyArray<CodexHistoryMessage>;
  readonly workEntries: ReadonlyArray<CodexHistoryWorkEntry>;
}

function asRecord(value: unknown): NativeItem | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as NativeItem)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncate(value: string): string {
  return value.length <= MAX_DETAIL_LENGTH
    ? value
    : `${value.slice(0, MAX_DETAIL_LENGTH - 1).trimEnd()}…`;
}

function serializeDetail(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized === undefined ? null : truncate(serialized);
  } catch {
    return "Native item details could not be displayed.";
  }
}

function nativeType(item: NativeItem): string {
  return nonEmptyString(item.type) ?? "unknown";
}

function humanizeType(value: string): string {
  const label = value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[._/-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return label.length > 0 ? `${label[0]!.toUpperCase()}${label.slice(1)}` : "Unknown item";
}

function canonicalItemType(type: string): ToolLifecycleItemType | undefined {
  const normalized = type.replace(/[._/-]/gu, "").toLowerCase();
  if (normalized.includes("command")) return "command_execution";
  if (normalized.includes("filechange") || normalized.includes("patch")) return "file_change";
  if (normalized.includes("mcp")) return "mcp_tool_call";
  if (normalized.includes("dynamictool")) return "dynamic_tool_call";
  if (normalized.includes("collab")) return "collab_agent_tool_call";
  if (normalized.includes("websearch")) return "web_search";
  if (normalized.includes("image")) return "image_view";
  return undefined;
}

function isMessageType(type: string): "user" | "assistant" | null {
  const normalized = type.replace(/[._/-]/gu, "").toLowerCase();
  if (normalized === "usermessage") return "user";
  if (normalized === "agentmessage" || normalized === "assistantmessage") return "assistant";
  return null;
}

function projectedId(turnId: string, item: NativeItem, newestFirstIndex: number): string {
  const encodedTurnId = encodeURIComponent(turnId);
  const nativeId = nonEmptyString(item.id);
  return nativeId
    ? `${HISTORY_ID_PREFIX}:${encodedTurnId}:item:${encodeURIComponent(nativeId)}`
    : `${HISTORY_ID_PREFIX}:${encodedTurnId}:index:${newestFirstIndex}`;
}

function attachmentId(messageId: string, contentIndex: number): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < messageId.length; index += 1) {
    hash = Math.imul(hash ^ messageId.charCodeAt(index), 16_777_619);
  }
  return `codex_history_${(hash >>> 0).toString(36)}_${contentIndex}`;
}

function projectedTimestamp(result: CodexThreadsHistoryResult, newestFirstIndex: number): string {
  const importedAtMs = result.boundary ? Date.parse(result.boundary.importedAt) : Number.NaN;
  const anchorMs = Number.isFinite(importedAtMs) ? importedAtMs : FALLBACK_ANCHOR_MS;
  return DateTime.formatIso(DateTime.makeUnsafe(anchorMs - newestFirstIndex - 1));
}

function metadataFor(
  result: CodexThreadsHistoryResult,
  turnId: string,
  item: NativeItem,
  newestFirstIndex: number,
): CodexHistoryMetadata {
  return {
    source: "codex-native-history",
    nativeTurnId: turnId,
    nativeItemId: nonEmptyString(item.id),
    newestFirstIndex,
    timestampKind: result.boundary ? "synthetic-before-import" : "synthetic-order-only",
  };
}

function imageMimeType(url: string): string {
  const dataMimeType = /^data:(image\/[a-z0-9.+-]+);base64,/iu.exec(url)?.[1];
  if (dataMimeType) return dataMimeType.toLowerCase();
  const path = url.split(/[?#]/u, 1)[0]?.toLowerCase() ?? "";
  if (path.endsWith(".avif")) return "image/avif";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".jpeg") || path.endsWith(".jpg")) return "image/jpeg";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  return "image/*";
}

function imageName(url: string, index: number): string {
  if (url.startsWith("data:")) return `codex-history-image-${index + 1}`;
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
    return name.trim().slice(0, 255) || `codex-history-image-${index + 1}`;
  } catch {
    return `codex-history-image-${index + 1}`;
  }
}

function imageUrlFromContent(content: NativeItem): string | null {
  const url =
    nonEmptyString(content.url) ??
    nonEmptyString(content.imageUrl) ??
    nonEmptyString(content.image_url);
  return url && SAFE_IMAGE_PREVIEW_URL.test(url) ? url : null;
}

function describeNonTextContent(content: NativeItem): string | null {
  const type = nativeType(content);
  if (type === "image" || type === "localImage") {
    const location =
      nonEmptyString(content.path) ??
      nonEmptyString(content.url) ??
      nonEmptyString(content.imageUrl) ??
      nonEmptyString(content.image_url);
    return location ? `Image: ${location}` : "Image attachment";
  }
  if (type === "audio" || type === "localAudio") {
    const location = nonEmptyString(content.path) ?? nonEmptyString(content.url);
    return location ? `Audio: ${location}` : "Audio attachment";
  }
  if (type === "skill" || type === "mention") {
    const name = nonEmptyString(content.name);
    const path = nonEmptyString(content.path);
    return [humanizeType(type), name, path].filter(Boolean).join(": ");
  }
  return serializeDetail(content);
}

function projectMessageContent(
  messageId: string,
  item: NativeItem,
): { readonly text: string; readonly attachments: ReadonlyArray<CodexHistoryImageAttachment> } {
  const content = Array.isArray(item.content) ? item.content : null;
  if (content === null) {
    return { text: typeof item.text === "string" ? item.text : "", attachments: [] };
  }

  const text: string[] = [];
  const attachments: CodexHistoryImageAttachment[] = [];
  let hasStructuredText = false;
  for (const [index, value] of content.entries()) {
    if (typeof value === "string") {
      text.push(value);
      hasStructuredText = true;
      continue;
    }
    const part = asRecord(value);
    if (!part) {
      text.push(serializeDetail(value) ?? String(value));
      continue;
    }
    if (nativeType(part) === "text" && typeof part.text === "string") {
      text.push(part.text);
      hasStructuredText = true;
      continue;
    }
    const imageUrl = imageUrlFromContent(part);
    if (imageUrl) {
      attachments.push({
        type: "image",
        id: attachmentId(messageId, index),
        name: imageName(imageUrl, index),
        mimeType: imageMimeType(imageUrl),
        sizeBytes: 0,
        previewUrl: imageUrl,
      });
      continue;
    }
    const description = describeNonTextContent(part);
    if (description) text.push(description);
  }
  if (!hasStructuredText && typeof item.text === "string") text.unshift(item.text);
  return { text: text.join("\n\n"), attachments };
}

function statusFor(item: NativeItem): RuntimeItemStatus | "stopped" {
  if (typeof item.exitCode === "number" && item.exitCode !== 0) return "failed";
  const status = nonEmptyString(item.status);
  if (
    status === "inProgress" ||
    status === "completed" ||
    status === "failed" ||
    status === "declined" ||
    status === "stopped"
  ) {
    return status;
  }
  return "completed";
}

function changedFiles(item: NativeItem): ReadonlyArray<string> {
  if (!Array.isArray(item.changes)) return [];
  return item.changes.flatMap((change) => {
    const path = asRecord(change) ? nonEmptyString(asRecord(change)?.path) : null;
    return path ? [path] : [];
  });
}

function reasoningDetail(item: NativeItem): string | null {
  for (const value of [item.summary, item.content]) {
    if (!Array.isArray(value)) continue;
    const parts = value.filter((part): part is string => typeof part === "string");
    if (parts.length > 0) return truncate(parts.join("\n\n"));
  }
  return null;
}

function workDetail(type: string, item: NativeItem): string | null {
  if (type === "reasoning") return reasoningDetail(item) ?? serializeDetail(item);
  if (type === "commandExecution") {
    return nonEmptyString(item.aggregatedOutput) ?? nonEmptyString(item.cwd);
  }
  if (type === "fileChange") {
    const files = changedFiles(item);
    return files.length > 0 ? files.join("\n") : serializeDetail(item);
  }
  if (type === "mcpToolCall") {
    const error = asRecord(item.error);
    return nonEmptyString(error?.message) ?? serializeDetail(item.result ?? item.arguments);
  }
  if (type === "dynamicToolCall") {
    return serializeDetail(item.contentItems ?? item.arguments);
  }
  return (
    nonEmptyString(item.text) ??
    nonEmptyString(item.review) ??
    nonEmptyString(item.query) ??
    nonEmptyString(item.path) ??
    nonEmptyString(item.result) ??
    serializeDetail(item)
  );
}

function workLabel(type: string, item: NativeItem): string {
  if (type === "reasoning") return "Reasoning";
  if (type === "systemMessage") return "System message";
  if (type === "plan") return "Plan";
  if (type === "commandExecution") return "Ran command";
  if (type === "fileChange") return "Changed files";
  if (type === "mcpToolCall") {
    const server = nonEmptyString(item.server);
    const tool = nonEmptyString(item.tool);
    if (server && tool) return `${server} · ${tool}`;
    return "MCP tool call";
  }
  if (type === "dynamicToolCall") return nonEmptyString(item.tool) ?? "Tool call";
  if (type === "webSearch") return "Searched the web";
  if (type === "imageView") return "Viewed image";
  if (type === "imageGeneration") return "Generated image";
  if (type === "contextCompaction") return "Compacted context";
  if (type === "enteredReviewMode") return "Entered review mode";
  if (type === "exitedReviewMode") return "Exited review mode";
  return humanizeType(type);
}

function projectMessage(
  result: CodexThreadsHistoryResult,
  turnId: string,
  item: NativeItem,
  newestFirstIndex: number,
  role: "user" | "assistant",
): CodexHistoryMessage {
  const id = projectedId(turnId, item, newestFirstIndex);
  const createdAt = projectedTimestamp(result, newestFirstIndex);
  const content = projectMessageContent(id, item);
  return {
    id: MessageId.make(id),
    role,
    text: content.text,
    ...(content.attachments.length > 0 ? { attachments: content.attachments } : {}),
    turnId: TurnId.make(turnId),
    streaming: false,
    createdAt,
    updatedAt: createdAt,
    codexHistory: metadataFor(result, turnId, item, newestFirstIndex),
  };
}

function projectWorkEntry(
  result: CodexThreadsHistoryResult,
  turnId: string,
  item: NativeItem,
  newestFirstIndex: number,
): CodexHistoryWorkEntry {
  const type = nativeType(item);
  const itemType = canonicalItemType(type);
  const lifecycleStatus = itemType ? statusFor(item) : undefined;
  const files = itemType === "file_change" ? changedFiles(item) : [];
  const command = itemType === "command_execution" ? nonEmptyString(item.command) : null;
  const viewedImagePath = itemType === "image_view" ? nonEmptyString(item.path) : null;
  const toolCallId = itemType ? nonEmptyString(item.id) : null;
  const status = lifecycleStatus ?? "completed";
  const detail = workDetail(type, item);
  return {
    id: projectedId(turnId, item, newestFirstIndex),
    createdAt: projectedTimestamp(result, newestFirstIndex),
    turnId: TurnId.make(turnId),
    label: workLabel(type, item),
    tone:
      status === "failed"
        ? "error"
        : type === "reasoning"
          ? "thinking"
          : itemType
            ? "tool"
            : "info",
    ...(detail ? { detail: truncate(detail) } : {}),
    ...(command ? { command } : {}),
    ...(files.length > 0 ? { changedFiles: files } : {}),
    ...(viewedImagePath ? { viewedImagePath } : {}),
    ...(type === "mcpToolCall" || type === "dynamicToolCall"
      ? { toolTitle: workLabel(type, item) }
      : {}),
    toolData: item,
    ...(itemType ? { itemType } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(lifecycleStatus ? { toolLifecycleStatus: lifecycleStatus } : {}),
    codexHistory: metadataFor(result, turnId, item, newestFirstIndex),
  };
}

/** Projects newest-first native pages into the chronological arrays consumed by chat timelines. */
export function projectCodexHistory(result: CodexThreadsHistoryResult): CodexHistoryProjection {
  const messages: CodexHistoryMessage[] = [];
  const workEntries: CodexHistoryWorkEntry[] = [];
  for (
    let newestFirstIndex = result.items.length - 1;
    newestFirstIndex >= 0;
    newestFirstIndex -= 1
  ) {
    const entry = result.items[newestFirstIndex]!;
    const role = isMessageType(nativeType(entry.item));
    if (role) {
      messages.push(projectMessage(result, entry.turnId, entry.item, newestFirstIndex, role));
    } else {
      workEntries.push(projectWorkEntry(result, entry.turnId, entry.item, newestFirstIndex));
    }
  }
  return { messages, workEntries };
}
