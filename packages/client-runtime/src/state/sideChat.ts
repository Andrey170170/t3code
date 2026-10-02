import { WS_METHODS, type SideChatSnapshot, type SideChatStreamEvent } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Replaces an entry in place, or appends it, so entries keep first-seen order. */
function upsertById<T extends { readonly id: string }>(
  entries: readonly T[],
  entry: T,
): readonly T[] {
  const index = entries.findIndex((candidate) => candidate.id === entry.id);
  if (index === -1) return [...entries, entry];
  const next = entries.slice();
  next[index] = entry;
  return next;
}

/** Folds a side chat subscription into its current snapshot. Frames for another side chat are ignored. */
export function applySideChatStreamEvent(
  previous: SideChatSnapshot | null,
  event: SideChatStreamEvent,
): SideChatSnapshot | null {
  if (event.type === "snapshot") return event.snapshot;
  if (previous === null || previous.sideChatId !== event.sideChatId) return previous;
  switch (event.type) {
    case "turn-item":
      return { ...previous, turnItems: upsertById(previous.turnItems, event.turnItem) };
    case "runtime-request":
      return {
        ...previous,
        runtimeRequests: upsertById(previous.runtimeRequests, event.runtimeRequest),
      };
    case "status": {
      const { error: _previousError, ...rest } = previous;
      return {
        ...rest,
        status: event.status,
        activeProviderTurnId: event.activeProviderTurnId,
        modelSelection: event.modelSelection,
        interactionMode: event.interactionMode,
        runtimeMode: event.runtimeMode,
        ...(event.error === undefined ? {} : { error: event.error }),
      };
    }
    case "closed":
      return { ...previous, status: "closed" };
  }
}

/** Native side conversations stay in their environment and never enter durable thread state. */
export function createSideChatEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // Opening and closing for one parent run in order, so a close issued while
  // the fork is still starting cannot race ahead of it.
  const lifecycleScheduler = createAtomCommandScheduler();
  const lifecycleConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { parentThreadId: string } }) =>
      JSON.stringify([environmentId, input.parentThreadId]),
  };

  return {
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:side-chat:state",
      tag: WS_METHODS.sideChatSubscribe,
      transform: (stream) =>
        stream.pipe(Stream.scan(null as SideChatSnapshot | null, applySideChatStreamEvent)),
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:side-chat:open",
      tag: WS_METHODS.sideChatOpen,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:side-chat:close",
      tag: WS_METHODS.sideChatClose,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    send: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:side-chat:send",
      tag: WS_METHODS.sideChatSend,
    }),
    interrupt: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:side-chat:interrupt",
      tag: WS_METHODS.sideChatInterrupt,
    }),
    respond: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:side-chat:respond",
      tag: WS_METHODS.sideChatRespond,
    }),
  };
}
