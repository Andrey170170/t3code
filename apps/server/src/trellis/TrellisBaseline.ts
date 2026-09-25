/**
 * TrellisBaseline - the snapshot of a Trellis project path taken before a
 * thread's first turn, which "revert to the start" restores.
 *
 * The provider command reactor ensures it right before it sends a turn to the
 * provider, so the agent cannot write before the baseline exists. The
 * checkpoint reactor ensures it too, at turn start. Both go through this one
 * service: it is serialized and remembers threads whose baseline exists, so
 * the work runs once. A failed attempt is logged and retried at the next turn
 * (the baseline then holds the state before that turn); it never fails a turn.
 *
 * @module trellis/TrellisBaseline
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { isTrellisPath, Trellis } from "./Trellis.ts";
import { BASELINE_TURN } from "./TrellisCheckpoints.ts";

export class TrellisBaseline extends Context.Service<
  TrellisBaseline,
  {
    /** Takes the thread's baseline snapshot of `cwd` unless it exists. No-op outside Trellis. */
    readonly ensure: (threadId: ThreadId, cwd: string | undefined) => Effect.Effect<void>;
  }
>()("t3/trellis/TrellisBaseline") {}

const make = Effect.gen(function* () {
  const trellis = yield* Trellis;
  const lock = yield* Semaphore.make(1);
  const captured = new Set<ThreadId>();

  const ensure: TrellisBaseline["Service"]["ensure"] = (threadId, cwd) =>
    Effect.gen(function* () {
      if (cwd === undefined || captured.has(threadId)) return;
      if (!(yield* isTrellisPath(trellis, cwd))) return;
      const snapshots = yield* trellis.listSnapshots(cwd);
      if (!snapshots.some((entry) => entry.thread === threadId && entry.turn === BASELINE_TURN)) {
        yield* trellis.createSnapshot({ target: cwd, thread: threadId, turn: BASELINE_TURN });
      }
      captured.add(threadId);
    }).pipe(
      lock.withPermits(1),
      Effect.catch((error) =>
        Effect.logWarning("Trellis baseline snapshot failed; retrying at the next turn", {
          threadId,
          cwd,
          detail: error.message,
        }),
      ),
    );

  return TrellisBaseline.of({ ensure });
});

export const layer = Layer.effect(TrellisBaseline, make);
