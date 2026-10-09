import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  type SideChatStatus,
  type SideChatStreamEvent,
  type SideChatTargetInput,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2EphemeralForkInput,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2InterruptInput,
  type ProviderAdapterV2OpenSessionInput,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2SteerInput,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
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
const makeHarness = (
  options: {
    readonly parentDriver?: ProviderDriverKind;
    readonly startTurn?: ProviderAdapterV2SessionRuntime["startTurn"];
    /** Stops the provider process only once this completes. */
    readonly stopProcess?: Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
    const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const sessionClosed = yield* Deferred.make<void>();
    const calls = {
      openSessions: [] as Array<ProviderAdapterV2OpenSessionInput>,
      forks: [] as Array<ProviderAdapterV2EphemeralForkInput>,
      turns: [] as Array<ProviderAdapterV2TurnInput>,
      steers: [] as Array<ProviderAdapterV2SteerInput>,
      interrupts: [] as Array<ProviderAdapterV2InterruptInput>,
      responses: 0,
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
          yield* Effect.addFinalizer(() =>
            (options.stopProcess ?? Effect.void).pipe(
              Effect.andThen(Deferred.succeed(sessionClosed, undefined)),
            ),
          );
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
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
            events: Stream.fromQueue(events),
            ensureThread: unused,
            resumeThread: unused,
            steerTurn: (steer) => Effect.sync(() => void calls.steers.push(steer)),
            interruptTurn: (interrupt) => Effect.sync(() => void calls.interrupts.push(interrupt)),
            respondToRuntimeRequest: () => Effect.sync(() => void (calls.responses += 1)),
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
            startTurn: (turn) =>
              Effect.sync(() => void calls.turns.push(turn)).pipe(
                Effect.andThen(options.startTurn?.(turn) ?? Effect.void),
              ),
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
      streamDomainEvents: Stream.fromQueue(domainEvents),
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
          IdAllocator.layer,
        ),
      ),
    );
    const service = yield* Effect.service(SideChatService.SideChatService).pipe(
      Effect.provide(yield* Layer.build(layer)),
    );
    return { service, events, domainEvents, calls, sessionClosed: Deferred.await(sessionClosed) };
  });

const providerTurnUpdate = (
  turn: ProviderAdapterV2TurnInput,
  providerTurnId: ProviderTurnId,
  status: "running" | "completed" | "failed",
): ProviderAdapterV2Event => ({
  type: "provider_turn.updated",
  driver: codex,
  threadId: turn.threadId,
  providerTurn: {
    id: providerTurnId,
    providerThreadId: turn.providerThread.id,
    nodeId: turn.rootNodeId,
    runAttemptId: turn.attemptId,
    nativeTurnRef: null,
    ordinal: 1,
    status,
    startedAt: now,
    completedAt: status === "running" ? null : now,
  },
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
      providerTurnUpdate(turn!, providerTurnId, "running"),
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
      // Codex settles the provider turn before reporting the terminal outcome.
      providerTurnUpdate(turn!, providerTurnId, "completed"),
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
    const { service, sessionClosed } = yield* makeHarness();
    const opened = yield* service.open({ parentThreadId });
    const target = { parentThreadId, sideChatId: opened.sideChatId };
    yield* awaitStatus(service, target, "idle");

    yield* service.close(target);

    yield* sessionClosed;
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

const openIdle = (service: SideChatService.SideChatService["Service"]) =>
  Effect.gen(function* () {
    const opened = yield* service.open({ parentThreadId });
    const target = { parentThreadId, sideChatId: opened.sideChatId };
    yield* awaitStatus(service, target, "idle");
    return target;
  });

it.effect("shows a failed turn in the timeline and frees the side chat", () =>
  Effect.gen(function* () {
    const { service, events, calls } = yield* makeHarness();
    const target = yield* openIdle(service);
    yield* service.send({ ...target, input: "Why?" });
    const turn = calls.turns[0]!;
    const providerTurnId = ProviderTurnId.make("provider-turn:failed");

    yield* Queue.offerAll(events, [
      providerTurnUpdate(turn, providerTurnId, "running"),
      providerTurnUpdate(turn, providerTurnId, "failed"),
      {
        type: "turn.terminal",
        driver: codex,
        providerThreadId: turn.providerThread.id,
        providerTurnId,
        runOrdinal: 1,
        failureItemOrdinal: 101,
        status: "failed",
        failure: { class: "unknown", message: "Model overloaded.", code: null, retryable: null },
        threadDisposition: "reusable",
      },
    ]);
    yield* service.subscribe(target).pipe(
      Stream.takeUntil((event) => event.type === "turn-item" && event.turnItem.type === "error"),
      Stream.runDrain,
    );
    const snapshot = yield* currentSnapshot(service, target);

    assert.equal(snapshot.status, "idle");
    const error = snapshot.turnItems.find((item) => item.type === "error");
    assert.equal(error?.type === "error" ? error.failure.message : null, "Model overloaded.");
    assert.equal(error?.runId, turn.runId);
  }).pipe(Effect.scoped),
);

it.effect("a dropped send request neither cancels the start nor strands the side chat", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void, string>();
    const { service } = yield* makeHarness({
      startTurn: (turn) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.mapError(
            (detail) =>
              new ProviderAdapterTurnStartError({
                driver: codex,
                threadId: turn.threadId,
                providerThreadId: turn.providerThread.id,
                runId: turn.runId,
                cause: detail,
              }),
          ),
        ),
    });
    const target = yield* openIdle(service);

    const sending = yield* service.send({ ...target, input: "Slow" }).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(sending);
    // The start keeps running for the side chat; when it fails, the claim is released.
    yield* Deferred.fail(release, "provider refused");
    yield* awaitStatus(service, target, "idle");

    const snapshot = yield* currentSnapshot(service, target);
    assert.equal(snapshot.error, "Failed to send the side chat message.");
  }).pipe(Effect.scoped),
);

