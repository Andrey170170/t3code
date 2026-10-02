import * as Schema from "effect/Schema";

import {
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2RuntimeRequest, OrchestrationV2TurnItem } from "./orchestrationV2.ts";
import {
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "./providerPolicy.ts";

export class SideChatError extends Schema.TaggedError<SideChatError>()("SideChatError", {
  message: Schema.String,
}) {}

export const SideChatParentInput = Schema.Struct({ parentThreadId: ThreadId });
export type SideChatParentInput = typeof SideChatParentInput.Type;

export const SideChatTargetInput = Schema.Struct({
  parentThreadId: ThreadId,
  sideChatId: ThreadId,
});
export type SideChatTargetInput = typeof SideChatTargetInput.Type;

export const SideChatSendInput = Schema.Struct({
  ...SideChatTargetInput.fields,
  input: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
  runtimeMode: Schema.optional(RuntimeMode),
});
export type SideChatSendInput = typeof SideChatSendInput.Type;

/** Approvals carry a `decision`; user-input requests carry `answers`. */
export const SideChatRespondInput = Schema.Struct({
  ...SideChatTargetInput.fields,
  requestId: RuntimeRequestId,
  decision: Schema.optional(ProviderApprovalDecision),
  answers: Schema.optional(ProviderUserInputAnswers),
});
export type SideChatRespondInput = typeof SideChatRespondInput.Type;

export const SideChatStatus = Schema.Literals(["starting", "idle", "running", "closed", "error"]);
export type SideChatStatus = typeof SideChatStatus.Type;

/**
 * A temporary native fork of a Codex thread. It lives only in the server's
 * memory: it is never projected into durable thread state and ends when closed
 * or when the server restarts.
 */
export const SideChatSnapshot = Schema.Struct({
  sideChatId: ThreadId,
  parentThreadId: ThreadId,
  status: SideChatStatus,
  modelSelection: ModelSelection,
  interactionMode: ProviderInteractionMode,
  runtimeMode: RuntimeMode,
  /** Inherited workspace directory; side chats cannot change it. */
  cwd: Schema.String,
  /** In first-seen order; updates replace an item in place. */
  turnItems: Schema.Array(OrchestrationV2TurnItem),
  runtimeRequests: Schema.Array(OrchestrationV2RuntimeRequest),
  activeProviderTurnId: Schema.NullOr(ProviderTurnId),
  error: Schema.optional(Schema.String),
});
export type SideChatSnapshot = typeof SideChatSnapshot.Type;

/** Subscriptions start with a snapshot; later frames upsert entries or replace scalar state. */
export const SideChatStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), snapshot: SideChatSnapshot }),
  Schema.Struct({
    type: Schema.Literal("turn-item"),
    sideChatId: ThreadId,
    turnItem: OrchestrationV2TurnItem,
  }),
  Schema.Struct({
    type: Schema.Literal("runtime-request"),
    sideChatId: ThreadId,
    runtimeRequest: OrchestrationV2RuntimeRequest,
  }),
  Schema.Struct({
    type: Schema.Literal("status"),
    sideChatId: ThreadId,
    status: SideChatStatus,
    activeProviderTurnId: Schema.NullOr(ProviderTurnId),
    modelSelection: ModelSelection,
    interactionMode: ProviderInteractionMode,
    runtimeMode: RuntimeMode,
    error: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("closed"), sideChatId: ThreadId }),
]);
export type SideChatStreamEvent = typeof SideChatStreamEvent.Type;
