import * as Schema from "effect/Schema";
import {
  ApprovalRequestId,
  IsoDateTime,
  MessageId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  ModelSelection,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThreadActivity,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderUserInputAnswers,
  RuntimeMode,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "./orchestration.ts";
import { ProviderRuntimeEvent } from "./providerRuntime.ts";

export class SideChatError extends Schema.TaggedError<SideChatError>()("SideChatError", {
  message: Schema.String,
}) {}

export const SideChatParentInput = Schema.Struct({ parentThreadId: ThreadId });
export type SideChatParentInput = typeof SideChatParentInput.Type;
export const SideChatTargetInput = Schema.Struct({
  parentThreadId: ThreadId,
  sideChatId: TrimmedNonEmptyString,
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
export const SideChatApprovalInput = Schema.Struct({
  ...SideChatTargetInput.fields,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type SideChatApprovalInput = typeof SideChatApprovalInput.Type;
export const SideChatUserInput = Schema.Struct({
  ...SideChatTargetInput.fields,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
});
export type SideChatUserInput = typeof SideChatUserInput.Type;

/** A transient native conversation. It is never projected into durable thread state. */
export const SideChatSnapshot = Schema.Struct({
  ...SideChatTargetInput.fields,
  modelSelection: ModelSelection,
  interactionMode: ProviderInteractionMode,
  runtimeMode: RuntimeMode,
  cwd: Schema.String,
  status: Schema.Literals(["ready", "running", "closed", "error"]),
  messages: Schema.Array(OrchestrationMessage),
  activities: Schema.Array(OrchestrationThreadActivity),
  proposedPlans: Schema.Array(OrchestrationProposedPlan),
  pendingRequests: Schema.Array(ProviderRuntimeEvent),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  error: Schema.optional(Schema.String),
});
export type SideChatSnapshot = typeof SideChatSnapshot.Type;

/** Collection entries are upserts by ID; pending requests replace the current list. */
export const SideChatChanges = Schema.Struct({
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
  runtimeMode: Schema.optional(RuntimeMode),
  cwd: Schema.optional(Schema.String),
  status: Schema.optional(SideChatSnapshot.fields.status),
  messages: Schema.optional(Schema.Array(OrchestrationMessage)),
  removedMessageIds: Schema.optional(Schema.Array(MessageId)),
  messageDeltas: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: MessageId,
        delta: Schema.String,
        updatedAt: IsoDateTime,
        streaming: Schema.Boolean,
      }),
    ),
  ),
  activities: Schema.optional(Schema.Array(OrchestrationThreadActivity)),
  proposedPlans: Schema.optional(Schema.Array(OrchestrationProposedPlan)),
  pendingRequests: Schema.optional(Schema.Array(ProviderRuntimeEvent)),
  latestTurn: Schema.optional(Schema.NullOr(OrchestrationLatestTurn)),
  error: Schema.optional(Schema.NullOr(Schema.String)),
});
export type SideChatChanges = typeof SideChatChanges.Type;

/** Reconnection starts with a snapshot; later frames contain only changed entries. */
export const SideChatStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), snapshot: Schema.NullOr(SideChatSnapshot) }),
  Schema.Struct({
    type: Schema.Literal("update"),
    ...SideChatTargetInput.fields,
    changes: SideChatChanges,
  }),
]);
export type SideChatStreamEvent = typeof SideChatStreamEvent.Type;
