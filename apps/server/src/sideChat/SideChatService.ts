import {
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  type SideChatRespondInput,
  type SideChatSendInput,
  type SideChatSnapshot,
  type SideChatStreamEvent,
  type SideChatTargetInput,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type {
  ProviderAdapterV2RuntimePolicy,
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2Shape,
} from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { SIDE_BOUNDARY_PROMPT, SIDE_DEVELOPER_INSTRUCTIONS } from "./sideChatInstructions.ts";
import {
  applySideChatProviderEvent,
  patchSideChat,
  type SideChatTransition,
  upsertSideChatRuntimeRequest,
  upsertSideChatTurnItem,
} from "./sideChatState.ts";

/**
 * ERRORS
 */
export class SideChatNotFoundError extends Schema.TaggedError<SideChatNotFoundError>()(
  "SideChatNotFoundError",
  { sideChatId: ThreadId },
) {
  override get message(): string {
    return "This side chat has ended.";
  }
}

export class SideChatRejectedError extends Schema.TaggedError<SideChatRejectedError>()(
  "SideChatRejectedError",
  { parentThreadId: ThreadId, detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

export class SideChatProviderError extends Schema.TaggedError<SideChatProviderError>()(
  "SideChatProviderError",
  {
    sideChatId: ThreadId,
    operation: Schema.Literals(["send", "interrupt", "respond"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    switch (this.operation) {
      case "send":
        return "Failed to send the side chat message.";
      case "interrupt":
        return "Failed to stop the side chat.";
      case "respond":
        return "Failed to answer the side chat request.";
    }
  }
}

type SideChatServiceError = SideChatNotFoundError | SideChatRejectedError | SideChatProviderError;

/**
 * SERVICE DEFINITION
 *
 * Codex native side conversations: a temporary fork of a parent thread's
 * native thread, run in its own provider process outside orchestration. Side
 * chats live only in memory, one per parent thread, until closed or the server
 * stops.
 */
export class SideChatService extends Context.Service<
  SideChatService,
  {
    /** Returns the parent's open side chat, or starts one (status "starting"). */
    readonly open: (input: {
      readonly parentThreadId: ThreadId;
    }) => Effect.Effect<SideChatSnapshot, SideChatRejectedError>;
    readonly send: (input: SideChatSendInput) => Effect.Effect<void, SideChatServiceError>;
    readonly interrupt: (input: SideChatTargetInput) => Effect.Effect<void, SideChatServiceError>;
    readonly respond: (input: SideChatRespondInput) => Effect.Effect<void, SideChatServiceError>;
    /** Ends the side chat and its provider process. Unknown side chats are already closed. */
    readonly close: (input: SideChatTargetInput) => Effect.Effect<void>;
    /** A snapshot, then changes until the side chat closes. */
    readonly subscribe: (
      input: SideChatTargetInput,
    ) => Stream.Stream<SideChatStreamEvent, SideChatNotFoundError>;
  }
>()("t3/sideChat/SideChatService") {}

/**
 * IMPLEMENTATION
 */
const CODEX_DRIVER = ProviderDriverKind.make("codex");

interface SideChatSession {
  readonly runtime: ProviderAdapterV2SessionRuntime;
  readonly providerThread: OrchestrationV2ProviderThread;
}

interface SideChat {
  readonly sideChatId: ThreadId;
  readonly parentThread: OrchestrationV2AppThread;
  readonly scope: Scope.Closeable;
  /** Serializes state changes with their publication so subscribers never miss a frame. */
  readonly lock: Semaphore.Semaphore;
  readonly state: Ref.Ref<SideChatSnapshot>;
  readonly changes: PubSub.PubSub<SideChatStreamEvent>;
  /** Fails when the start fails or the side chat closes first. */
  readonly session: Deferred.Deferred<
    SideChatSession,
    SideChatRejectedError | SideChatNotFoundError
  >;
}

const failureMessage = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.squash(cause);
  return failure instanceof Error ? failure.message : String(failure);
};

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const runtimePolicies = yield* RuntimePolicy.RuntimePolicyV2;
  const layerScope = yield* Effect.scope;
  const openLock = yield* Semaphore.make(1);
  const byParent = new Map<ThreadId, SideChat>();
  const byId = new Map<ThreadId, SideChat>();

  const modify = <A>(
    chat: SideChat,
    f: (snapshot: SideChatSnapshot) => readonly [A, SideChatTransition],
  ) =>
    chat.lock.withPermit(
      Effect.gen(function* () {
        const [result, transition] = f(yield* Ref.get(chat.state));
        yield* Ref.set(chat.state, transition.snapshot);
        if (transition.events.length > 0) yield* PubSub.publishAll(chat.changes, transition.events);
        return result;
      }),
    );
  const update = (chat: SideChat, f: (snapshot: SideChatSnapshot) => SideChatTransition) =>
    modify(chat, (snapshot) => [undefined, f(snapshot)] as const);

  const reject = (parentThreadId: ThreadId, detail: string) => (cause?: unknown) =>
    new SideChatRejectedError({ parentThreadId, detail, ...(cause ? { cause } : {}) });

  const requireChat = (input: SideChatTargetInput) => {
    const chat = byId.get(input.sideChatId);
    return chat === undefined || chat.parentThread.id !== input.parentThreadId
      ? Effect.fail(new SideChatNotFoundError({ sideChatId: input.sideChatId }))
      : Effect.succeed(chat);
  };

  const closeChat = (chat: SideChat) =>
    Effect.gen(function* () {
      if (byId.get(chat.sideChatId) !== chat) return;
      byId.delete(chat.sideChatId);
      byParent.delete(chat.parentThread.id);
      yield* update(chat, (snapshot) => {
        const transition = patchSideChat(snapshot, {
          status: "closed",
          activeProviderTurnId: null,
        });
        return {
          snapshot: transition.snapshot,
          events: [{ type: "closed", sideChatId: chat.sideChatId }],
        };
      });
      yield* Deferred.fail(
        chat.session,
        new SideChatNotFoundError({ sideChatId: chat.sideChatId }),
      );
      // Interrupts the event fiber, then stops the side chat's provider process.
      yield* Scope.close(chat.scope, Exit.void);
      yield* PubSub.shutdown(chat.changes);
    });

  /** Starts the side chat's own provider process and forks the parent into it. */
  const start = (
    chat: SideChat,
    input: {
      readonly adapter: ProviderAdapterV2Shape;
      readonly sourceNativeThreadId: string;
      readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
    },
  ) =>
    Effect.gen(function* () {
      const snapshot = yield* Ref.get(chat.state);
      const runtime = yield* input.adapter
        .openSession({
          threadId: chat.sideChatId,
          providerSessionId: ProviderSessionId.make(`side-chat-session:${yield* randomUuidV4}`),
          modelSelection: snapshot.modelSelection,
          runtimePolicy: input.runtimePolicy,
          detached: true,
        })
        .pipe(Effect.provideService(Scope.Scope, chat.scope));
      if (runtime.openEphemeralFork === undefined) {
        return yield* reject(chat.parentThread.id, "This provider does not support side chats.")();
      }
      yield* Stream.runForEach(runtime.events, (event) =>
        update(chat, (current) => applySideChatProviderEvent(current, event)),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Side chat provider event stream failed.", { cause }).pipe(
            Effect.andThen(
              update(chat, (current) =>
                current.status === "closed"
                  ? { snapshot: current, events: [] }
                  : patchSideChat(current, {
                      status: "error",
                      activeProviderTurnId: null,
                      error: "The side chat's Codex process stopped.",
                    }),
              ),
            ),
          ),
        ),
        Effect.forkIn(chat.scope),
      );
      const providerThread = yield* runtime.openEphemeralFork({
        sourceNativeThreadId: input.sourceNativeThreadId,
        appThreadId: chat.sideChatId,
        modelSelection: snapshot.modelSelection,
        runtimePolicy: input.runtimePolicy,
        developerInstructions: SIDE_DEVELOPER_INSTRUCTIONS,
        boundaryPrompt: SIDE_BOUNDARY_PROMPT,
      });
      yield* Deferred.succeed(chat.session, { runtime, providerThread });
      yield* update(chat, (current) => patchSideChat(current, { status: "idle" }));
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("Failed to start side chat.", { cause }).pipe(
              Effect.andThen(
                Deferred.fail(
                  chat.session,
                  new SideChatRejectedError({
                    parentThreadId: chat.parentThread.id,
                    detail: "The side chat failed to start.",
                    cause: Cause.squash(cause),
                  }),
                ),
              ),
              Effect.andThen(
                update(chat, (current) =>
                  patchSideChat(current, {
                    status: "error",
                    error: `Could not start the side chat: ${failureMessage(cause)}`,
                  }),
                ),
              ),
            ),
      ),
    );

  const open: SideChatService["Service"]["open"] = ({ parentThreadId }) =>
    openLock.withPermit(
      Effect.gen(function* () {
        const existing = byParent.get(parentThreadId);
        if (existing !== undefined) {
          const snapshot = yield* Ref.get(existing.state);
          if (snapshot.status !== "error") return snapshot;
          yield* closeChat(existing);
        }

        const records = yield* threads
          .getThreadRecords(parentThreadId, ["providerThreads"])
          .pipe(Effect.mapError(reject(parentThreadId, "The thread could not be loaded.")));
        const parentThread = records.thread;
        const providerThread = records.providerThreads.find(
          (candidate) => candidate.id === parentThread.activeProviderThreadId,
        );
        const sourceNativeThreadId = providerThread?.nativeThreadRef?.nativeId;
        if (providerThread === undefined || providerThread.driver !== CODEX_DRIVER) {
          return yield* reject(parentThreadId, "Side chats are only available in Codex threads.")();
        }
        if (sourceNativeThreadId === undefined || sourceNativeThreadId === null) {
          return yield* reject(parentThreadId, "Send a message before starting a side chat.")();
        }
        const adapter = yield* adapters
          .get(providerThread.providerInstanceId)
          .pipe(
            Effect.mapError(reject(parentThreadId, "The thread's Codex provider is unavailable.")),
          );
        const modelSelection =
          parentThread.modelSelection.instanceId === providerThread.providerInstanceId
            ? parentThread.modelSelection
            : { ...parentThread.modelSelection, instanceId: providerThread.providerInstanceId };
        const runtimePolicy = yield* runtimePolicies
          .resolve({ thread: parentThread, modelSelection })
          .pipe(Effect.mapError(reject(parentThreadId, "The thread's workspace is unavailable.")));

        const sideChatId = ThreadId.make(`side-chat:${yield* randomUuidV4}`);
        const snapshot: SideChatSnapshot = {
          sideChatId,
          parentThreadId,
          status: "starting",
          modelSelection,
          interactionMode: parentThread.interactionMode,
          runtimeMode: runtimePolicy.runtimeMode,
          cwd: runtimePolicy.cwd ?? "",
          turnItems: [],
          runtimeRequests: [],
          activeProviderTurnId: null,
        };
        const chat: SideChat = {
          sideChatId,
          parentThread,
          // Child of the service scope, so server shutdown ends every side chat.
          scope: yield* Scope.fork(layerScope, "sequential"),
          lock: yield* Semaphore.make(1),
          state: yield* Ref.make(snapshot),
          changes: yield* PubSub.unbounded<SideChatStreamEvent>(),
          session: yield* Deferred.make<
            SideChatSession,
            SideChatRejectedError | SideChatNotFoundError
          >(),
        };
        byParent.set(parentThreadId, chat);
        byId.set(sideChatId, chat);
        yield* start(chat, { adapter, sourceNativeThreadId, runtimePolicy }).pipe(
          Effect.forkIn(chat.scope),
        );
        return snapshot;
      }),
    );

  const send: SideChatService["Service"]["send"] = (input) =>
    Effect.gen(function* () {
      const chat = yield* requireChat(input);
      const { runtime, providerThread } = yield* Deferred.await(chat.session);
      const current = yield* Ref.get(chat.state);
      const modelSelection = input.modelSelection ?? current.modelSelection;
      if (modelSelection.instanceId !== current.modelSelection.instanceId) {
        return yield* reject(chat.parentThread.id, "A side chat cannot switch providers.")();
      }
      const interactionMode = input.interactionMode ?? current.interactionMode;
      const runtimeMode = input.runtimeMode ?? current.runtimeMode;
      const appThread: OrchestrationV2AppThread = {
        ...chat.parentThread,
        id: chat.sideChatId,
        modelSelection,
        interactionMode,
        runtimeMode,
        activeProviderThreadId: providerThread.id,
      };
      const runtimePolicy = yield* runtimePolicies
        .resolve({ thread: appThread, modelSelection })
        .pipe(
          Effect.mapError(reject(chat.parentThread.id, "The thread's workspace is unavailable.")),
        );
      const uuid = yield* randomUuidV4;
      const runId = RunId.make(`side-run:${uuid}`);
      const rootNodeId = NodeId.make(`side-node:${uuid}`);
      const messageId = MessageId.make(`side-message:${uuid}`);
      const now = yield* DateTime.now;

      // The blocking status, or this turn's 1-based ordinal once the turn is claimed.
      const claim = yield* modify<SideChatSnapshot["status"] | number>(chat, (snapshot) => {
        if (snapshot.status !== "idle") return [snapshot.status, { snapshot, events: [] }] as const;
        const ordinal =
          snapshot.turnItems.filter((item) => item.type === "user_message").length + 1;
        const userMessage: OrchestrationV2TurnItem = {
          id: TurnItemId.make(`side-user:${uuid}`),
          threadId: chat.sideChatId,
          runId,
          nodeId: rootNodeId,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: ordinal * 100,
          status: "completed",
          title: null,
          type: "user_message",
          messageId,
          text: input.input,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          inputIntent: "turn_start",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        };
        const running = patchSideChat(snapshot, {
          status: "running",
          activeProviderTurnId: null,
          modelSelection,
          interactionMode,
          runtimeMode: runtimePolicy.runtimeMode,
          clearError: true,
        });
        const withMessage = upsertSideChatTurnItem(running.snapshot, userMessage);
        return [
          ordinal,
          {
            snapshot: withMessage.snapshot,
            events: [...running.events, ...withMessage.events],
          },
        ] as const;
      });
      if (typeof claim !== "number") {
        return yield* reject(
          chat.parentThread.id,
          claim === "running"
            ? "The side chat is still answering."
            : "This side chat has stopped. Start a new one.",
        )();
      }
      const turnOrdinal = claim;

      yield* runtime
        .startTurn({
          appThread,
          threadId: chat.sideChatId,
          runId,
          runOrdinal: turnOrdinal,
          providerTurnOrdinal: turnOrdinal,
          attemptId: RunAttemptId.make(`side-attempt:${uuid}`),
          rootNodeId,
          providerThread,
          message: {
            messageId,
            text: input.input,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection,
          runtimePolicy,
        })
        .pipe(
          Effect.tapError(() =>
            update(chat, (snapshot) =>
              snapshot.status !== "running"
                ? { snapshot, events: [] }
                : patchSideChat(snapshot, {
                    status: "idle",
                    activeProviderTurnId: null,
                    error: "Failed to send the side chat message.",
                  }),
            ),
          ),
          Effect.mapError(
            (cause) =>
              new SideChatProviderError({ sideChatId: chat.sideChatId, operation: "send", cause }),
          ),
        );
    });

  const interrupt: SideChatService["Service"]["interrupt"] = (input) =>
    Effect.gen(function* () {
      const chat = yield* requireChat(input);
      const { runtime, providerThread } = yield* Deferred.await(chat.session);
      const { activeProviderTurnId } = yield* Ref.get(chat.state);
      if (activeProviderTurnId === null) return;
      yield* runtime.interruptTurn({ providerThread, providerTurnId: activeProviderTurnId }).pipe(
        Effect.mapError(
          (cause) =>
            new SideChatProviderError({
              sideChatId: chat.sideChatId,
              operation: "interrupt",
              cause,
            }),
        ),
      );
    });

  const respond: SideChatService["Service"]["respond"] = (input) =>
    Effect.gen(function* () {
      const chat = yield* requireChat(input);
      const { runtime } = yield* Deferred.await(chat.session);
      yield* runtime
        .respondToRuntimeRequest({
          requestId: input.requestId,
          ...(input.decision === undefined ? {} : { decision: input.decision }),
          ...(input.answers === undefined ? {} : { answers: input.answers }),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new SideChatProviderError({
                sideChatId: chat.sideChatId,
                operation: "respond",
                cause,
              }),
          ),
        );
      // Providers do not report resolution; orchestration records it the same way.
      const resolvedAt = yield* DateTime.now;
      yield* update(chat, (snapshot) => {
        const request = snapshot.runtimeRequests.find(
          (candidate) => candidate.id === input.requestId,
        );
        return request === undefined
          ? { snapshot, events: [] }
          : upsertSideChatRuntimeRequest(snapshot, {
              ...request,
              status: "resolved",
              resolvedAt,
              ...(input.decision === undefined ? {} : { decision: input.decision }),
              ...(input.answers === undefined ? {} : { answers: input.answers }),
            });
      });
    });

  const close: SideChatService["Service"]["close"] = (input) =>
    openLock.withPermit(
      Effect.suspend(() => {
        const chat = byId.get(input.sideChatId);
        return chat === undefined || chat.parentThread.id !== input.parentThreadId
          ? Effect.void
          : closeChat(chat);
      }),
    );

  const subscribe: SideChatService["Service"]["subscribe"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const chat = yield* requireChat(input);
        // Subscribe and read under the lock so no change falls between them.
        const [subscription, snapshot] = yield* chat.lock.withPermit(
          Effect.all([PubSub.subscribe(chat.changes), Ref.get(chat.state)]),
        );
        const initial: SideChatStreamEvent = { type: "snapshot", snapshot };
        return Stream.concat(Stream.make(initial), Stream.fromSubscription(subscription)).pipe(
          Stream.takeUntil((event) => event.type === "closed"),
        );
      }),
    );

  return SideChatService.of({ open, send, interrupt, respond, close, subscribe });
});

export const layer = Layer.effect(SideChatService, make);
