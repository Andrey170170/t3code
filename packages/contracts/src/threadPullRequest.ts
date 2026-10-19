import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  PullRequestActor,
  PullRequestChecksState,
  PullRequestMergeability,
  PullRequestReviewDecision,
  PullRequestState,
} from "./pullRequest.ts";

export const ThreadLinkedPullRequest = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
});
export type ThreadLinkedPullRequest = typeof ThreadLinkedPullRequest.Type;

/** `stack-dismissed` is a tombstone
 * for a native-stack member the user unlinked, so the sync reactor does not
 * re-add it; clients hide it. */
export const ThreadPullRequestLinkSource = Schema.Literals([
  "manual",
  "created",
  "agent",
  "stack",
  "stack-dismissed",
]);
export type ThreadPullRequestLinkSource = typeof ThreadPullRequestLinkSource.Type;

export const ThreadPullRequestSnapshot = Schema.Struct({
  state: PullRequestState,
  title: TrimmedNonEmptyString,
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  isDraft: Schema.Boolean,
  updatedAt: Schema.NullOr(IsoDateTime),
  syncedAt: IsoDateTime,
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(PullRequestActor)),
  additions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
  changedFiles: Schema.optional(NonNegativeInt),
  reviewDecision: Schema.optional(Schema.NullOr(PullRequestReviewDecision)),
  checksState: Schema.optional(Schema.NullOr(PullRequestChecksState)),
  mergeability: Schema.optional(PullRequestMergeability),
});
export type ThreadPullRequestSnapshot = typeof ThreadPullRequestSnapshot.Type;

export const ThreadPullRequestStackLayer = Schema.Struct({
  number: PositiveInt,
  headBranch: TrimmedNonEmptyString,
  state: PullRequestState,
});
export type ThreadPullRequestStackLayer = typeof ThreadPullRequestStackLayer.Type;

/** Layers run bottom to top. */
export const ThreadPullRequestStack = Schema.Struct({
  kind: Schema.Literal("native"),
  id: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  base: TrimmedNonEmptyString,
  layers: Schema.Array(ThreadPullRequestStackLayer),
});
export type ThreadPullRequestStack = typeof ThreadPullRequestStack.Type;

export const ThreadPullRequestKey = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type ThreadPullRequestKey = typeof ThreadPullRequestKey.Type;

/**
 * Present while the server watches the pull request for its thread. The server wakes the
 * thread's agent when checks finish on the head commit, someone else comments or gives the pull
 * request a 👍, or the branch starts to conflict. The other fields record what the agent was
 * last told, so each change is reported once.
 */
export const ThreadPullRequestWatch = Schema.Struct({
  startedAt: IsoDateTime,
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  failedChecks: Schema.Array(TrimmedNonEmptyString),
  passed: Schema.Boolean,
  passedChecks: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  remarksThrough: IsoDateTime,
  /** Remarks created exactly at `remarksThrough` that were reported, so a late one still counts. */
  remarkIds: Schema.Array(TrimmedNonEmptyString),
  /**
   * Who else had given the pull request itself a 👍 at the last complete read, so a new one (or
   * one taken back and given again) is news. Reactions carry no time, so this is null until the
   * first complete read records the ones already there, as on watches saved before it existed.
   */
  thumbsUp: Schema.NullOr(Schema.Array(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  conflicting: Schema.Boolean,
  /** Wakes in a row with only comments or 👍. Watching stops at a limit, so bots cannot loop it. */
  wakes: NonNegativeInt,
});
export type ThreadPullRequestWatch = typeof ThreadPullRequestWatch.Type;

export const ThreadPullRequestLink = Schema.Struct({
  ...ThreadPullRequestKey.fields,
  url: TrimmedNonEmptyString,
  source: ThreadPullRequestLinkSource,
  linkedAt: IsoDateTime,
  snapshot: Schema.NullOr(ThreadPullRequestSnapshot),
  stack: Schema.NullOr(ThreadPullRequestStack),
  watch: Schema.optional(ThreadPullRequestWatch),
  /** The last watch as it ended. Watching again starts from it, so the thread is not told twice. */
  endedWatch: Schema.optional(ThreadPullRequestWatch),
});
export type ThreadPullRequestLink = typeof ThreadPullRequestLink.Type;
