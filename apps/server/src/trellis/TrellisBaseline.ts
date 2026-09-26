/**
 * TrellisBaseline - the snapshot of a Trellis project path taken before a
 * thread's first turn, which "revert to the start" restores.
 *
 * The provider command reactor ensures it right before it sends a turn to the
 * provider and does not start the turn when it cannot be taken, so no agent
 * writes before the baseline exists. The checkpoint reactor also ensures it
 * at turn start and only logs failures. Both go through this one service,
 * which is serialized and remembers settled threads.
 *
 * A thread whose turns already ran never gets a baseline later: a snapshot
 * of the modified workspace would be a false "start". Callers say whether
 * turns ran from T3's own history (`turnsRan`), because Trellis may have
 * thinned a thread's turn snapshots. Baselines are pinned so thinning keeps
 * them. Threads without one never block.
 *
 * @module trellis/TrellisBaseline
 */
import type { ThreadId, TrellisError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { isTrellisPath, Trellis } from "./Trellis.ts";
import { BASELINE_TURN } from "./TrellisCheckpoints.ts";

export class TrellisBaseline extends Context.Service<
  TrellisBaseline,
  {
    /**
     * Takes the thread's baseline snapshot of `cwd` unless it exists or the
     * thread's turns already ran. Fails when Trellis cannot list or take the
     * snapshot. No-op outside Trellis and for settled threads.
     */
    readonly ensure: (
      threadId: ThreadId,
      cwd: string | undefined,
      options?: { readonly turnsRan?: boolean },
    ) => Effect.Effect<void, TrellisError>;
  }
>()("t3/trellis/TrellisBaseline") {}

const make = Effect.gen(function* () {
  const trellis = yield* Trellis;
  const lock = yield* Semaphore.make(1);
  // Threads with a baseline, or whose turns ran without one.
  const settled = new Set<ThreadId>();

  // Pinning is best effort: an unpinned baseline still works until thinned.
  const pin = (snapshotId: string) =>
    trellis.pinSnapshot(snapshotId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("could not pin a Trellis baseline snapshot", {
          snapshotId,
          detail: error.message,
        }),
      ),
    );

  const ensure: TrellisBaseline["Service"]["ensure"] = (threadId, cwd, options) =>
    Effect.gen(function* () {
      if (cwd === undefined || settled.has(threadId)) return;
      if (!(yield* isTrellisPath(trellis, cwd))) return;
      const ofThread = (yield* trellis.listSnapshots(cwd)).filter(
        (entry) => entry.thread === threadId,
      );
      const baseline = ofThread.find((entry) => entry.turn === BASELINE_TURN);
      if (baseline !== undefined) {
        // Baselines taken before pinning existed.
        if (baseline.pinned === false) yield* pin(baseline.id);
      } else if (ofThread.length === 0 && options?.turnsRan !== true) {
        const created = yield* trellis.createSnapshot({
          target: cwd,
          thread: threadId,
          turn: BASELINE_TURN,
        });
        yield* pin(created.id);
      }
      settled.add(threadId);
    }).pipe(lock.withPermits(1));

  return TrellisBaseline.of({ ensure });
});

export const layer = Layer.effect(TrellisBaseline, make);
