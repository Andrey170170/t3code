import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProviderSessionId,
  RunId,
  ThreadId,
  TRELLIS_LANDING_PAD_PROJECT_ID,
  TrellisError,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";

import { EffectOutboxV2 } from "../orchestration-v2/EffectOutbox.ts";
import { OrchestrationEffectWorkerV2 } from "../orchestration-v2/EffectWorker.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import {
  ProjectionStoreThreadNotFoundError,
  ProjectionStoreV2,
} from "../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { TurnAdmission } from "../orchestration-v2/TurnAdmission.ts";
import { makeTestTrellis, Trellis } from "./Trellis.ts";
import {
  createThread,
  modelSelection,
  projectEvent,
  sendMessage,
  TrellisOrchestratorTestLayer,
  writeEvent,
} from "./TrellisOrchestrator.testkit.ts";
import * as TrellisRestore from "./TrellisRestore.ts";
import * as TrellisTurns from "./TrellisTurns.ts";

const WS_A = "/trellis/workspaces/ws-a/project";
const WS_B = "/trellis/workspaces/ws-b/project";

type Message =
  | {
      readonly kind: "start" | "end";
      readonly target: string;
      readonly turn: string;
      readonly seq: number;
    }
  | { readonly kind: "put"; readonly open: ReadonlyArray<string>; readonly seq: number };

/**
 * A Trellis that records turn messages. `startGate` holds a start the way a
 * checkpoint does and answers with the workspaces it restarted; `failNext`
 * refuses the next message with the given error.
 */
function makeTurnsTrellis() {
  const messages: Array<Message> = [];
  const state: {
    startGate?: Deferred.Deferred<ReadonlyArray<string>>;
    failNext?: string | undefined;
    connects: number;
  } = { connects: 1 };
  const refuse = () => {
    const message = state.failNext;
    state.failNext = undefined;
    return message === undefined ? undefined : new TrellisError({ message });
  };
  const trellis = makeTestTrellis({
    env: { root: "/trellis", bin: "trellis", shimDir: "/t3/trellis-shims" },
    connects: Effect.sync(() => state.connects),
    reportTurn: ({ target, turn, event, seq }) =>
      Effect.gen(function* () {
        const error = refuse();
        if (error !== undefined) return yield* error;
        const gate = event === "start" ? state.startGate : undefined;
        const restarted = gate === undefined ? [] : yield* Deferred.await(gate);
        messages.push({ kind: event, target, turn, seq });
        return { restarted };
      }),
    replaceTurns: ({ open, seq }) =>
      Effect.gen(function* () {
        const error = refuse();
        if (error !== undefined) return yield* error;
        messages.push({ kind: "put", open: open.map((entry) => entry.turn), seq });
        return { restarted: [] };
      }),
  });
  return { trellis, messages, state };
}

