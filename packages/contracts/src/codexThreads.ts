import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export class CodexThreadError extends Schema.TaggedError<CodexThreadError>()("CodexThreadError", {
  message: Schema.String,
}) {}

export const CodexConversationOrigin = Schema.Literals(["human", "agent", "mixed", "unknown"]);
export type CodexConversationOrigin = typeof CodexConversationOrigin.Type;

export const CodexThreadsListInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  projectId: Schema.optional(ProjectId),
  cursor: Schema.optional(TrimmedNonEmptyString),
  search: Schema.optional(Schema.String),
  archived: Schema.optional(Schema.Boolean),
  cwd: Schema.optional(Schema.String),
  origin: Schema.optional(CodexConversationOrigin),
  searchScope: Schema.optional(Schema.Literals(["titles", "messages"])),
  refresh: Schema.optional(Schema.Boolean),
});
export type CodexThreadsListInput = typeof CodexThreadsListInput.Type;
export const CodexThreadsListResult = Schema.Struct({
  threads: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      sourceIdentity: Schema.String,
      origin: CodexConversationOrigin,
      childCount: Schema.Finite,
      matchPreview: Schema.optionalKey(Schema.String),
      title: Schema.String,
      cwd: Schema.String,
      projectCwd: Schema.optionalKey(Schema.String),
      worktreePath: Schema.optionalKey(Schema.NullOr(Schema.String)),
      worktreeBranch: Schema.optionalKey(Schema.NullOr(Schema.String)),
      worktreeMissing: Schema.optionalKey(Schema.Boolean),
      createdAt: IsoDateTime,
      updatedAt: IsoDateTime,
      archived: Schema.Boolean,
      existingThreadId: Schema.NullOr(ThreadId),
      historyAvailable: Schema.optionalKey(Schema.Boolean),
      historyUpgradeAvailable: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
  projects: Schema.Array(
    Schema.Struct({
      cwd: Schema.String,
      title: Schema.String,
      existingProjectId: Schema.NullOr(ProjectId),
      checkouts: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            cwd: Schema.String,
            branch: Schema.NullOr(Schema.String),
            isMain: Schema.Boolean,
          }),
        ),
      ),
      totalCount: Schema.Finite,
      importableCount: Schema.Finite,
      humanCount: Schema.Finite,
      agentCount: Schema.Finite,
      mixedCount: Schema.Finite,
      unknownCount: Schema.Finite,
    }),
  ),
  totalCount: Schema.Finite,
  catalogComplete: Schema.Boolean,
  messageSearchSupported: Schema.NullOr(Schema.Boolean),
});
export type CodexThreadsListResult = typeof CodexThreadsListResult.Type;
export const CodexThreadsImportInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  nativeThreadId: TrimmedNonEmptyString,
  archived: Schema.optional(Schema.Boolean),
  projectId: ProjectId,
  cwdOverride: Schema.optional(TrimmedNonEmptyString),
});
export type CodexThreadsImportInput = typeof CodexThreadsImportInput.Type;
export const CodexThreadsImportResult = Schema.Struct({
  threadId: ThreadId,
  alreadyImported: Schema.Boolean,
});
export type CodexThreadsImportResult = typeof CodexThreadsImportResult.Type;
export const CodexThreadsHistoryInput = Schema.Struct({
  threadId: ThreadId,
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 50 })),
  ),
  cursor: Schema.optional(TrimmedNonEmptyString),
});
export type CodexThreadsHistoryInput = typeof CodexThreadsHistoryInput.Type;
export const CodexHistoryItem = Schema.Struct({
  turnId: Schema.String,
  item: Schema.Record(Schema.String, Schema.Unknown),
});
export const CodexThreadsHistoryResult = Schema.Struct({
  imported: Schema.Boolean,
  boundary: Schema.NullOr(
    Schema.Struct({
      nativeThreadId: Schema.String,
      importedAt: IsoDateTime,
      replacesLegacyMessages: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  /** Native items in newest-first order. Further pages continue toward older history. */
  items: Schema.Array(CodexHistoryItem),
  nextCursor: Schema.NullOr(Schema.String),
});
export type CodexThreadsHistoryResult = typeof CodexThreadsHistoryResult.Type;
