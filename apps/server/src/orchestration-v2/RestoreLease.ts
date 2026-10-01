import type { OrchestrationV2CheckpointScope } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";

export interface RestoreLeaseShape {
  /**
   * Holds the restore lease of `scope` until the surrounding scope closes.
   * A rollback holds it from before its isolation check through the restore,
   * so nothing that waits on the same lease runs in between.
   */
  readonly acquire: (
    scope: OrchestrationV2CheckpointScope,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

/**
 * The default lease is one gate per scope cwd. It is a separate outer gate:
 * `CheckpointServiceV2.restore` takes the per-cwd checkpoint semaphore itself
 * beneath it, so reusing that semaphore here would deadlock every rollback.
 */
function makeCwdRestoreLease(): RestoreLeaseShape {
  const gates = new Map<string, { readonly gate: Semaphore.Semaphore; holders: number }>();
  return {
    acquire: (scope) =>
      // Waiting for the gate stays interruptible; once taken, the release is
      // registered before anything can interrupt.
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const entry = gates.get(scope.cwd) ?? { gate: Semaphore.makeUnsafe(1), holders: 0 };
          entry.holders += 1;
          gates.set(scope.cwd, entry);
          yield* restore(entry.gate.take(1)).pipe(
            Effect.onInterrupt(() => Effect.sync(() => release(scope.cwd, entry))),
          );
          yield* Effect.addFinalizer(() =>
            entry.gate
              .release(1)
              .pipe(Effect.andThen(Effect.sync(() => release(scope.cwd, entry)))),
          );
        }),
      ),
  };

  function release(cwd: string, entry: { readonly gate: Semaphore.Semaphore; holders: number }) {
    entry.holders -= 1;
    if (entry.holders === 0 && gates.get(cwd) === entry) gates.delete(cwd);
  }
}

/** Seam for restores that need a wider lease than one cwd (Trellis restore scopes). */
export class RestoreLease extends Context.Reference<RestoreLeaseShape>(
  "t3/orchestration-v2/RestoreLease",
  { defaultValue: makeCwdRestoreLease },
) {}
