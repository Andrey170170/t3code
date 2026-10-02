import { assert, it } from "@effect/vitest";
import {
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type SideChatStatus,
  type SideChatStreamEvent,
  type SideChatTargetInput,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type {
  ProviderAdapterV2EphemeralForkInput,
  ProviderAdapterV2Event,
  ProviderAdapterV2OpenSessionInput,
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2Shape,
  ProviderAdapterV2TurnInput,
} from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SideChatService from "./SideChatService.ts";
import { SIDE_BOUNDARY_PROMPT, SIDE_DEVELOPER_INSTRUCTIONS } from "./sideChatInstructions.ts";

const codex = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const parentThreadId = ThreadId.make("thread:parent");
const now = DateTime.makeUnsafe(0);

const providerThread = (input: {
  readonly id: string;
  readonly nativeId: string;
  readonly appThreadId: ThreadId;
  readonly driver?: ProviderDriverKind;
}): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make(input.id),
  driver: input.driver ?? codex,
  providerInstanceId: instanceId,
  providerSessionId: null,
  appThreadId: input.appThreadId,
  ownerNodeId: null,
  nativeThreadRef: { driver: input.driver ?? codex, nativeId: input.nativeId, strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
});

const parentThread = (activeProviderThreadId: ProviderThreadId): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: parentThreadId,
  projectId: ProjectId.make("project:side-chat"),
  title: "Parent",
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: "/workspace",
  activeProviderThreadId,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentThreadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

/** A provider whose events the test drives; records what the service asked of it. */
const makeHarness = (options: { readonly parentDriver?: ProviderDriverKind } = {}) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
    const calls = {
      openSessions: [] as Array<ProviderAdapterV2OpenSessionInput>,
      forks: [] as Array<ProviderAdapterV2EphemeralForkInput>,
      turns: [] as Array<ProviderAdapterV2TurnInput>,
      closedSessions: 0,
    };
    const parentProviderThread = providerThread({
      id: "provider-thread:parent",
      nativeId: "native-parent",
      appThreadId: parentThreadId,
      ...(options.parentDriver === undefined ? {} : { driver: options.parentDriver }),
    });
    const unused = () => Effect.die("unused in side chat tests");
    const adapter: ProviderAdapterV2Shape = {
      instanceId,
      driver: codex,
      getCapabilities: unused,
      planSelectionTransition: unused,
      openSession: (input) =>
        Effect.gen(function* () {
          calls.openSessions.push(input);
          yield* Effect.addFinalizer(() => Effect.sync(() => void (calls.closedSessions += 1)));
          const runtime: ProviderAdapterV2SessionRuntime = {
            instanceId,
            driver: codex,
            providerSessionId: input.providerSessionId,
            providerSession: {
              id: input.providerSessionId,
              driver: codex,
              providerInstanceId: instanceId,
              status: "ready",
              cwd: "/workspace",
              model: input.modelSelection.model,
              capabilities:
                {} as ProviderAdapterV2SessionRuntime["providerSession"]["capabilities"],
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
            events: Stream.fromQueue(events),
            ensureThread: unused,
            resumeThread: unused,
            steerTurn: unused,
            interruptTurn: unused,
            respondToRuntimeRequest: unused,
            readThreadSnapshot: unused,
            rollbackThread: unused,
            forkThread: unused,
            openEphemeralFork: (fork) =>
              Effect.sync(() => {
                calls.forks.push(fork);
                return providerThread({
                  id: "provider-thread:side",
                  nativeId: "native-side",
                  appThreadId: fork.appThreadId,
                });
              }),
            startTurn: (turn) => Effect.sync(() => void calls.turns.push(turn)),
          };
          return runtime;
        }),
    };
    const threads = {
      getThreadRecords: () =>
        Effect.succeed({
          thread: parentThread(parentProviderThread.id),
          providerThreads: [parentProviderThread],
        }),
    } as unknown as ThreadManagementService.ThreadManagementService["Service"];
    const layer = SideChatService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ThreadManagementService.ThreadManagementService, threads),
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
            get: () => Effect.succeed(adapter),
            list: () => Effect.succeed([instanceId]),
          }),
          RuntimePolicy.layer,
        ),
      ),
    );
    const service = yield* Effect.service(SideChatService.SideChatService).pipe(
      Effect.provide(yield* Layer.build(layer)),
    );
    return { service, events, calls };
  });

const statusOf = (event: SideChatStreamEvent): SideChatStatus | undefined =>
  event.type === "snapshot"
    ? event.snapshot.status
    : event.type === "status"
      ? event.status
      : undefined;

const awaitStatus = (
  service: SideChatService.SideChatService["Service"],
  target: SideChatTargetInput,
  status: SideChatStatus,
) =>
  service.subscribe(target).pipe(
    Stream.takeUntil((event) => statusOf(event) === status),
    Stream.runDrain,
  );