it.effect("a stop before Codex reports the turn is applied once it does", () =>
  Effect.gen(function* () {
    const { service, events, calls } = yield* makeHarness();
    const target = yield* openIdle(service);
    yield* service.send({ ...target, input: "Long task" });

    yield* service.interrupt(target);
    assert.equal(calls.interrupts.length, 0);
    const providerTurnId = ProviderTurnId.make("provider-turn:late");
    yield* Queue.offer(events, providerTurnUpdate(calls.turns[0]!, providerTurnId, "running"));
    yield* awaitStatus(service, target, "running");
    yield* Effect.yieldNow.pipe(Effect.repeat({ until: () => calls.interrupts.length > 0 }));

    assert.deepStrictEqual(
      calls.interrupts.map((interrupt) => interrupt.providerTurnId),
      [providerTurnId],
    );
  }).pipe(Effect.scoped),
);

it.effect("closing does not wait for the provider process to stop", () =>
  Effect.gen(function* () {
    const stopped = yield* Deferred.make<void>();
    const { service, sessionClosed } = yield* makeHarness({ stopProcess: Deferred.await(stopped) });
    const target = yield* openIdle(service);

    yield* service.close(target);
    // The global lock is free: the parent can start a new side chat right away.
    const next = yield* service.open({ parentThreadId });
    assert.notEqual(next.sideChatId, target.sideChatId);

    yield* Deferred.succeed(stopped, undefined);
    yield* sessionClosed;
  }).pipe(Effect.scoped),
);

it.effect("deleting the parent thread closes its side chat", () =>
  Effect.gen(function* () {
    const { service, domainEvents, sessionClosed } = yield* makeHarness();
    const target = yield* openIdle(service);
    const ended = yield* service.subscribe(target).pipe(Stream.runCollect, Effect.forkChild);

    yield* Queue.offer(domainEvents, {
      type: "thread.deleted",
      threadId: parentThreadId,
    } as unknown as OrchestrationV2DomainEvent);

    const frames = yield* Fiber.join(ended);
    assert.equal(frames.at(-1)?.type, "closed");
    yield* sessionClosed;
  }).pipe(Effect.scoped),
);

it.effect("archiving the parent thread closes its side chat", () =>
  Effect.gen(function* () {
    const { service, domainEvents, sessionClosed } = yield* makeHarness();
    const target = yield* openIdle(service);

    yield* Queue.offer(domainEvents, {
      type: "thread.archived",
      threadId: parentThreadId,
    } as unknown as OrchestrationV2DomainEvent);

    yield* sessionClosed;
    const lookup = yield* service.subscribe(target).pipe(Stream.runCollect, Effect.flip);
    assert.equal(lookup._tag, "SideChatNotFoundError");
  }).pipe(Effect.scoped),
);

it.effect("a side chat with no activity for 30 minutes closes", () =>
  Effect.gen(function* () {
    const { service, sessionClosed } = yield* makeHarness();
    const target = yield* openIdle(service);
    const firstFrame = service.subscribe(target).pipe(Stream.take(1), Stream.runCollect);

    yield* TestClock.adjust("29 minutes");
    assert.equal((yield* firstFrame)[0]?.type, "snapshot");

    yield* TestClock.adjust("2 minutes");
    yield* sessionClosed;
    const lookup = yield* firstFrame.pipe(Effect.flip);
    assert.equal(lookup._tag, "SideChatNotFoundError");
  }).pipe(Effect.scoped),
);

