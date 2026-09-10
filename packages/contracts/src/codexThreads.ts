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
  hideImported: Schema.optional(Schema.Boolean),
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
      /** The native conversation moved on since T3 last imported it. */
      updateAvailable: Schema.optionalKey(Schema.Boolean),
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
/** Importing an already imported conversation appends only its new turns. */
export const CodexThreadsImportResult = Schema.Struct({
  threadId: ThreadId,
  importedTurnCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type CodexThreadsImportResult = typeof CodexThreadsImportResult.Type;
