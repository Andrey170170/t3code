import { WS_METHODS, type SideChatSnapshot, type SideChatStreamEvent } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

function upsertEntries<T extends { readonly id: string }>(
  previous: readonly T[],
  updates: readonly T[] | undefined,
): readonly T[] {
  if (!updates?.length) return previous;
  const remaining = new Map(updates.map((entry) => [entry.id, entry]));
  const next = previous.map((entry) => {
    const replacement = remaining.get(entry.id);
    remaining.delete(entry.id);
    return replacement ?? entry;
  });
  return [...next, ...remaining.values()];
}

/** Snapshots reset reconnect state; updates can only affect their matching native conversation. */
export function applySideChatStreamEvent(
  previous: SideChatSnapshot | null,
  event: SideChatStreamEvent,
): SideChatSnapshot | null {
  if (event.type === "snapshot") return event.snapshot;
  if (
    previous === null ||
    previous.parentThreadId !== event.parentThreadId ||
    previous.sideChatId !== event.sideChatId
  ) {
    return previous;
  }
  const {
    messages,
    removedMessageIds,
    messageDeltas,
    activities,
    proposedPlans,
    error,
    ...fields
  } = event.changes;
  const removedIds = new Set(removedMessageIds);
  const retainedMessages =
    removedIds.size > 0
      ? previous.messages.filter((message) => !removedIds.has(message.id))
      : previous.messages;
  let nextMessages = upsertEntries(retainedMessages, messages);
  if (messageDeltas?.length) {
    const deltas = new Map(messageDeltas.map((delta) => [delta.id, delta]));
    nextMessages = nextMessages.map((message) => {
      const delta = deltas.get(message.id);
      return delta
        ? {
            ...message,
            text: message.text + delta.delta,
            updatedAt: delta.updatedAt,
            streaming: delta.streaming,
          }
        : message;
    });
  }
  const next = {
    ...previous,
    modelSelection: fields.modelSelection ?? previous.modelSelection,
    interactionMode: fields.interactionMode ?? previous.interactionMode,
    runtimeMode: fields.runtimeMode ?? previous.runtimeMode,
    cwd: fields.cwd ?? previous.cwd,
    status: fields.status ?? previous.status,
    latestTurn: fields.latestTurn === undefined ? previous.latestTurn : fields.latestTurn,
    pendingRequests: fields.pendingRequests ?? previous.pendingRequests,
    messages: nextMessages,
    activities: upsertEntries(previous.activities, activities),
    proposedPlans: upsertEntries(previous.proposedPlans, proposedPlans),
  };
  if (error === null) delete next.error;
  else if (error !== undefined) next.error = error;
  return next;
}

/** Native side conversations stay in their environment and never enter durable thread state. */
export function createSideChatEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
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
      // The server sends the current snapshot on attachment. Release the
      // subscription with its owner so an abandoned side chat can be unloaded.
      idleTtlMs: 0,
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
    respondApproval: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:side-chat:respond-approval",
      tag: WS_METHODS.sideChatRespondApproval,
    }),
    respondUserInput: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:side-chat:respond-user-input",
      tag: WS_METHODS.sideChatRespondUserInput,
    }),
  };
}
