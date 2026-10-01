import type { RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface TurnAdmissionShape {
  /**
   * Awaited before a run's provider turn resolves its runtime and opens a
   * session, so a workspace operation (a checkpoint restore) can hold new
   * turns back until it ends. Not an event subscriber: events are published
   * after provider starts are woken, and `run.created` also fires for queued
   * runs. True when the turn was held back, so state read before it is stale.
   */
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly cwd: string;
  }) => Effect.Effect<boolean>;
}

/** Seam for workspaces that gate turn starts; the default admits at once. */
export class TurnAdmission extends Context.Reference<TurnAdmissionShape>(
  "t3/orchestration-v2/TurnAdmission",
  { defaultValue: () => ({ start: () => Effect.succeed(false) }) },
) {}