const currentSnapshot = (
  service: SideChatService.SideChatService["Service"],
  target: SideChatTargetInput,
) =>
  service.subscribe(target).pipe(
    Stream.runHead,
    Effect.flatMap((event) =>
      event._tag === "Some" && event.value.type === "snapshot"
        ? Effect.succeed(event.value.snapshot)
        : Effect.die("expected a snapshot first"),
    ),
  );

it.effect("forks the parent's native thread in its own detached session, once per parent", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* makeHarness();

    const opened = yield* service.open({ parentThreadId });
    const target = { parentThreadId, sideChatId: opened.sideChatId };
    assert.equal(opened.status, "starting");
    yield* awaitStatus(service, target, "idle");
    const reopened = yield* service.open({ parentThreadId });

    assert.equal(reopened.sideChatId, opened.sideChatId);
    assert.equal(calls.openSessions.length, 1);
    assert.equal(calls.openSessions[0]?.threadId, opened.sideChatId);
    assert.equal(calls.openSessions[0]?.detached, true);
    assert.deepStrictEqual(calls.forks, [
      {
        sourceNativeThreadId: "native-parent",
        appThreadId: opened.sideChatId,
        modelSelection: { instanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace",
        },
        developerInstructions: SIDE_DEVELOPER_INSTRUCTIONS,
        boundaryPrompt: SIDE_BOUNDARY_PROMPT,
      },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("sends turns on the side thread and folds provider events into the snapshot", () =>
  Effect.gen(function* () {
    const { service, events, calls } = yield* makeHarness();
    const opened = yield* service.open({ parentThreadId });
    const target = { parentThreadId, sideChatId: opened.sideChatId };
    yield* awaitStatus(service, target, "idle");

    yield* service.send({ ...target, input: "What changed?", interactionMode: "plan" });
    const turn = calls.turns[0];
    assert.isDefined(turn);
    assert.equal(turn!.threadId, opened.sideChatId);
    assert.equal(turn!.providerThread.nativeThreadRef?.nativeId, "native-side");
    assert.equal(turn!.message.text, "What changed?");
    assert.equal(turn!.runtimePolicy.interactionMode, "plan");

    const providerTurnId = ProviderTurnId.make("provider-turn:side");
    const providerThreadId = turn!.providerThread.id;
    yield* Queue.offerAll(events, [
      {
        type: "provider_turn.updated",
        driver: codex,
        threadId: opened.sideChatId,
        providerTurn: {
          id: providerTurnId,
          providerThreadId,
          nodeId: turn!.rootNodeId,
          runAttemptId: turn!.attemptId,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      },
      {
        type: "turn_item.updated",
        driver: codex,
        turnItem: {
          id: TurnItemId.make("item:answer"),
          threadId: opened.sideChatId,
          runId: turn!.runId,
          nodeId: turn!.rootNodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 101,
          status: "completed",
          title: null,
          type: "assistant_message",
          messageId: MessageId.make("message:answer"),
          text: "Nothing yet.",
          streaming: false,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      },
      {
        type: "turn.terminal",
        driver: codex,
        providerThreadId,
        providerTurnId,
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      },
    ]);
    yield* awaitStatus(service, target, "idle");
    const snapshot = yield* currentSnapshot(service, target);

    assert.equal(snapshot.interactionMode, "plan");
    assert.equal(snapshot.activeProviderTurnId, null);
    assert.deepStrictEqual(
      snapshot.turnItems.map((item) => [item.type, "text" in item ? item.text : null]),
      [
        ["user_message", "What changed?"],
        ["assistant_message", "Nothing yet."],
      ],
    );
  }).pipe(Effect.scoped),
);

it.effect("closing ends the provider session and forgets the side chat", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* makeHarness();
    const opened = yield* service.open({ parentThreadId });
    const target = { parentThreadId, sideChatId: opened.sideChatId };
    yield* awaitStatus(service, target, "idle");

    yield* service.close(target);

    assert.equal(calls.closedSessions, 1);
    const subscribeError = yield* Effect.flip(Stream.runDrain(service.subscribe(target)));
    assert.instanceOf(subscribeError, SideChatService.SideChatNotFoundError);
    const sendError = yield* Effect.flip(service.send({ ...target, input: "Still there?" }));
    assert.instanceOf(sendError, SideChatService.SideChatNotFoundError);
    // A new side chat starts fresh.
    const next = yield* service.open({ parentThreadId });
    assert.notEqual(next.sideChatId, opened.sideChatId);
  }).pipe(Effect.scoped),
);

it.effect("only Codex threads can open side chats", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* makeHarness({
      parentDriver: ProviderDriverKind.make("claudeAgent"),
    });

    const error = yield* Effect.flip(service.open({ parentThreadId }));

    assert.instanceOf(error, SideChatService.SideChatRejectedError);
    assert.equal(calls.openSessions.length, 0);
  }).pipe(Effect.scoped),
);
