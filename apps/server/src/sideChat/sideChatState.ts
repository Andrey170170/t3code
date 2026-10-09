import type {
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
  ProviderThreadId,
  SideChatSnapshot,
  SideChatStreamEvent,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

import type { IdAllocatorV2Shape } from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailureTurnItem } from "@t3tools/provider-core/server/failure";

/** The next snapshot plus the stream frames that describe the change to subscribers. */
export interface SideChatTransition {
  readonly snapshot: SideChatSnapshot;
  readonly events: ReadonlyArray<SideChatStreamEvent>;
}

type SideChatScalarPatch = Partial<
  Pick<
    SideChatSnapshot,
    | "status"
    | "activeProviderTurnId"
    | "modelSelection"
    | "interactionMode"
    | "runtimeMode"
    | "error"
  >
> & { readonly clearError?: boolean };

const unchanged = (snapshot: SideChatSnapshot): SideChatTransition => ({ snapshot, events: [] });

function upsertById<T extends { readonly id: string }>(
  entries: ReadonlyArray<T>,
  entry: T,
): ReadonlyArray<T> {
  const index = entries.findIndex((candidate) => candidate.id === entry.id);
  if (index === -1) return [...entries, entry];
  const next = entries.slice();
  next[index] = entry;
  return next;
}

/** Replaces scalar state and emits one `status` frame carrying all of it. */
export function patchSideChat(
  snapshot: SideChatSnapshot,
  patch: SideChatScalarPatch,
): SideChatTransition {
  const { clearError, error, ...fields } = patch;
  const next: { -readonly [K in keyof SideChatSnapshot]: SideChatSnapshot[K] } = {
    ...snapshot,
    ...fields,
  };
  if (error !== undefined) next.error = error;
  else if (clearError === true) delete next.error;
  return {
    snapshot: next,
    events: [
      {
        type: "status",
        sideChatId: next.sideChatId,
        status: next.status,
        activeProviderTurnId: next.activeProviderTurnId,
        modelSelection: next.modelSelection,
        interactionMode: next.interactionMode,
        runtimeMode: next.runtimeMode,
        ...(next.error === undefined ? {} : { error: next.error }),
      },
    ],
  };
}

export function upsertSideChatTurnItem(
  snapshot: SideChatSnapshot,
  turnItem: OrchestrationV2TurnItem,
): SideChatTransition {
  return {
    snapshot: { ...snapshot, turnItems: upsertById(snapshot.turnItems, turnItem) },
    events: [{ type: "turn-item", sideChatId: snapshot.sideChatId, turnItem }],
  };
}

export function upsertSideChatRuntimeRequest(
  snapshot: SideChatSnapshot,
  runtimeRequest: OrchestrationV2RuntimeRequest,
): SideChatTransition {
  return {
    snapshot: {
      ...snapshot,
      runtimeRequests: upsertById(snapshot.runtimeRequests, runtimeRequest),
    },
    events: [{ type: "runtime-request", sideChatId: snapshot.sideChatId, runtimeRequest }],
  };
}

export function chain(
  first: SideChatTransition,
  step: (snapshot: SideChatSnapshot) => SideChatTransition,
): SideChatTransition {
  const second = step(first.snapshot);
  return { snapshot: second.snapshot, events: [...first.events, ...second.events] };
}

/**
 * Ends the active turn and expires the live requests it left pending. Message-mode
 * questions (Codex async questions) outlive their turn: the answer is a new message.
 */
function settleActiveTurn(snapshot: SideChatSnapshot): SideChatTransition {
  const activeProviderTurnId = snapshot.activeProviderTurnId;
  let transition = patchSideChat(snapshot, { status: "idle", activeProviderTurnId: null });
  for (const request of snapshot.runtimeRequests) {
    if (
      request.status !== "pending" ||
      request.providerTurnId !== activeProviderTurnId ||
      request.responseCapability.type === "message"
    )
      continue;
    transition = chain(transition, (current) =>
      upsertSideChatRuntimeRequest(current, { ...request, status: "expired" }),
    );
  }
  return transition;
}

/** What folding a provider event needs beyond the snapshot. */
export interface SideChatEventContext {
  /** The side chat's own native thread, once the fork exists. */
  readonly providerThreadId: ProviderThreadId | null;
  readonly idAllocator: IdAllocatorV2Shape;
  readonly now: DateTime.Utc;
}

/** Records a failed turn's error in the timeline, the way orchestration does. */
function recordTurnFailure(
  snapshot: SideChatSnapshot,
  event: Extract<ProviderAdapterV2Event, { readonly type: "turn.terminal"; status: "failed" }>,
  context: SideChatEventContext,
): SideChatTransition {
  const userMessage = snapshot.turnItems.findLast((item) => item.type === "user_message");
  return upsertSideChatTurnItem(
    snapshot,
    makeProviderFailureTurnItem({
      idAllocator: context.idAllocator,
      driver: event.driver,
      threadId: snapshot.sideChatId,
      runId: userMessage?.runId ?? null,
      nodeId: userMessage?.nodeId ?? null,
      providerThreadId: event.providerThreadId,
      providerTurnId: event.providerTurnId,
      itemOrdinal: event.failureItemOrdinal,
      failure: event.failure,
      ...(event.retry === undefined ? {} : { retry: event.retry }),
      ...(event.retryStartedAt === undefined ? {} : { retryStartedAt: event.retryStartedAt }),
      occurredAt: context.now,
    }),
  );
}

/**
 * Folds one provider event into the side chat. Only the side chat's own items,
 * requests, and root turns count; everything else (subagent threads, nodes,
 * sessions, plans) is ignored.
 */
export function applySideChatProviderEvent(
  snapshot: SideChatSnapshot,
  event: ProviderAdapterV2Event,
  context: SideChatEventContext,
): SideChatTransition {
  if (snapshot.status === "closed") return unchanged(snapshot);
  switch (event.type) {
    case "turn_item.updated":
      return event.turnItem.threadId === snapshot.sideChatId
        ? upsertSideChatTurnItem(snapshot, event.turnItem)
        : unchanged(snapshot);
    case "runtime_request.updated":
      return event.threadId === undefined || event.threadId === snapshot.sideChatId
        ? upsertSideChatRuntimeRequest(snapshot, event.runtimeRequest)
        : unchanged(snapshot);
    case "provider_turn.updated": {
      if (event.threadId !== snapshot.sideChatId) return unchanged(snapshot);
      const turn = event.providerTurn;
      if (turn.status === "running" || turn.status === "pending") {
        return snapshot.status === "running" && snapshot.activeProviderTurnId === turn.id
          ? unchanged(snapshot)
          : patchSideChat(snapshot, { status: "running", activeProviderTurnId: turn.id });
      }
      return turn.id === snapshot.activeProviderTurnId
        ? settleActiveTurn(snapshot)
        : unchanged(snapshot);
    }
    case "turn.terminal": {
      // Codex settles the provider turn first, so the turn is usually already idle here.
      const settled =
        event.providerTurnId === snapshot.activeProviderTurnId
          ? settleActiveTurn(snapshot)
          : unchanged(snapshot);
      return event.status === "failed" && event.providerThreadId === context.providerThreadId
        ? chain(settled, (current) => recordTurnFailure(current, event, context))
        : settled;
    }
    default:
      return unchanged(snapshot);
  }
}
