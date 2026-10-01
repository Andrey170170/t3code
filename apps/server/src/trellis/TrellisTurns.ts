/**
 * TrellisTurns - reports T3's turns to Trellis.
 *
 * Trellis keeps the set of open turns per workspace (`POST /v1/turns`): a
 * checkpoint refuses while another thread has one open, and a turn starting
 * during a checkpoint waits until it ends. T3 reports a turn start from turn
 * admission (before the provider session opens) and its end from V2's
 * terminal-run handler, for every run in a Trellis path, keyed by run id.
 *
 * Messages carry an increasing `seq` (Trellis refuses one older than a
 * message it already applied, so a stale resynchronization cannot erase a
 * newer start). Starts and ends are idempotent in Trellis, so a stale one is
 * resent with a new `seq`. The whole set is resynchronized (`PUT`) whenever
 * Trellis becomes reachable, including the first time after a T3 restart
 * (when nothing is open yet), and after any message failed to arrive; when
 * T3 stops, it clears them.
 *
 * @module trellis/TrellisTurns
 */
import type { RunId, ThreadId, TrellisError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import { isStaleTurnMessage, Trellis, trellisWorkspaceOf } from "./Trellis.ts";

export interface TrellisTurnsShape {
  /**
   * Reports that `runId` starts a turn in the Trellis path `cwd` (canonical),
   * waiting while its workspace is checkpointing. `restarted` is true when a
   * checkpoint stopped and restarted the workspace since the last start
   * there, so its provider processes are gone. Never fails: an unreachable
   * Trellis admits the turn and the next resynchronization records it.
   */
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly cwd: string;
  }) => Effect.Effect<{ readonly restarted: boolean }>;
  /** Reports that `runId` ended, in the background; a run never started is ignored. */
  readonly end: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void>;
  /** Waits until each run's end has been reported (or was not open). */
  readonly awaitEnded: (runIds: ReadonlyArray<RunId>) => Effect.Effect<void>;
  /** Replaces Trellis's open turns with T3's (waiting while a named workspace checkpoints). */
  readonly reconcile: Effect.Effect<void>;
}

export class TrellisTurns extends Context.Service<TrellisTurns, TrellisTurnsShape>()(
  "t3/trellis/TrellisTurns",
) {}

/** How often the connection is checked for a resynchronization. */
const RECONCILE_INTERVAL = Duration.seconds(5);
/** How long shutdown waits for Trellis before leaving the rest to the next start. */
const SHUTDOWN_WAIT = Duration.seconds(5);
/** Resends of a message refused as stale before it counts as failed. */
const STALE_RETRIES = 3;

interface OpenTurn {
  readonly threadId: ThreadId;
  readonly cwd: string;
  /** Orders a run's start and end messages. */
  readonly lock: Semaphore.Semaphore;
  readonly ended: Deferred.Deferred<void>;
}