const asyncQuestion = (turn: ProviderAdapterV2TurnInput): Array<ProviderAdapterV2Event> => {
  const requestId = RuntimeRequestId.make("async:item-question");
  const nodeId = NodeId.make("node:question");
  return [
    {
      type: "runtime_request.updated",
      driver: codex,
      threadId: turn.threadId,
      runtimeRequest: {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    },
    {
      type: "turn_item.updated",
      driver: codex,
      turnItem: {
        id: TurnItemId.make("item:question"),
        threadId: turn.threadId,
        runId: turn.runId,
        nodeId,
        providerThreadId: turn.providerThread.id,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 150,
        status: "waiting",
        title: null,
        type: "user_input_request",
        requestId,
        responseMode: "message",
        questions: [{ id: "0", header: "Question", question: "Which branch?", options: [] }],
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    },
  ];
};

it.effect("answers a Codex async question with a new message, not a provider response", () =>
  Effect.gen(function* () {
    const { service, events, calls } = yield* makeHarness();
    const target = yield* openIdle(service);
    yield* service.send({ ...target, input: "Help me pick" });
    const turn = calls.turns[0]!;
    const providerTurnId = ProviderTurnId.make("provider-turn:asks");
    yield* Queue.offerAll(events, [
      providerTurnUpdate(turn, providerTurnId, "running"),
      ...asyncQuestion(turn),
      providerTurnUpdate(turn, providerTurnId, "completed"),
    ]);
    yield* awaitStatus(service, target, "idle");
    const requestId = RuntimeRequestId.make("async:item-question");
    assert.equal((yield* currentSnapshot(service, target)).runtimeRequests[0]?.status, "pending");

    yield* service.respond({ ...target, requestId, answers: { "0": " main " } });

    assert.equal(calls.responses, 0);
    assert.equal(calls.turns[1]?.message.text, "Which branch?\nmain");
    const snapshot = yield* currentSnapshot(service, target);
    assert.equal(snapshot.status, "running");
    assert.equal(snapshot.runtimeRequests[0]?.status, "resolved");
    const question = snapshot.turnItems.find((item) => item.type === "user_input_request");
    assert.equal(question?.status, "completed");
  }).pipe(Effect.scoped),
);

it.effect("steers a running turn with an async answer, and dismissing stays local", () =>
  Effect.gen(function* () {
    const { service, events, calls } = yield* makeHarness();
    const target = yield* openIdle(service);
    yield* service.send({ ...target, input: "Help me pick" });
    const turn = calls.turns[0]!;
    const providerTurnId = ProviderTurnId.make("provider-turn:asks");
    yield* Queue.offerAll(events, [
      providerTurnUpdate(turn, providerTurnId, "running"),
      ...asyncQuestion(turn),
    ]);
    yield* service.subscribe(target).pipe(
      Stream.takeUntil(
        (event) => event.type === "turn-item" && event.turnItem.type === "user_input_request",
      ),
      Stream.runDrain,
    );
    const requestId = RuntimeRequestId.make("async:item-question");

    yield* service.respond({ ...target, requestId, answers: { "0": "main" } });
    assert.deepStrictEqual(
      calls.steers.map((steer) => [steer.providerTurnId, steer.runId, steer.message.text]),
      [[providerTurnId, turn.runId, "Which branch?\nmain"]],
    );
    assert.equal(calls.turns.length, 1);

    // A second question, dismissed: nothing reaches Codex.
    const [request, item] = asyncQuestion(turn);
    const secondId = RuntimeRequestId.make("async:item-second");
    yield* Queue.offerAll(events, [
      request!.type === "runtime_request.updated"
        ? { ...request!, runtimeRequest: { ...request!.runtimeRequest, id: secondId } }
        : request!,
      item!.type === "turn_item.updated" && item!.turnItem.type === "user_input_request"
        ? {
            ...item!,
            turnItem: {
              ...item!.turnItem,
              id: TurnItemId.make("item:second"),
              requestId: secondId,
            },
          }
        : item!,
    ]);
    yield* service.subscribe(target).pipe(
      Stream.takeUntil(
        (event) => event.type === "runtime-request" && event.runtimeRequest.id === secondId,
      ),
      Stream.runDrain,
    );
    yield* service.respond({ ...target, requestId: secondId, decision: "cancel" });

    assert.equal(calls.responses, 0);
    assert.equal(calls.steers.length, 1);
    const snapshot = yield* currentSnapshot(service, target);
    const dismissed = snapshot.turnItems.find(
      (candidate) => candidate.type === "user_input_request" && candidate.requestId === secondId,
    );
    assert.equal(dismissed?.status, "cancelled");
    assert.equal(
      snapshot.runtimeRequests.find((candidate) => candidate.id === secondId)?.status,
      "resolved",
    );
  }).pipe(Effect.scoped),
);
