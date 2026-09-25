import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Trellis is an optional local workspace service. These contracts cover the
 * client-facing operations; Trellis-managed projects are ordinary T3 projects
 * whose `workspaceRoot` lies inside `<root>/workspaces/`.
 */
export class TrellisError extends Schema.TaggedError<TrellisError>()("TrellisError", {
  message: Schema.String,
}) {}

/** `available: false` means Trellis is not installed or not running; hide Trellis UI. */
export const TrellisStatus = Schema.Struct({
  available: Schema.Boolean,
  root: Schema.optionalKey(Schema.String),
});
export type TrellisStatus = typeof TrellisStatus.Type;

export const TrellisNewIdeaInput = Schema.Struct({
  name: Schema.optionalKey(TrimmedNonEmptyString),
});
export type TrellisNewIdeaInput = typeof TrellisNewIdeaInput.Type;

export const TrellisNewProjectInput = Schema.Struct({
  name: Schema.optionalKey(TrimmedNonEmptyString),
  gitUrl: Schema.optionalKey(TrimmedNonEmptyString),
  base: Schema.optionalKey(TrimmedNonEmptyString),
});
export type TrellisNewProjectInput = typeof TrellisNewProjectInput.Type;

/** The T3 project that the catalog sync created or matched for the new Trellis item. */
export const TrellisCreateResult = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  name: Schema.String,
});
export type TrellisCreateResult = typeof TrellisCreateResult.Type;

export const TrellisFindInput = Schema.Struct({
  query: TrimmedNonEmptyString,
});
export type TrellisFindInput = typeof TrellisFindInput.Type;

export const TrellisFindHit = Schema.Struct({
  /** Null when no T3 project exists for the hit (for example a trashed item). */
  projectId: Schema.NullOr(ProjectId),
  kind: Schema.Literals(["idea", "project"]),
  name: Schema.String,
  description: Schema.String,
  path: Schema.String,
  matches: Schema.Array(Schema.Struct({ path: Schema.String, snippet: Schema.String })),
});
export type TrellisFindHit = typeof TrellisFindHit.Type;

export const TrellisFindResult = Schema.Struct({
  hits: Schema.Array(TrellisFindHit),
});
export type TrellisFindResult = typeof TrellisFindResult.Type;
