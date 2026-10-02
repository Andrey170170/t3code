import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type SideChatSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { applySideChatStreamEvent } from "./sideChat.ts";

const now = DateTime.makeUnsafe("2026-10-01T12:00:00.000Z");
const sideChatId = ThreadId.make("side");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

function assistant(id: string, text: string): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(id),
    threadId: sideChatId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "running",
    title: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    type: "assistant_message",
    messageId: MessageId.make(id),
    text,
    streaming: true,
  };
}

function request(
  id: string,
  status: OrchestrationV2RuntimeRequest["status"],
): OrchestrationV2RuntimeRequest {
  return {
    id: RuntimeRequestId.make(id),
    nodeId: NodeId.make("node"),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "command",
    status,
    responseCapability: { type: "message" },
    createdAt: now,
    resolvedAt: null,
  };
}

const snapshot = (id = sideChatId): SideChatSnapshot => ({
  sideChatId: id,
  parentThreadId: ThreadId.make("parent"),
  status: "idle",
  modelSelection,
  interactionMode: "default",
  runtimeMode: "approval-required",
  cwd: "/workspace",
  turnItems: [assistant("first", "Earlier"), assistant("second", "Hel")],
  runtimeRequests: [request("approval", "pending")],
  activeProviderTurnId: null,
});

describe("applySideChatStreamEvent", () => {
  it("replaces state on each snapshot, including after reconnect", () => {
    const first = snapshot();
    const replacement = { ...snapshot(), turnItems: [] };
    expect(applySideChatStreamEvent(null, { type: "snapshot", snapshot: first })).toBe(first);
    expect(applySideChatStreamEvent(first, { type: "snapshot", snapshot: replacement })).toBe(
      replacement,
    );
  });

  it("ignores frames before the snapshot and frames for another side chat", () => {
    const first = snapshot();
    const closed = { type: "closed", sideChatId } as const;
    expect(applySideChatStreamEvent(null, closed)).toBeNull();
    expect(
      applySideChatStreamEvent(first, { type: "closed", sideChatId: ThreadId.make("other") }),
    ).toBe(first);
  });

  it("upserts turn items and requests in first-seen order", () => {
    let state = applySideChatStreamEvent(snapshot(), {
      type: "turn-item",
      sideChatId,
      turnItem: assistant("second", "Hello"),
    });
    state = applySideChatStreamEvent(state, {
      type: "turn-item",
      sideChatId,
      turnItem: assistant("third", "New"),
    });
    state = applySideChatStreamEvent(state, {
      type: "runtime-request",
      sideChatId,
      runtimeRequest: request("approval", "resolved"),
    });
    expect(
      state?.turnItems.map((item) => [item.id, item.type === "assistant_message" && item.text]),
    ).toEqual([
      ["first", "Earlier"],
      ["second", "Hello"],
      ["third", "New"],
    ]);
    expect(state?.runtimeRequests.map((entry) => entry.status)).toEqual(["resolved"]);
  });

  it("replaces scalar state on status frames and clears an absent error", () => {
    const turnId = ProviderTurnId.make("turn");
    const failed = applySideChatStreamEvent(snapshot(), {
      type: "status",
      sideChatId,
      status: "error",
      activeProviderTurnId: null,
      modelSelection,
      interactionMode: "default",
      runtimeMode: "approval-required",
      error: "Codex stopped",
    });
    expect(failed?.error).toBe("Codex stopped");
    const running = applySideChatStreamEvent(failed, {
      type: "status",
      sideChatId,
      status: "running",
      activeProviderTurnId: turnId,
      modelSelection: { ...modelSelection, model: "gpt-5.5" },
      interactionMode: "plan",
      runtimeMode: "full-access",
    });
    expect(running).toMatchObject({
      status: "running",
      activeProviderTurnId: turnId,
      modelSelection: { model: "gpt-5.5" },
      interactionMode: "plan",
      runtimeMode: "full-access",
    });
    expect(running && "error" in running).toBe(false);
    expect(applySideChatStreamEvent(running, { type: "closed", sideChatId })?.status).toBe(
      "closed",
    );
  });
});