/** The admission seam with turn reporting, over a mocked V2 and session manager. */
function admissionLayer(fake: ReturnType<typeof makeTurnsTrellis>) {
  const released: Array<string> = [];
  const trellisLayer = Layer.succeed(Trellis, fake.trellis);
  const layer = TrellisRestore.layer.pipe(
    Layer.provide(Layer.mock(ProjectStoreV2)({})),
    Layer.provide(Layer.mock(EffectOutboxV2)({})),
    Layer.provide(
      Layer.mock(ProjectionStoreV2)({
        getThread: (threadId: ThreadId) =>
          Effect.fail(new ProjectionStoreThreadNotFoundError({ threadId })),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderSessionManagerV2)({
        listLive: Effect.succeed([
          { providerSessionId: ProviderSessionId.make("session-a"), cwd: WS_A },
          { providerSessionId: ProviderSessionId.make("session-a-idea"), cwd: `${WS_A}/idea-x` },
          { providerSessionId: ProviderSessionId.make("session-b"), cwd: WS_B },
        ]),
        release: ({ providerSessionId }) =>
          Effect.sync(() => void released.push(providerSessionId)),
      }),
    ),
    Layer.provideMerge(TrellisRestore.gateLayer),
    Layer.provideMerge(TrellisTurns.layer),
    Layer.provide(trellisLayer),
  );
  return { layer, released };
}

const turn = (name: string) => ({
  threadId: ThreadId.make(`thread-${name}`),
  runId: RunId.make(`run-${name}`),
});

it.effect("reports a turn's start before its session opens and its end once", () => {
  const fake = makeTurnsTrellis();
  const { layer } = admissionLayer(fake);
  return Effect.gen(function* () {
    const admission = yield* TurnAdmission;
    const turns = yield* TrellisTurns.TrellisTurns;
    const one = turn("one");
    assert.isFalse(yield* admission.start({ ...one, cwd: WS_A }));
    // A start retry reports again; Trellis keeps one open turn.
    assert.isFalse(yield* admission.start({ ...one, cwd: WS_A }));
    yield* admission.end({ ...one, status: "completed" });
    yield* admission.end({ ...one, status: "completed" });
    yield* turns.awaitEnded([one.runId]);
    // Outside Trellis nothing is reported.
    assert.isFalse(yield* admission.start({ ...turn("host"), cwd: process.cwd() }));
    const sent = fake.messages.filter((message) => message.kind !== "put");
    assert.deepEqual(
      sent.map((message) => message.kind),
      ["start", "start", "end"],
    );
    assert.isTrue(sent.every((message) => "target" in message && message.target === WS_A));
    const seqs = fake.messages.map((message) => message.seq);
    assert.deepEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  "a start waits while its workspace checkpoints, and a restart releases its sessions",
  () => {
    const fake = makeTurnsTrellis();
    const { layer, released } = admissionLayer(fake);
    return Effect.gen(function* () {
      const admission = yield* TurnAdmission;
      const gate = yield* Deferred.make<ReadonlyArray<string>>();
      fake.state.startGate = gate;
      const one = turn("one");
      const starting = yield* Effect.forkChild(admission.start({ ...one, cwd: `${WS_A}/sub` }));
      yield* Effect.yieldNow;
      assert.isUndefined(starting.pollUnsafe());
      assert.deepEqual(released, []);
      // The checkpoint ends, having restarted the workspace.
      yield* Deferred.succeed(gate, ["ws-a"]);
      assert.isTrue(yield* Fiber.join(starting));
      assert.deepEqual(released, ["session-a", "session-a-idea"]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "a turn admitted as T3's checkpoint ends waits until that checkpoint released the sessions",
  () => {
    const fake = makeTurnsTrellis();
    const { layer, released } = admissionLayer(fake);
    return Effect.gen(function* () {
      const admission = yield* TurnAdmission;
      const gate = yield* TrellisRestore.TrellisRestoreGate;
      const checkpointEnds = yield* Deferred.make<ReadonlyArray<string>>();
      fake.state.startGate = checkpointEnds;
      const starting = yield* Effect.forkChild(admission.start({ ...turn("one"), cwd: WS_A }));
      yield* Effect.yieldNow;
      // The checkpoint tool holds the workspace from before its checkpoint ...
      const sessionsReleased = yield* Deferred.make<void>();
      const checkpoint = yield* Effect.forkChild(
        Effect.scoped(gate.hold([WS_A]).pipe(Effect.andThen(Deferred.await(sessionsReleased)))),
      );
      yield* Effect.yieldNow;
      // ... Trellis lets the waiting start through before T3 has its answer ...
      yield* Deferred.succeed(checkpointEnds, ["ws-a"]);
      yield* Effect.yieldNow;
      assert.isUndefined(starting.pollUnsafe());
      assert.deepEqual(released, []);
      // ... and the turn proceeds once the tool released the sessions.
      yield* Deferred.succeed(sessionsReleased, undefined);
      yield* Fiber.join(checkpoint);
      assert.isTrue(yield* Fiber.join(starting));
      assert.deepEqual(released, ["session-a", "session-a-idea"]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("turns that waited through one restart release its sessions once", () => {
  const fake = makeTurnsTrellis();
  const { layer, released } = admissionLayer(fake);
  return Effect.gen(function* () {
    const admission = yield* TurnAdmission;
    const checkpointEnds = yield* Deferred.make<ReadonlyArray<string>>();
    fake.state.startGate = checkpointEnds;
    const first = yield* Effect.forkChild(admission.start({ ...turn("one"), cwd: WS_A }));
    const second = yield* Effect.forkChild(admission.start({ ...turn("two"), cwd: `${WS_A}/x` }));
    yield* Effect.yieldNow;
    yield* Deferred.succeed(checkpointEnds, ["ws-a"]);
    assert.isTrue(yield* Fiber.join(first));
    assert.isTrue(yield* Fiber.join(second));
    // The second would otherwise release the session the first opened meanwhile.
    assert.deepEqual(released, ["session-a", "session-a-idea"]);
  }).pipe(Effect.provide(layer));
});

it.effect("an end waits for its run's start that is still waiting", () => {
  const fake = makeTurnsTrellis();
  const { layer } = admissionLayer(fake);
  return Effect.gen(function* () {
    const admission = yield* TurnAdmission;
    const turns = yield* TrellisTurns.TrellisTurns;
    const gate = yield* Deferred.make<ReadonlyArray<string>>();
    fake.state.startGate = gate;
    const one = turn("one");
    const starting = yield* Effect.forkChild(admission.start({ ...one, cwd: WS_A }));
    yield* Effect.yieldNow;
    // Cancelled while its start waits on a checkpoint.
    yield* admission.end({ ...one, status: "cancelled" });
    yield* Deferred.succeed(gate, []);
    yield* Fiber.join(starting);
    yield* turns.awaitEnded([one.runId]);
    assert.deepEqual(
      fake.messages.filter((message) => message.kind !== "put").map((message) => message.kind),
      ["start", "end"],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("a message Trellis finds stale is resent with a newer sequence number", () => {
  const fake = makeTurnsTrellis();
  const { layer } = admissionLayer(fake);
  return Effect.gen(function* () {
    const admission = yield* TurnAdmission;
    fake.state.failNext = "turn message 7 is older than one already applied";
    yield* admission.start({ ...turn("one"), cwd: WS_A });
    const starts = fake.messages.filter((message) => message.kind === "start");
    assert.equal(starts.length, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("open turns are resynchronized on every connect and after a lost message", () => {
  const fake = makeTurnsTrellis();
  const { layer } = admissionLayer(fake);
  const puts = () =>
    fake.messages.flatMap((message) => (message.kind === "put" ? [message.open] : []));
  return Effect.gen(function* () {
    const admission = yield* TurnAdmission;
    // The first connect (as after a T3 restart): nothing is open yet.
    yield* Effect.yieldNow;
    assert.deepEqual(puts(), [[]]);
    const one = turn("one");
    const two = turn("two");
    yield* admission.start({ ...one, cwd: WS_A });
    yield* admission.start({ ...two, cwd: WS_B });
    // Nothing new: no resynchronization.
    yield* TestClock.adjust("5 seconds");
    assert.equal(puts().length, 1);
    // Trellis restarted: a reconnect.
    fake.state.connects = 2;
    yield* TestClock.adjust("5 seconds");
    assert.deepEqual(puts().at(-1), [one.runId, two.runId]);
    // An end that cannot be delivered is corrected by the next resynchronization.
    fake.state.failNext = "Trellis is unavailable: connect ENOENT";
    yield* admission.end({ ...one, status: "completed" });
    yield* (yield* TrellisTurns.TrellisTurns).awaitEnded([one.runId]);
    yield* TestClock.adjust("5 seconds");
    assert.deepEqual(puts().at(-1), [two.runId]);
  }).pipe(Effect.provide(layer));
});

// ---- through the orchestrator --------------------------------------------

/** V2 with in-memory persistence, Trellis turn reporting and the recording Trellis. */
function orchestratorLayer(fake: ReturnType<typeof makeTurnsTrellis>) {
  return TrellisOrchestratorTestLayer.pipe(
    Layer.provideMerge(TrellisTurns.layer),
    Layer.provide(TrellisRestore.gateLayer),
    Layer.provide(Layer.succeed(Trellis, fake.trellis)),
  );
}

const runOf = (threadId: ThreadId) =>
  Effect.flatMap(OrchestratorV2, (orchestrator) => orchestrator.getThreadProjection(threadId)).pipe(
    Effect.map((projection) => projection.runs.at(-1)!),
  );

it.effect("every way a run ends reports its turn's end", () => {
  const fake = makeTurnsTrellis();
  return Effect.gen(function* () {
    const worker = yield* OrchestrationEffectWorkerV2;
    const turns = yield* TrellisTurns.TrellisTurns;
    const ended = (runId: RunId) =>
      turns
        .awaitEnded([runId])
        .pipe(
          Effect.andThen(
            Effect.sync(() =>
              fake.messages.some((message) => message.kind === "end" && message.turn === runId),
            ),
          ),
        );

    // Settled by the provider turn start before any provider runs: an empty /compact.
    const compact = yield* createThread("compact", WS_A);
    yield* sendMessage(compact.threadId, "/compact");
    yield* worker.drain();
    const compactRun = yield* runOf(compact.threadId);
    assert.equal(compactRun.status, "failed");
    assert.isTrue(fake.messages.some((m) => m.kind === "start" && m.turn === compactRun.id));
    assert.isTrue(yield* ended(compactRun.id));

    // A session that cannot open fails the run at its last start attempt.
    const refused = yield* createThread("refused", WS_B);
    yield* sendMessage(refused.threadId, "hello");
    for (let attempt = 0; attempt < 10; attempt++) {
      yield* worker.drain();
      if ((yield* runOf(refused.threadId)).status === "failed") break;
      yield* TestClock.adjust("10 minutes");
    }
    const refusedRun = yield* runOf(refused.threadId);
    assert.equal(refusedRun.status, "failed");
    assert.isTrue(yield* ended(refusedRun.id));

    // Runs the provider ended: completed, interrupted, cancelled, failed.
    for (const status of ["completed", "interrupted", "cancelled", "failed"] as const) {
      const { threadId } = yield* createThread(`ended-${status}`, WS_A);
      yield* sendMessage(threadId, "work");
      const run = yield* runOf(threadId);
      // Admitted as the provider turn start does (shown above).
      yield* turns.start({ threadId, runId: run.id, cwd: WS_A });
      yield* writeEvent({
        id: `ended-${status}` as never,
        type: "run.updated",
        threadId,
        runId: run.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: run.requestedAt,
        payload: { ...run, status, completedAt: run.requestedAt },
      });
      assert.isTrue(yield* ended(run.id), status);
    }
  }).pipe(Effect.provide(orchestratorLayer(fake)));
});
