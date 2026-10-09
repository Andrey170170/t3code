import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  type SideChatSnapshot,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import {
  applySideChatProviderEvent,
  type SideChatEventContext,
  type SideChatTransition,
} from "./sideChatState.ts";

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
  responseCapability: {
    type: "live",
    providerSessionId: ProviderSessionId.make("provider-session:side"),
  },
  createdAt: now,
  resolvedAt: null,
};

/** The reducer's context, with the real (pure) id allocator. */
const makeContext = Effect.gen(function* () {
  const context: SideChatEventContext = {
    providerThreadId,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    now,
  };
  const fold = (events: ReadonlyArray<ProviderAdapterV2Event>) =>
    events.reduce<SideChatTransition>(
      (previous, event) => {
        const next = applySideChatProviderEvent(previous.snapshot, event, context);
        return { snapshot: next.snapshot, events: [...previous.events, ...next.events] };
      },
      { snapshot, events: [] },
    );
  return { context, fold };
}).pipe(Effect.provide(IdAllocator.layer));

const providerTurn = (status: "running" | "completed" | "failed"): ProviderAdapterV2Event => ({
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
    status,
    startedAt: now,
    completedAt: status === "running" ? null : now,
  },
});

it.effect("upserts the side chat's own turn items in first-seen order", () =>
  Effect.gen(function* () {
    const { fold } = yield* makeContext;
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
  }),
);

it.effect("tracks the active root turn and expires its pending requests when it ends", () =>
  Effect.gen(function* () {
    const { context, fold } = yield* makeContext;
    const running = fold([
      providerTurn("running"),
      { type: "runtime_request.updated", driver, threadId: sideChatId, runtimeRequest: request },
    ]);
    assert.equal(running.snapshot.status, "running");
    assert.equal(running.snapshot.activeProviderTurnId, turnId);

    const settled = applySideChatProviderEvent(
      running.snapshot,
      {
        type: "turn.terminal",
        driver,
        providerThreadId,
        providerTurnId: turnId,
        runOrdinal: 1,
        status: "interrupted",
        failure: null,
        threadDisposition: "reusable",
      },
      context,
    );

    assert.equal(settled.snapshot.status, "idle");
    assert.equal(settled.snapshot.activeProviderTurnId, null);
    assert.equal(settled.snapshot.runtimeRequests[0]?.status, "expired");
    assert.deepStrictEqual(
      settled.events.map((event) => event.type),
      ["status", "runtime-request"],
    );
  }),
);

it.effect("keeps a message-mode question pending after its turn ends", () =>
  Effect.gen(function* () {
    const { fold } = yield* makeContext;
    const question: OrchestrationV2RuntimeRequest = {
      ...request,
      id: RuntimeRequestId.make("request:async"),
      kind: "user_input",
      responseCapability: { type: "message" },
    };
    const result = fold([
      providerTurn("running"),
      { type: "runtime_request.updated", driver, threadId: sideChatId, runtimeRequest: question },
      providerTurn("completed"),
    ]);

    assert.equal(result.snapshot.status, "idle");
    assert.equal(result.snapshot.runtimeRequests[0]?.status, "pending");
  }),
);

it.effect("records a failed turn's error even though Codex settles the provider turn first", () =>
  Effect.gen(function* () {
    const { fold } = yield* makeContext;
    const result = fold([
      providerTurn("running"),
      providerTurn("failed"),
      {
        type: "turn.terminal",
        driver,
        providerThreadId,
        providerTurnId: turnId,
        runOrdinal: 1,
        failureItemOrdinal: 7,
        status: "failed",
        failure: { class: "unknown", message: "Model overloaded.", code: null, retryable: null },
        threadDisposition: "reusable",
      },
      // A subagent's failure belongs to its own thread.
      {
        type: "turn.terminal",
        driver,
        providerThreadId: ProviderThreadId.make("provider-thread:child"),
        providerTurnId: ProviderTurnId.make("provider-turn:child"),
        runOrdinal: 1,
        failureItemOrdinal: 1,
        status: "failed",
        failure: { class: "unknown", message: "Child failed.", code: null, retryable: null },
        threadDisposition: "reusable",
      },
    ]);

    assert.equal(result.snapshot.status, "idle");
    assert.equal(result.snapshot.activeProviderTurnId, null);
    const errors = result.snapshot.turnItems.filter((item) => item.type === "error");
    assert.equal(errors.length, 1);
    const error = errors[0];
    assert.equal(error?.type === "error" ? error.failure.message : null, "Model overloaded.");
    assert.equal(error?.providerTurnId, turnId);
    assert.equal(error?.threadId, sideChatId);
  }),
);
