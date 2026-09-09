import {
  EventId,
  MessageId,
  type ProviderRuntimeEvent,
  type SideChatSnapshot,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

/** Project only the ephemeral fork's events; never feed them to durable orchestration. */
export function applySideChatEvent(
  snapshot: SideChatSnapshot,
  event: ProviderRuntimeEvent,
): SideChatSnapshot {
  let next = snapshot;
  const turnId = event.turnId ?? null;
  if (event.type === "turn.started") {
    next = {
      ...next,
      status: "running",
      latestTurn: turnId
        ? {
            turnId,
            state: "running",
            requestedAt: event.createdAt,
            startedAt: event.createdAt,
            completedAt: null,
            assistantMessageId: null,
          }
        : next.latestTurn,
    };
  }
  if (event.type === "turn.completed" || event.type === "turn.aborted") {
    const failed = event.type === "turn.completed" && event.payload.state === "failed";
    next = {
      ...next,
      status: failed ? "error" : "ready",
      ...(failed && event.type === "turn.completed" && event.payload.errorMessage
        ? { error: event.payload.errorMessage }
        : {}),
      pendingRequests: next.pendingRequests.some(
        (request) =>
          request.type !== "user-input.requested" || request.payload.responseMode !== "message",
      )
        ? next.pendingRequests.filter(
            (request) =>
              request.type === "user-input.requested" && request.payload.responseMode === "message",
          )
        : next.pendingRequests,
      messages: settleMessages(next.messages),
      latestTurn: next.latestTurn
        ? {
            ...next.latestTurn,
            state: failed
              ? "error"
              : event.type === "turn.aborted" || event.payload.state === "interrupted"
                ? "interrupted"
                : "completed",
            completedAt: event.createdAt,
          }
        : null,
    };
  }
  if (event.type === "turn.completed" || event.type === "turn.aborted") {
    next = settleRequests(snapshot, next, event.createdAt);
  }
  if (event.type === "runtime.error")
    next = { ...next, status: "error", error: event.payload.message };
  if (
    event.type === "session.exited" ||
    (event.type === "thread.state.changed" && event.payload.state === "closed") ||
    (event.type === "session.state.changed" && event.payload.state === "stopped")
  ) {
    next = closeSideChatSnapshot(next);
  }
  const assistantDelta =
    event.type === "content.delta" && event.payload.streamKind === "assistant_text";
  const assistantItem =
    (event.type === "item.started" || event.type === "item.completed") &&
    event.payload.itemType === "assistant_message";
  if (assistantDelta || assistantItem) {
    const id = MessageId.make(`side:${event.itemId ?? event.turnId ?? event.eventId}`);
    const previous = next.messages.find((message) => message.id === id);
    const text =
      assistantDelta && event.type === "content.delta"
        ? (previous?.text ?? "") + event.payload.delta
        : assistantItem && (event.type === "item.started" || event.type === "item.completed")
          ? (event.payload.detail ?? previous?.text ?? "")
          : "";
    const message = {
      id,
      role: "assistant" as const,
      text,
      turnId,
      streaming: event.type !== "item.completed",
      createdAt: previous?.createdAt ?? event.createdAt,
      updatedAt: event.createdAt,
    };
    next = {
      ...next,
      messages: previous
        ? next.messages.map((existing) => (existing.id === id ? message : existing))
        : [...next.messages, message],
      latestTurn: next.latestTurn ? { ...next.latestTurn, assistantMessageId: id } : null,
    };
  }
  if (event.type === "request.opened" || event.type === "user-input.requested") {
    next = {
      ...next,
      pendingRequests: [
        ...next.pendingRequests.filter((request) => request.requestId !== event.requestId),
        event,
      ],
    };
  } else if (event.type === "request.resolved" || event.type === "user-input.resolved") {
    next = {
      ...next,
      pendingRequests: next.pendingRequests.filter(
        (request) => request.requestId !== event.requestId,
      ),
    };
  }
  if (event.type === "turn.proposed.delta" || event.type === "turn.proposed.completed") {
    const id = `side-plan:${event.turnId ?? event.eventId}`;
    const previous = next.proposedPlans.find((plan) => plan.id === id);
    const planMarkdown =
      event.type === "turn.proposed.delta"
        ? (previous?.planMarkdown ?? "") + event.payload.delta
        : event.payload.planMarkdown;
    if (planMarkdown.trim()) {
      const plan = {
        id,
        turnId,
        planMarkdown,
        implementedAt: null,
        implementationThreadId: null,
        createdAt: previous?.createdAt ?? event.createdAt,
        updatedAt: event.createdAt,
      };
      next = {
        ...next,
        proposedPlans: [...next.proposedPlans.filter((existing) => existing.id !== id), plan],
      };
    }
  }
  const activity = sideChatActivity(event);
  if (activity)
    next = {
      ...next,
      activities: [...next.activities.filter((existing) => existing.id !== activity.id), activity],
    };
  return next;
}

function settleMessages(messages: SideChatSnapshot["messages"]): SideChatSnapshot["messages"] {
  return messages.some((message) => message.streaming)
    ? messages.map((message) => (message.streaming ? { ...message, streaming: false } : message))
    : messages;
}

export function closeSideChatSnapshot(snapshot: SideChatSnapshot): SideChatSnapshot {
  const closed: SideChatSnapshot = {
    ...snapshot,
    status: "closed",
    pendingRequests: snapshot.pendingRequests.length ? [] : snapshot.pendingRequests,
    messages: settleMessages(snapshot.messages),
    latestTurn:
      snapshot.latestTurn?.state === "running"
        ? { ...snapshot.latestTurn, state: "interrupted" }
        : snapshot.latestTurn,
  };
  return settleRequests(snapshot, closed, new Date().toISOString());
}

function settleRequests(
  previous: SideChatSnapshot,
  next: SideChatSnapshot,
  createdAt: string,
): SideChatSnapshot {
  const pending = new Set(next.pendingRequests.map((request) => request.requestId));
  const resolved = previous.pendingRequests.flatMap((request) => {
    if (pending.has(request.requestId)) return [];
    const base = {
      ...request,
      eventId: EventId.make(`${request.eventId}:side-settled`),
      createdAt,
    };
    const activity =
      request.type === "request.opened"
        ? sideChatActivity({
            ...base,
            type: "request.resolved",
            payload: { requestType: request.payload.requestType, decision: "cancel" },
          })
        : request.type === "user-input.requested"
          ? sideChatActivity({ ...base, type: "user-input.resolved", payload: { answers: {} } })
          : undefined;
    return activity ? [activity] : [];
  });
  return resolved.length ? { ...next, activities: [...next.activities, ...resolved] } : next;
}

function sideChatActivity(event: ProviderRuntimeEvent): OrchestrationThreadActivity | undefined {
  const base = { id: event.eventId, createdAt: event.createdAt, turnId: event.turnId ?? null };
  switch (event.type) {
    case "request.opened":
    case "request.resolved": {
      const requestType = event.payload.requestType;
      const requestKind =
        requestType === "file_read_approval"
          ? "file-read"
          : requestType === "file_change_approval" || requestType === "apply_patch_approval"
            ? "file-change"
            : requestType === "mcp_elicitation_approval"
              ? "mcp-elicitation"
              : "command";
      return {
        ...base,
        tone: "approval",
        kind: event.type === "request.opened" ? "approval.requested" : "approval.resolved",
        summary: event.type === "request.opened" ? "Approval requested" : "Approval resolved",
        payload: { ...event.payload, requestId: event.requestId, requestKind },
      };
    }
    case "user-input.requested":
    case "user-input.resolved":
      return {
        ...base,
        tone: "info",
        kind: event.type,
        summary:
          event.type === "user-input.requested" ? "User input requested" : "User input submitted",
        payload: { ...event.payload, requestId: event.requestId },
      };
    case "item.started":
    case "item.updated":
    case "item.completed":
      if (
        event.payload.itemType === "assistant_message" ||
        event.payload.itemType === "user_message"
      )
        return;
      return {
        ...base,
        id: EventId.make(`side-item:${event.itemId ?? event.eventId}`),
        tone: "tool",
        kind: event.type.replace("item.", "tool."),
        summary: event.payload.title ?? event.payload.itemType,
        payload: { ...event.payload, toolCallId: event.itemId },
      };
    case "runtime.error":
    case "runtime.warning":
      return {
        ...base,
        tone: event.type === "runtime.error" ? "error" : "info",
        kind: event.type,
        summary: event.payload.message,
        payload: event.payload,
      };
    default:
      return;
  }
}

/** Diff against the last delivered snapshot, so a slow subscriber can skip intermediate snapshots safely. */
export function sideChatStreamEvent(
  previous: SideChatSnapshot | null | undefined,
  next: SideChatSnapshot | null,
): import("@t3tools/contracts").SideChatStreamEvent {
  if (!previous || !next || previous.sideChatId !== next.sideChatId)
    return { type: "snapshot", snapshot: next };
  const messages: import("@t3tools/contracts").OrchestrationMessage[] = [];
  const messageDeltas: NonNullable<
    import("@t3tools/contracts").SideChatChanges["messageDeltas"]
  >[number][] = [];
  const previousMessages = new Map(previous.messages.map((message) => [message.id, message]));
  for (const message of next.messages) {
    const old = previousMessages.get(message.id);
    if (old === message) continue;
    if (
      old &&
      old.role === message.role &&
      old.turnId === message.turnId &&
      old.createdAt === message.createdAt &&
      old.attachments === message.attachments &&
      old.agentOrigin === message.agentOrigin &&
      message.text.startsWith(old.text)
    ) {
      messageDeltas.push({
        id: message.id,
        delta: message.text.slice(old.text.length),
        updatedAt: message.updatedAt,
        streaming: message.streaming,
      });
    } else messages.push(message);
  }
  const changedEntries = <T extends { readonly id: string }>(
    oldEntries: readonly T[],
    entries: readonly T[],
  ) => {
    const old = new Map(oldEntries.map((entry) => [entry.id, entry]));
    return entries.filter((entry) => entry !== old.get(entry.id));
  };
  const nextMessageIds = new Set(next.messages.map((message) => message.id));
  const removedMessageIds = previous.messages
    .filter((message) => !nextMessageIds.has(message.id))
    .map((message) => message.id);
  const activities = changedEntries(previous.activities, next.activities);
  const proposedPlans = changedEntries(previous.proposedPlans, next.proposedPlans);
  return {
    type: "update",
    parentThreadId: next.parentThreadId,
    sideChatId: next.sideChatId,
    changes: {
      ...(previous.modelSelection !== next.modelSelection
        ? { modelSelection: next.modelSelection }
        : {}),
      ...(previous.runtimeMode !== next.runtimeMode ? { runtimeMode: next.runtimeMode } : {}),
      ...(previous.interactionMode !== next.interactionMode
        ? { interactionMode: next.interactionMode }
        : {}),
      ...(previous.cwd !== next.cwd ? { cwd: next.cwd } : {}),
      ...(previous.status !== next.status ? { status: next.status } : {}),
      ...(previous.latestTurn !== next.latestTurn ? { latestTurn: next.latestTurn } : {}),
      ...(previous.error !== next.error ? { error: next.error ?? null } : {}),
      ...(previous.pendingRequests !== next.pendingRequests
        ? { pendingRequests: next.pendingRequests }
        : {}),
      ...(removedMessageIds.length ? { removedMessageIds } : {}),
      ...(messages.length ? { messages } : {}),
      ...(messageDeltas.length ? { messageDeltas } : {}),
      ...(activities.length ? { activities } : {}),
      ...(proposedPlans.length ? { proposedPlans } : {}),
    },
  };
}
