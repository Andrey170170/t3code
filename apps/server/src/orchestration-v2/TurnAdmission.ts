import type { OrchestrationV2Run, RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * A turn the workspace will not run where its thread is (a Trellis idea that
 * graduated): the run fails with `message` before it reaches the provider.
 */
export class TurnAdmissionRefusedError extends Schema.TaggedError<TurnAdmissionRefusedError>()(
  "TurnAdmissionRefusedError",
  { message: Schema.String },
) {}

export interface TurnAdmissionShape {
  /**
   * Awaited before a run's provider turn resolves its runtime and opens a
   * session, so a workspace operation (a checkpoint restore) can hold new
   * turns back until it ends. Not an event subscriber: events are published
   * after provider starts are woken, and `run.created` also fires for queued
   * runs. True when the turn was held back, so state read before it is stale.
   * May be called more than once for a run (start retries). Fails when the
   * turn cannot run there at all.
   */
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly cwd: string;
  }) => Effect.Effect<boolean, TurnAdmissionRefusedError>;
  /**
   * Called once a run reached a terminal status, on every path (completed,
   * failed before or after the provider started, cancelled, interrupted),
   * from the orchestrator's terminal-run handler. Must not block it.
   */
  readonly end: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly status: OrchestrationV2Run["status"];
  }) => Effect.Effect<void>;
}

/** Seam for workspaces that gate turn starts; the default admits at once. */
export class TurnAdmission extends Context.Reference<TurnAdmissionShape>(
  "t3/orchestration-v2/TurnAdmission",
  { defaultValue: () => ({ start: () => Effect.succeed(false), end: () => Effect.void }) },
) {}
