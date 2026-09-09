import {
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationMessage,
  type SideChatChanges,
  type SideChatSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applySideChatStreamEvent } from "./sideChat.ts";

const at = "2026-09-08T12:00:00.000Z";
const parentThreadId = ThreadId.make("parent");
const message = (id: string, text: string): OrchestrationMessage => ({
  id: MessageId.make(id),
  role: "assistant",
  text,
  turnId: null,
  streaming: true,
  createdAt: at,
  updatedAt: at,
});
const snapshot = (sideChatId = "side"): SideChatSnapshot => ({
  parentThreadId,
  sideChatId,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  interactionMode: "default",
  runtimeMode: "approval-required",
  cwd: "/workspace",
  status: "ready",
  messages: [message("old", "Earlier reply"), message("current", "Hello")],
  activities: [],
  proposedPlans: [],
  pendingRequests: [],
  latestTurn: null,
});
const update = (previous: SideChatSnapshot | null, changes: SideChatChanges, sideChatId = "side") =>
  applySideChatStreamEvent(previous, { type: "update", parentThreadId, sideChatId, changes });

describe("side chat stream reconstruction", () => {
  it("bootstraps from a snapshot and replaces state on reconnect, including closure", () => {
    const first = snapshot();
    const replacement = { ...snapshot("replacement"), messages: [] };
    expect(applySideChatStreamEvent(null, { type: "snapshot", snapshot: first })).toBe(first);
    expect(applySideChatStreamEvent(first, { type: "snapshot", snapshot: replacement })).toBe(
      replacement,
    );
    expect(applySideChatStreamEvent(first, { type: "snapshot", snapshot: null })).toBeNull();
  });

  it("ignores updates before bootstrap and from stale side chats or other parents", () => {
    const first = snapshot();
    expect(update(null, { status: "running" })).toBeNull();
    expect(update(first, { status: "closed" }, "stale-side")).toBe(first);
    expect(
      applySideChatStreamEvent(first, {
        type: "update",
        parentThreadId: ThreadId.make("other-parent"),
        sideChatId: "side",
        changes: { status: "closed" },
      }),
    ).toBe(first);
  });

  it("appends streamed suffixes without retransmitting or replacing earlier messages", () => {
    const first = snapshot();
    const next = update(first, {
      status: "running",
      messageDeltas: [
        { id: MessageId.make("current"), delta: " world", updatedAt: at, streaming: true },
      ],
    });
    expect(next?.messages.map((entry) => entry.text)).toEqual(["Earlier reply", "Hello world"]);
    expect(next?.messages[0]).toBe(first.messages[0]);
    expect(first.messages[1]?.text).toBe("Hello");
    const settled = update(next, {
      messages: [{ ...message("current", "Hello world!"), streaming: false }],
    });
    expect(settled?.messages).toHaveLength(2);
    expect(settled?.messages[1]?.text).toBe("Hello world!");
    expect(settled?.messages[1]?.streaming).toBe(false);
  });

  it("upserts activity and plans in order and replaces resolved pending requests", () => {
    const first = snapshot();
    const activity = {
      id: EventId.make("activity"),
      tone: "info" as const,
      kind: "tool.started",
      summary: "Reading",
      payload: {},
      turnId: null,
      createdAt: at,
    };
    const plan = {
      id: "plan",
      turnId: null,
      planMarkdown: "First plan",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: at,
      updatedAt: at,
    };
    const next = update(first, {
      messages: [message("new", "New reply")],
      activities: [activity],
      proposedPlans: [plan],
      pendingRequests: [
        {
          eventId: EventId.make("request-event"),
          provider: ProviderDriverKind.make("codex"),
          threadId: parentThreadId,
          createdAt: at,
          requestId: RuntimeRequestId.make("request"),
          type: "request.opened",
          payload: { requestType: "command_execution_approval" },
        },
      ],
    });
    expect(next?.messages.map((entry) => entry.id)).toEqual(["old", "current", "new"]);
    const settled = update(next, {
      activities: [{ ...activity, summary: "Read complete" }],
      proposedPlans: [{ ...plan, planMarkdown: "Revised plan" }],
      pendingRequests: [],
    });
    expect(settled?.activities).toEqual([{ ...activity, summary: "Read complete" }]);
    expect(settled?.proposedPlans).toEqual([{ ...plan, planMarkdown: "Revised plan" }]);
    expect(settled?.pendingRequests).toEqual([]);
  });

  it("removes a failed optimistic send while preserving history and subsequent retries", () => {
    const first = snapshot();
    const failed = { ...message("failed", "Retry this"), role: "user" as const };
    const withSend = { ...first, messages: [...first.messages, failed] };
    const rolledBack = update(withSend, {
      removedMessageIds: [failed.id],
      error: "Turn could not start",
    });
    expect(rolledBack?.messages).toEqual(first.messages);
    expect(rolledBack?.messages[0]).toBe(first.messages[0]);
    const retry = { ...failed, id: MessageId.make("retry") };
    const retried = update(rolledBack, { messages: [retry], error: null });
    expect(retried?.messages).toEqual([...first.messages, retry]);
    expect(withSend.messages).toHaveLength(3);
  });

  it("distinguishes an unchanged error from explicit clearing", () => {
    const first = { ...snapshot(), error: "Previous error" };
    expect(update(first, { status: "running" })).toMatchObject({
      error: "Previous error",
    });
    const next = update(first, { error: null, latestTurn: null });
    expect(next).not.toHaveProperty("error");
    expect(next?.latestTurn).toBeNull();
  });
});
