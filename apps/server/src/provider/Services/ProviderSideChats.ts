import type {
  SideChatParentInput,
  SideChatTargetInput,
  SideChatSendInput,
  SideChatApprovalInput,
  SideChatUserInput,
  SideChatSnapshot,
  SideChatStreamEvent,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

/** Optional native ephemeral-chat capability, currently supplied by Codex. */
export interface ProviderSideChats<Error> {
  readonly open: (input: SideChatParentInput) => Effect.Effect<SideChatSnapshot, Error>;
  readonly send: (input: SideChatSendInput) => Effect.Effect<void, Error>;
  readonly interrupt: (input: SideChatTargetInput) => Effect.Effect<void, Error>;
  readonly close: (input: SideChatTargetInput) => Effect.Effect<void, Error>;
  readonly respondApproval: (input: SideChatApprovalInput) => Effect.Effect<void, Error>;
  readonly respondUserInput: (input: SideChatUserInput) => Effect.Effect<void, Error>;
  readonly subscribe: (input: SideChatParentInput) => Stream.Stream<SideChatStreamEvent, Error>;
}
