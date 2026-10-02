import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  type SideChatSnapshot,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { ProviderAdapterV2Event } from "../orchestration-v2/ProviderAdapter.ts";
import { applySideChatProviderEvent, type SideChatTransition } from "./sideChatState.ts";

const driver = ProviderDriverKind.make("codex");
const sideChatId = ThreadId.make("side-chat:state");
const providerThreadId = ProviderThreadId.make("provider-thread:side");
const turnId = ProviderTurnId.make("provider-turn:side");
const now = DateTime.makeUnsafe(0);

const snapshot: SideChatSnapshot = {
  sideChatId,
  parentThreadId: ThreadId.make("thread:parent"),
  status: "idle",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  interactionMode: "default",
  runtimeMode: "full-access",
  cwd: "/workspace",
  turnItems: [],
  runtimeRequests: [],
  activeProviderTurnId: null,
};

const assistant = (id: string, text: string, threadId = sideChatId): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(id),
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId,
  providerTurnId: turnId,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running",
  title: null,
  type: "assistant_message",
  messageId: MessageId.make(`message:${id}`),
  text,
  streaming: true,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
});

const request: OrchestrationV2RuntimeRequest = {
  id: RuntimeRequestId.make("request:side"),
  nodeId: NodeId.make("node:side"),
  providerTurnId: turnId,
  nativeRequestRef: null,
  kind: "command",
  status: "pending",
  responseCapability: { type: "message" },
  createdAt: now,
  resolvedAt: null,
};

const fold = (events: ReadonlyArray<ProviderAdapterV2Event>) =>
  events.reduce<SideChatTransition>(
    (previous, event) => {
      const next = applySideChatProviderEvent(previous.snapshot, event);
      return { snapshot: next.snapshot, events: [...previous.events, ...next.events] };
    },
    { snapshot, events: [] },
  );

it("upserts the side chat's own turn items in first-seen order", () => {
  const result = fold([
    { type: "turn_item.updated", driver, turnItem: assistant("a", "Hel") },
    { type: "turn_item.updated", driver, turnItem: assistant("b", "Other") },
    { type: "turn_item.updated", driver, turnItem: assistant("a", "Hello") },
    // A subagent's item belongs to its own app thread.
    {
      type: "turn_item.updated",
      driver,
      turnItem: assistant("c", "child", ThreadId.make("thread:child")),
    },
  ]);

  assert.deepStrictEqual(
    result.snapshot.turnItems.map((item) => (item.type === "assistant_message" ? item.text : "")),
    ["Hello", "Other"],
  );
  assert.deepStrictEqual(
    result.events.map((event) => event.type),
    ["turn-item", "turn-item", "turn-item"],
  );
});

it("tracks the active root turn and expires its pending requests when it ends", () => {
  const running = fold([
    {
      type: "provider_turn.updated",
      driver,
      threadId: sideChatId,
      providerTurn: {
        id: turnId,
        providerThreadId,
        nodeId: NodeId.make("node:side"),
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    },
    { type: "runtime_request.updated", driver, threadId: sideChatId, runtimeRequest: request },
  ]);
  assert.equal(running.snapshot.status, "running");
  assert.equal(running.snapshot.activeProviderTurnId, turnId);

  const settled = applySideChatProviderEvent(running.snapshot, {
    type: "turn.terminal",
    driver,
    providerThreadId,
    providerTurnId: turnId,
    runOrdinal: 1,
    status: "interrupted",
    failure: null,
    threadDisposition: "reusable",
  });

  assert.equal(settled.snapshot.status, "idle");
  assert.equal(settled.snapshot.activeProviderTurnId, null);
  assert.equal(settled.snapshot.runtimeRequests[0]?.status, "expired");
  assert.deepStrictEqual(
    settled.events.map((event) => event.type),
    ["status", "runtime-request"],
  );
});