const make = Effect.gen(function* () {
  const trellis = yield* Trellis;
  const scope = yield* Effect.scope;
  const open = new Map<RunId, OpenTurn>();
  // Ended runs whose end message is still being sent.
  const ending = new Map<RunId, OpenTurn>();
  let lastSeq = 0;
  let dirty = false;
  let syncedConnects = 0;

  // Microseconds since the epoch, so the sequence keeps increasing across T3 restarts.
  const nextSeq = Effect.map(Clock.currentTimeMillis, (now) => {
    lastSeq = Math.max(lastSeq + 1, now * 1000);
    return lastSeq;
  });

  /** Sends one message, resending it with a new `seq` when refused as stale. */
  const send = <A>(
    what: string,
    message: (seq: number) => Effect.Effect<A, TrellisError>,
  ): Effect.Effect<Option.Option<A>> =>
    Effect.gen(function* () {
      for (let attempt = 0; ; attempt++) {
        const result = yield* Effect.result(Effect.flatMap(nextSeq, message));
        if (result._tag === "Success") return Option.some(result.success);
        if (isStaleTurnMessage(result.failure) && attempt < STALE_RETRIES) continue;
        // Whatever Trellis holds now is resynchronized once it is reachable.
        dirty = true;
        yield* Effect.logWarning("could not report a turn to Trellis", {
          message: what,
          detail: result.failure.message,
        });
        return Option.none<A>();
      }
    });

  const workspaceOf = (cwd: string) =>
    Effect.map(trellis.expectedRoots, (roots) => trellisWorkspaceOf(roots, cwd));

  const start: TrellisTurnsShape["start"] = ({ threadId, runId, cwd }) =>
    Effect.gen(function* () {
      const turn: OpenTurn = open.get(runId) ?? {
        threadId,
        cwd,
        lock: yield* Semaphore.make(1),
        ended: yield* Deferred.make<void>(),
      };
      // Open before the message goes out, so a resynchronization meanwhile keeps it.
      open.set(runId, turn);
      const workspace = yield* workspaceOf(cwd);
      const reply = yield* send("start", (seq) =>
        trellis.reportTurn({ target: cwd, thread: threadId, turn: runId, event: "start", seq }),
      ).pipe(turn.lock.withPermits(1));
      return {
        restarted:
          workspace !== null && Option.isSome(reply) && reply.value.restarted.includes(workspace),
      };
    });

  const end: TrellisTurnsShape["end"] = ({ threadId, runId }) =>
    Effect.gen(function* () {
      const turn = open.get(runId);
      if (turn === undefined) return;
      open.delete(runId);
      ending.set(runId, turn);
      // After any start message still in flight for this run (the lock).
      yield* send("end", (seq) =>
        trellis.reportTurn({ target: turn.cwd, thread: threadId, turn: runId, event: "end", seq }),
      ).pipe(
        turn.lock.withPermits(1),
        // Finishes even while T3 shuts down (see the finalizer).
        Effect.uninterruptible,
        Effect.ensuring(
          Effect.sync(() => ending.delete(runId)).pipe(
            Effect.andThen(Deferred.succeed(turn.ended, undefined)),
          ),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      );
    });

  const awaitEnded: TrellisTurnsShape["awaitEnded"] = (runIds) =>
    Effect.forEach(
      runIds,
      (runId) => {
        const turn = open.get(runId) ?? ending.get(runId);
        return turn === undefined ? Effect.void : Deferred.await(turn.ended);
      },
      { discard: true },
    );

  const reconcile: TrellisTurnsShape["reconcile"] = Effect.gen(function* () {
    // Read and cleared before the message is built: a failure marks it again.
    dirty = false;
    // A restart it waited through ended turns whose sessions died with their
    // processes and were released then; it adds nothing for later turns.
    yield* send("resynchronization", (seq) =>
      trellis.replaceTurns({
        open: [...open].map(([runId, turn]) => ({
          target: turn.cwd,
          thread: turn.threadId,
          turn: runId,
        })),
        seq,
      }),
    );
  });

  // Resynchronizes on every connect and after a failed message.
  const syncIfNeeded = Effect.gen(function* () {
    if ((yield* trellis.current) === null) return;
    const connects = yield* trellis.connects;
    if (connects === syncedConnects && !dirty) return;
    syncedConnects = connects;
    yield* reconcile;
  });
  // T3 stopping ends every turn it runs: their providers stop with it. Ends
  // still being sent finish first, then Trellis forgets the rest, so no
  // stale turn blocks checkpoints until T3 is back.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if ((yield* trellis.current) === null) return;
      // Ends being sent finished already: their fibers are uninterruptible and
      // were forked after this finalizer, so the scope closed them first.
      open.clear();
      yield* send("shutdown", (seq) => trellis.replaceTurns({ open: [], seq })).pipe(
        Effect.timeoutOption(SHUTDOWN_WAIT),
      );
    }),
  );
  yield* syncIfNeeded.pipe(
    Effect.repeat(Schedule.spaced(RECONCILE_INTERVAL)),
    Effect.forkIn(scope),
  );

  return TrellisTurns.of({ start, end, awaitEnded, reconcile });
});

export const layer = Layer.effect(TrellisTurns, make);
