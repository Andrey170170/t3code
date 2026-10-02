import {
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  type ProviderInteractionMode,
  ProviderSessionId,
  type ProviderThreadId,
  type ProviderTurnId,
  RunAttemptId,
  RunId,
  type RuntimeMode,
  type SideChatRespondInput,
  type SideChatSendInput,
  type SideChatSnapshot,
  type SideChatStreamEvent,
  type SideChatTargetInput,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type {
  ProviderAdapterV2RuntimePolicy,
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2Shape,
} from "../orchestration-v2/ProviderAdapter.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import { SIDE_BOUNDARY_PROMPT, SIDE_DEVELOPER_INSTRUCTIONS } from "./sideChatInstructions.ts";
import {
  applySideChatProviderEvent,
  chain,
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
  /** A stop that arrived before Codex reported the turn's id; applied once it does. Guarded by `lock`. */
  interruptRequested: boolean;
  /** When its state last changed, in epoch milliseconds. Guarded by `lock`. */
  lastActivityAt: number;
}

/** Like Codex's own side conversations, a side chat with nothing happening for this long ends. */
const IDLE_CLOSE_AFTER_MS = 30 * 60 * 1000;

/** The message a side turn starts with, and the selection overrides it carries. */
interface SideTurnInput {
  readonly text: string;
  readonly modelSelection?: ModelSelection | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
}

const failureMessage = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.squash(cause);
  return failure instanceof Error ? failure.message : String(failure);
};

const unchanged = (snapshot: SideChatSnapshot): SideChatTransition => ({ snapshot, events: [] });

/** Frames with the same key replace one another: each carries its entry's whole current state. */
const frameKey = (event: SideChatStreamEvent): string => {
  switch (event.type) {
    case "turn-item":
      return `turn-item:${event.turnItem.id}`;
    case "runtime-request":
      return `runtime-request:${event.runtimeRequest.id}`;
    default:
      return event.type;
  }
};

/**
 * Delivers a subscription's frames, folding the ones the client has not taken yet. While a slow
 * client acknowledges a batch, a streaming answer rewrites its pending frame in place instead of
 * queueing every partial copy, so a subscriber holds at most one frame per entry. Map insertion
 * order keeps first-seen order for new entries.
 */
