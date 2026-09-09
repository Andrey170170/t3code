import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type SideChatSnapshot,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { applySideChatEvent, closeSideChatSnapshot, sideChatStreamEvent } from "./sideChatState.ts";

const now = "2026-09-08T00:00:00.000Z";
const snapshot: SideChatSnapshot = {
  parentThreadId: ThreadId.make("parent"),
  sideChatId: "side",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  interactionMode: "default",
  runtimeMode: "full-access",
  cwd: "/tmp",
  status: "ready",
  messages: [],
  activities: [],
  proposedPlans: [],
  pendingRequests: [],
  latestTurn: null,
};
const base = {
  eventId: EventId.make("event"),
  provider: ProviderDriverKind.make("codex"),
  threadId: snapshot.parentThreadId,
  createdAt: now,
  turnId: TurnId.make("turn"),
  itemId: RuntimeItemId.make("answer"),
};

function event(
  payload: Extract<ProviderRuntimeEvent, { type: "content.delta" }>["payload"],
): ProviderRuntimeEvent {
  return { ...base, type: "content.delta", payload };
}

describe("ephemeral side chat projection", () => {
  it("reconciles completed native items by id without duplicating deltas or replayed answers", () => {
    const streamed = applySideChatEvent(
      snapshot,
      event({ streamKind: "assistant_text", delta: "Hello" }),
    );
    const completed: ProviderRuntimeEvent = {
      ...base,
      type: "item.completed",
      payload: { itemType: "assistant_message", detail: "Hello world" },
    };
    const once = applySideChatEvent(streamed, completed);
    const twice = applySideChatEvent(once, completed);
    expect(twice.messages).toHaveLength(1);
    expect(twice.messages[0]).toMatchObject({ text: "Hello world", streaming: false });
  });

  it("sends only the missing suffix after coalescing intermediate snapshots", () => {
    const old = applySideChatEvent(
      snapshot,
      event({ streamKind: "assistant_text", delta: "Hello" }),
    );
    const middle = applySideChatEvent(old, event({ streamKind: "assistant_text", delta: ", " }));
    const latest = applySideChatEvent(
      middle,
      event({ streamKind: "assistant_text", delta: "world" }),
    );
    const patch = sideChatStreamEvent(old, latest);
    expect(patch).toEqual({
      type: "update",
      parentThreadId: snapshot.parentThreadId,
      sideChatId: "side",
      changes: {
        messageDeltas: [
          { id: MessageId.make("side:answer"), delta: ", world", updatedAt: now, streaming: true },
        ],
      },
    });
    expect(JSON.stringify(patch)).not.toContain("Hello");
  });

  it("uses a replacement when a completed answer revises already streamed text", () => {
    const old = applySideChatEvent(snapshot, event({ streamKind: "assistant_text", delta: "Old" }));
    const revised = applySideChatEvent(old, {
      ...base,
      type: "item.completed",
      payload: { itemType: "assistant_message", detail: "Revised" },
    });
    const patch = sideChatStreamEvent(old, revised);
    expect(patch.type === "update" ? patch.changes.messages?.[0]?.text : undefined).toBe("Revised");
    expect(patch.type === "update" ? patch.changes.messageDeltas : undefined).toBeUndefined();
  });

  it("replaces the generation with a snapshot and closes streaming state", () => {
    const running = applySideChatEvent(
      applySideChatEvent(snapshot, { ...base, type: "turn.started", payload: {} }),
      event({ streamKind: "assistant_text", delta: "Hello" }),
    );
    const closed = closeSideChatSnapshot(running);
    expect(closed.status).toBe("closed");
    expect(closed.messages[0]?.streaming).toBe(false);
    expect(closed.latestTurn?.state).toBe("interrupted");
    expect(sideChatStreamEvent(closed, { ...snapshot, sideChatId: "new-side" }).type).toBe(
      "snapshot",
    );
  });

  it("settles request activities together with pending requests on interruption and close", () => {
    const requested = applySideChatEvent(snapshot, {
      ...base,
      type: "request.opened",
      requestId: RuntimeRequestId.make("approval"),
      payload: { requestType: "command_execution_approval" },
    });
    const interrupted = applySideChatEvent(requested, {
      ...base,
      type: "turn.aborted",
      payload: { reason: "interrupted" },
    });
    expect(interrupted.pendingRequests).toEqual([]);
    expect(interrupted.activities.map((activity) => activity.kind)).toEqual([
      "approval.requested",
      "approval.resolved",
    ]);
    const closed = closeSideChatSnapshot(requested);
    expect(closed.pendingRequests).toEqual([]);
    expect(closed.activities.at(-1)?.kind).toBe("approval.resolved");
  });

  it("removes an optimistic message that failed to reach the native conversation", () => {
    const optimistic = {
      ...snapshot,
      messages: [
        {
          id: MessageId.make("pending"),
          role: "user" as const,
          text: "retry me",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    const patch = sideChatStreamEvent(optimistic, snapshot);
    expect(patch.type === "update" ? patch.changes.removedMessageIds : undefined).toEqual([
      MessageId.make("pending"),
    ]);
  });

  it("settles only streaming messages without resending old messages or unchanged requests", () => {
    const history = {
      id: MessageId.make("history"),
      role: "assistant" as const,
      text: "Previous answer",
      turnId: TurnId.make("old-turn"),
      streaming: false,
      createdAt: now,
      updatedAt: now,
    };
    const active = {
      ...history,
      id: MessageId.make("active"),
      text: "Current answer",
      turnId: base.turnId,
      streaming: true,
    };
    const running = { ...snapshot, status: "running" as const, messages: [history, active] };
    const completed = applySideChatEvent(running, {
      ...base,
      type: "turn.completed",
      payload: { state: "completed" },
    });
    expect(completed.messages[0]).toBe(history);
    expect(completed.pendingRequests).toBe(running.pendingRequests);
    const patch = sideChatStreamEvent(running, completed);
    expect(patch.type === "update" ? patch.changes.messageDeltas : undefined).toEqual([
      { id: active.id, delta: "", updatedAt: now, streaming: false },
    ]);
    expect(patch.type === "update" ? patch.changes.pendingRequests : "snapshot").toBeUndefined();
    const closed = closeSideChatSnapshot(completed);
    expect(closed.messages).toBe(completed.messages);
    expect(closed.pendingRequests).toBe(completed.pendingRequests);
    const closePatch = sideChatStreamEvent(completed, closed);
    expect(
      closePatch.type === "update" ? closePatch.changes.messageDeltas : "snapshot",
    ).toBeUndefined();
  });

  it("retains plan-mode output and upserts a replayed completed plan", () => {
    const partial = applySideChatEvent(snapshot, {
      ...base,
      type: "turn.proposed.delta",
      payload: { delta: "# Plan" },
    });
    const completed: ProviderRuntimeEvent = {
      ...base,
      type: "turn.proposed.completed",
      payload: { planMarkdown: "# Plan\n\nDo the work." },
    };
    const replayed = applySideChatEvent(applySideChatEvent(partial, completed), completed);
    expect(replayed.proposedPlans).toHaveLength(1);
    expect(replayed.proposedPlans[0]?.planMarkdown).toBe("# Plan\n\nDo the work.");
  });
});