const coalescedFrames = (
  sideChatId: ThreadId,
  subscription: PubSub.Subscription<SideChatStreamEvent>,
): Stream.Stream<SideChatStreamEvent> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const pending = new Map<string, SideChatStreamEvent>();
      const ready = yield* Latch.make(false);
      yield* Stream.runForEachArray(Stream.fromSubscription(subscription), (events) =>
        Effect.sync(() => {
          for (const event of events) pending.set(frameKey(event), event);
        }).pipe(Effect.andThen(ready.open)),
      ).pipe(
        // A shut-down PubSub can drop the final frame; the subscriber still has to end.
        Effect.ensuring(
          Effect.sync(() => pending.set("closed", { type: "closed", sideChatId })).pipe(
            Effect.andThen(ready.open),
          ),
        ),
        Effect.forkScoped,
      );
      return Stream.fromEffectRepeat(
        ready.await.pipe(
          Effect.andThen(
            Effect.sync(() => {
              const batch = Array.from(pending.values());
              pending.clear();
              ready.closeUnsafe();
              return batch;
            }),
          ),
        ),
      ).pipe(Stream.flattenIterable);
    }),
  );

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const runtimePolicies = yield* RuntimePolicy.RuntimePolicyV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
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
        chat.lastActivityAt = yield* Clock.currentTimeMillis;
        if (transition.events.length > 0) yield* PubSub.publishAll(chat.changes, transition.events);
        return result;
      }),
    );
  /** Changes an open side chat. Closing is final, so late writers leave a closed one alone. */
  const update = (chat: SideChat, f: (snapshot: SideChatSnapshot) => SideChatTransition) =>
    modify(
      chat,
      (snapshot) =>
        [undefined, snapshot.status === "closed" ? unchanged(snapshot) : f(snapshot)] as const,
    );

  const reject = (parentThreadId: ThreadId, detail: string) => (cause?: unknown) =>
    new SideChatRejectedError({ parentThreadId, detail, ...(cause ? { cause } : {}) });

  const requireChat = (input: SideChatTargetInput) => {
    const chat = byId.get(input.sideChatId);
    return chat === undefined || chat.parentThread.id !== input.parentThreadId
      ? Effect.fail(new SideChatNotFoundError({ sideChatId: input.sideChatId }))
      : Effect.succeed(chat);
  };

  /**
   * Forgets the side chat and tells its subscribers, then ends its scope in the background:
   * stopping the provider process can take a while, and callers hold the global `openLock` or
   * an RPC that a disconnect may interrupt.
   */
  const closeChat = (chat: SideChat) =>
    Effect.gen(function* () {
      if (byId.get(chat.sideChatId) !== chat) return;
      byId.delete(chat.sideChatId);
      byParent.delete(chat.parentThread.id);
      yield* modify(chat, (snapshot) => {
        const closed = patchSideChat(snapshot, { status: "closed", activeProviderTurnId: null });
        return [
          undefined,
          { snapshot: closed.snapshot, events: [{ type: "closed", sideChatId: chat.sideChatId }] },
        ] as const;
      });
      yield* Deferred.fail(
        chat.session,
        new SideChatNotFoundError({ sideChatId: chat.sideChatId }),
      );
      // Interrupts the event fiber, then stops the side chat's provider process.
      yield* Scope.close(chat.scope, Exit.void).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
            ? Effect.logWarning("Failed to stop a side chat's provider process.", {
                cause: exit.cause,
              })
            : Effect.void,
        ),
        Effect.ensuring(PubSub.shutdown(chat.changes)),
        Effect.forkDetach({ startImmediately: true }),
      );
    }).pipe(Effect.uninterruptible);

  const closeWhere = (matches: (chat: SideChat) => boolean) =>
    openLock.withPermit(
      Effect.suspend(() =>
        Effect.forEach(Array.from(byId.values()).filter(matches), closeChat, { discard: true }),
      ),
    );

  /** Stops a provider turn on behalf of a stop the user requested before it had an id. */
  const interruptLater = (chat: SideChat, providerTurnId: ProviderTurnId) =>
    Deferred.await(chat.session).pipe(
      Effect.flatMap(({ runtime, providerThread }) =>
        runtime.interruptTurn({ providerThread, providerTurnId }),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("Failed to stop the side chat.", { cause }),
      ),
      Effect.forkIn(chat.scope),
    );

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
      let providerThreadId: ProviderThreadId | null = null;
      yield* Stream.runForEach(runtime.events, (event) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const turnToInterrupt = yield* modify(chat, (current) => {
            if (current.status === "closed") return [null, unchanged(current)] as const;
            const transition = applySideChatProviderEvent(current, event, {
              providerThreadId,
              idAllocator,
              now,
            });
            const turnId = transition.snapshot.activeProviderTurnId;
            if (!chat.interruptRequested || turnId === null) return [null, transition] as const;
            chat.interruptRequested = false;
            return [turnId, transition] as const;
          });
          if (turnToInterrupt !== null) yield* interruptLater(chat, turnToInterrupt);
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("Side chat provider event stream failed.", { cause }).pipe(
                Effect.andThen(
                  update(chat, (current) =>
                    patchSideChat(current, {
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
      providerThreadId = providerThread.id;
      // Idle first: a send that wakes on the session must find the side chat ready.
      yield* update(chat, (current) =>
        current.status === "starting"
          ? patchSideChat(current, { status: "idle" })
          : unchanged(current),
      );
      yield* Deferred.succeed(chat.session, { runtime, providerThread });
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

  /** The Codex model the parent last ran on its active Codex thread. */
  const lastCodexModelSelection = (
    parentThreadId: ThreadId,
    providerThread: OrchestrationV2ProviderThread,
  ) =>
    threads.getThreadRecords(parentThreadId, ["runs"]).pipe(
      Effect.mapError(reject(parentThreadId, "The thread could not be loaded.")),
      Effect.flatMap(({ runs }) => {
        const lastRun = runs
          .filter(
            (run) =>
              run.providerThreadId === providerThread.id &&
              run.modelSelection.instanceId === providerThread.providerInstanceId,
          )
          .reduce<(typeof runs)[number] | undefined>(
            (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
            undefined,
          );
        return lastRun === undefined
          ? Effect.fail(
              reject(parentThreadId, "Switch this thread back to Codex to start a side chat.")(),
            )
          : Effect.succeed(lastRun.modelSelection);
      }),
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
        if (parentThread.deletedAt !== null) {
          return yield* reject(parentThreadId, "The thread could not be loaded.")();
        }
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
        // A parent whose picker moved to another provider still forks with its Codex model.
        const modelSelection =
          parentThread.modelSelection.instanceId === providerThread.providerInstanceId
            ? parentThread.modelSelection
            : yield* lastCodexModelSelection(parentThreadId, providerThread);
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
          interruptRequested: false,
          lastActivityAt: yield* Clock.currentTimeMillis,
        };
        byParent.set(parentThreadId, chat);
        byId.set(sideChatId, chat);
        yield* start(chat, { adapter, sourceNativeThreadId, runtimePolicy }).pipe(
          Effect.forkIn(chat.scope),
        );
        return snapshot;
      }),
    );

  /** Claims the idle side chat for a turn, records the user's message, and starts the turn. */
  const startSideTurn = (chat: SideChat, session: SideChatSession, input: SideTurnInput) =>
    Effect.gen(function* () {
      const { runtime, providerThread } = session;
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
        if (snapshot.status !== "idle") return [snapshot.status, unchanged(snapshot)] as const;
        chat.interruptRequested = false;
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
          text: input.text,
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
            text: input.text,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection,
          runtimePolicy,
        })
        .pipe(
          // Release the claim on failure or interruption, or the side chat stays "running".
          Effect.onError((cause) =>
            update(chat, (snapshot) => {
              if (snapshot.status !== "running") return unchanged(snapshot);
              chat.interruptRequested = false;
              return patchSideChat(snapshot, {
                status: "idle",
                activeProviderTurnId: null,
                ...(Cause.hasInterruptsOnly(cause)
                  ? {}
                  : { error: "Failed to send the side chat message." }),
              });
            }),
          ),
          // The start belongs to the side chat, not to the request: a dropped RPC must not
          // leave Codex running a turn nobody tracks. Closing the side chat still interrupts it.
          Effect.forkIn(chat.scope),
          Effect.flatMap(Fiber.join),
          Effect.mapError(
            (cause) =>
              new SideChatProviderError({ sideChatId: chat.sideChatId, operation: "send", cause }),
          ),
        );
    });

  /** Adds a message to the running turn, the way the main chat steers an active run. */
  const steerSideTurn = (
    chat: SideChat,
    session: SideChatSession,
    input: { readonly providerTurnId: ProviderTurnId; readonly text: string },
  ) =>
    Effect.gen(function* () {
      const snapshot = yield* Ref.get(chat.state);
      const userMessages = snapshot.turnItems.filter((item) => item.type === "user_message");
      const runId = userMessages.at(-1)?.runId;
      if (runId === undefined || runId === null) {
        return yield* reject(chat.parentThread.id, "The side chat is still answering.")();
      }
      const uuid = yield* randomUuidV4;
      const messageId = MessageId.make(`side-message:${uuid}`);
      const message = {
        messageId,
        text: input.text,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      } as const;
      yield* session.runtime
        .steerTurn({
          threadId: chat.sideChatId,
          runId,
          providerThread: session.providerThread,
          providerTurnId: input.providerTurnId,
          message,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new SideChatProviderError({ sideChatId: chat.sideChatId, operation: "send", cause }),
          ),
        );
      const now = yield* DateTime.now;
      yield* update(chat, (current) =>
        upsertSideChatTurnItem(current, {
          ...message,
          id: TurnItemId.make(`side-user:${uuid}`),
          threadId: chat.sideChatId,
          runId,
          nodeId: null,
          providerThreadId: session.providerThread.id,
          providerTurnId: input.providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: userMessages.length * 100 + 50,
          status: "completed",
          title: null,
          type: "user_message",
          inputIntent: "steer",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        }),
      );
    });

  const send: SideChatService["Service"]["send"] = (input) =>
    Effect.gen(function* () {
      const chat = yield* requireChat(input);
      const session = yield* Deferred.await(chat.session);
      yield* startSideTurn(chat, session, {
        text: input.input,
        modelSelection: input.modelSelection,
        interactionMode: input.interactionMode,
        runtimeMode: input.runtimeMode,
      });
    });

  const interrupt: SideChatService["Service"]["interrupt"] = (input) =>
    Effect.gen(function* () {
      const chat = yield* requireChat(input);
      const { runtime, providerThread } = yield* Deferred.await(chat.session);
      const providerTurnId = yield* modify(chat, (snapshot) => {
        if (snapshot.status !== "running") return [null, unchanged(snapshot)] as const;
        // Codex has not reported the turn yet; stop it as soon as it does.
        if (snapshot.activeProviderTurnId === null) chat.interruptRequested = true;
        return [snapshot.activeProviderTurnId, unchanged(snapshot)] as const;
      });
      if (providerTurnId === null) return;
      yield* runtime.interruptTurn({ providerThread, providerTurnId }).pipe(
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

  /** Records a request's answer the way orchestration does; providers do not report it. */
  const resolveRequest = (
    chat: SideChat,
    request: OrchestrationV2RuntimeRequest,
    input: SideChatRespondInput,
  ) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const cancelled = input.decision === "decline" || input.decision === "cancel";
      yield* update(chat, (snapshot) => {
        const resolved = upsertSideChatRuntimeRequest(snapshot, {
          ...request,
          status: "resolved",
          resolvedAt: now,
          ...(input.decision === undefined ? {} : { decision: input.decision }),
          ...(input.answers === undefined ? {} : { answers: input.answers }),
        });
        if (request.responseCapability.type !== "message") return resolved;
        const item = snapshot.turnItems.findLast(
          (candidate) =>
            candidate.type === "user_input_request" && candidate.requestId === request.id,
        );
        if (item?.type !== "user_input_request") return resolved;
        const answers = input.answers;
        return chain(resolved, (current) =>
          upsertSideChatTurnItem(current, {
            ...item,
            ...(!cancelled && answers !== undefined
              ? {
                  questionAnswer: {
                    requestId: request.id,
                    answers,
                    attachmentsByQuestionId: {},
                    questionTextById: Object.fromEntries(
                      item.questions.map((question) => [question.id, question.question]),
                    ),
                  },
                }
              : {}),
            status: cancelled ? "cancelled" : "completed",
            completedAt: now,
            updatedAt: now,
          }),
        );
      });
    });

  /**
   * Codex async questions are not live provider requests: the answer is an ordinary user
   * message (steering the running turn when it can, otherwise starting the next turn) and a
   * dismissal only resolves the question here.
   */
  const respondByMessage = (
    chat: SideChat,
    session: SideChatSession,
    request: OrchestrationV2RuntimeRequest,
    input: SideChatRespondInput,
  ) =>
    Effect.gen(function* () {
      if (input.decision === "decline" || input.decision === "cancel") {
        return yield* resolveRequest(chat, request, input);
      }
      const snapshot = yield* Ref.get(chat.state);
      const item = snapshot.turnItems.findLast(
        (candidate) =>
          candidate.type === "user_input_request" && candidate.requestId === request.id,
      );
      if (item?.type !== "user_input_request") {
        return yield* reject(
          chat.parentThread.id,
          "The question for this request was not found.",
        )();
      }
      const replies: string[] = [];
      for (const question of item.questions) {
        const answer = input.answers?.[question.id];
        if (typeof answer !== "string" || answer.trim().length === 0) {
          if (question.required === false) continue;
          return yield* reject(chat.parentThread.id, "Answer each question before sending.")();
        }
        replies.push(`${question.question}\n${answer.trim()}`);
      }
      if (replies.length === 0) {
        return yield* reject(chat.parentThread.id, "Enter an answer before sending.")();
      }
      const text = replies.join("\n\n");
      const activeProviderTurnId =
        snapshot.status === "running" ? snapshot.activeProviderTurnId : null;
      if (
        activeProviderTurnId !== null &&
        session.runtime.providerSession.capabilities.turns.supportsActiveSteering
      ) {
        yield* steerSideTurn(chat, session, { providerTurnId: activeProviderTurnId, text });
      } else {
        yield* startSideTurn(chat, session, { text });
      }
      yield* resolveRequest(chat, request, input);
    });

  const respond: SideChatService["Service"]["respond"] = (input) =>
    Effect.gen(function* () {
      const chat = yield* requireChat(input);
      const session = yield* Deferred.await(chat.session);
      const request = (yield* Ref.get(chat.state)).runtimeRequests.find(
        (candidate) => candidate.id === input.requestId,
      );
      if (request?.responseCapability.type === "message") {
        if (request.status !== "pending") return;
        return yield* respondByMessage(chat, session, request, input);
      }
      yield* session.runtime
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
      if (request !== undefined) yield* resolveRequest(chat, request, input);
    });

  const close: SideChatService["Service"]["close"] = (input) =>
    closeWhere(
      (chat) =>
        chat.sideChatId === input.sideChatId && chat.parentThread.id === input.parentThreadId,
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
        // It closed between the lookup and the read; nothing more will arrive.
        if (snapshot.status === "closed") return Stream.make(initial);
        return Stream.concat(
          Stream.make(initial),
          coalescedFrames(chat.sideChatId, subscription),
        ).pipe(Stream.takeUntil((event) => event.type === "closed"));
      }),
    );

  // A side chat ends with its thread: an archived or deleted thread is done with.
  yield* forkParked(
    Stream.runForEach(threads.streamDomainEvents, (event) =>
      event.type === "thread.archived" || event.type === "thread.deleted"
        ? closeWhere((chat) => chat.parentThread.id === event.threadId)
        : Effect.void,
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("Side chats stopped following thread deletions.", { cause }),
      ),
    ),
  );

  // Ends side chats with no turn running and no change for IDLE_CLOSE_AFTER_MS.
  yield* forkParked(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const idle = new Set<SideChat>();
      for (const chat of Array.from(byId.values())) {
        const snapshot = yield* chat.lock.withPermit(Ref.get(chat.state));
        const working = snapshot.status === "running" || snapshot.status === "starting";
        if (!working && now - chat.lastActivityAt >= IDLE_CLOSE_AFTER_MS) idle.add(chat);
      }
      if (idle.size > 0) yield* closeWhere((chat) => idle.has(chat));
    }).pipe(Effect.repeat(Schedule.spaced("1 minute"))),
  );

  return SideChatService.of({ open, send, interrupt, respond, close, subscribe });
});

export const layer = Layer.effect(SideChatService, make);
