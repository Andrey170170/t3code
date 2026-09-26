import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Trellis is an optional local workspace service. These contracts cover the
 * client-facing operations; Trellis-managed projects are ordinary T3 projects
 * whose `workspaceRoot` lies inside `<root>/workspaces/`.
 */
export class TrellisError extends Schema.TaggedError<TrellisError>()("TrellisError", {
  message: Schema.String,
}) {}

/**
 * The hidden project that new-idea drafts belong to until their first send,
 * which creates the Trellis idea and moves the thread into its project.
 * Clients never list it. Its folder is an empty directory the server owns.
 */
export const TRELLIS_LANDING_PAD_PROJECT_ID = ProjectId.make("trellis-landing-pad");

export const isTrellisLandingPad = (projectId: string): boolean =>
  projectId === TRELLIS_LANDING_PAD_PROJECT_ID;

/**
 * `disabled`: the integration is off in this environment's settings.
 * `unavailable`: it is on, but the Trellis service does not answer.
 * `ready`: Trellis actions work. Trellis UI shows only when `ready`.
 */
export const TrellisState = Schema.Literals(["disabled", "unavailable", "ready"]);
export type TrellisState = typeof TrellisState.Type;

export const TrellisStatus = Schema.Struct({
  /** Absent from servers that predate the settings switch; read `available` there. */
  state: Schema.optionalKey(TrellisState),
  /** True exactly when `state` is `ready`. */
  available: Schema.Boolean,
  /** Where Trellis project paths live; also reported while disabled or unavailable when known. */
  root: Schema.optionalKey(Schema.String),
  /** The API socket the server uses or would use. */
  socketPath: Schema.optionalKey(Schema.String),
  /**
   * Roots of T3 projects whose Trellis item is in the trash or graduated.
   * Clients hide such a project once it has no active thread or draft.
   */
  retiredRoots: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Roots of live forks (non-primary workspaces), which are trashed on their own. */
  forkRoots: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type TrellisStatus = typeof TrellisStatus.Type;

/** Where a new idea's draft starts: the landing pad project. */
export const TrellisIdeaDraftTarget = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: Schema.String,
});
export type TrellisIdeaDraftTarget = typeof TrellisIdeaDraftTarget.Type;

export const TrellisTrashProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type TrellisTrashProjectInput = typeof TrellisTrashProjectInput.Type;

/**
 * `workspace` when the T3 project was one fork of a Trellis project. Null when
 * no live Trellis item is behind it (for example it is already in the trash),
 * so only T3's own entry can be removed.
 */
export const TrellisTrashProjectResult = Schema.Struct({
  trashed: Schema.NullOr(Schema.Literals(["project", "workspace"])),
  name: Schema.String,
});
export type TrellisTrashProjectResult = typeof TrellisTrashProjectResult.Type;

export const TrellisTrashItem = Schema.Struct({
  /** `workspace` is one trashed fork of a project that is still live. */
  kind: Schema.Literals(["idea", "project", "workspace"]),
  id: Schema.String,
  name: Schema.String,
  /** Unix seconds. */
  deletedAt: Schema.Finite,
  /** Unix seconds when it is removed for good; null when it stays until the trash is emptied. */
  expiresAt: Schema.NullOr(Schema.Finite),
});
export type TrellisTrashItem = typeof TrellisTrashItem.Type;

export const TrellisTrashList = Schema.Struct({
  items: Schema.Array(TrellisTrashItem),
});
export type TrellisTrashList = typeof TrellisTrashList.Type;

export const TrellisRestoreInput = Schema.Struct({
  kind: Schema.Literals(["idea", "project", "workspace"]),
  id: TrimmedNonEmptyString,
});
export type TrellisRestoreInput = typeof TrellisRestoreInput.Type;

export const TrellisRestoreResult = Schema.Struct({
  /** The T3 project of the restored item, once synced; null if it is not there yet. */
  projectId: Schema.NullOr(ProjectId),
});
export type TrellisRestoreResult = typeof TrellisRestoreResult.Type;

export const TrellisEmptyTrashResult = Schema.Struct({
  purged: Schema.Finite,
});
export type TrellisEmptyTrashResult = typeof TrellisEmptyTrashResult.Type;

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

/**
 * One Trellis item's matches within one workspace: a hit in a fork is its
 * own entry, so opening it lands in that fork's T3 project.
 */
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

/**
 * Maps a loopback preview URL (`localhost:PORT`) of a thread in a Trellis
 * workspace to that workspace port's preview address. Other URLs and
 * threads come back unchanged.
 */
export const TrellisResolvePreviewUrlInput = Schema.Struct({
  threadId: ThreadId,
  url: TrimmedNonEmptyString,
});
export type TrellisResolvePreviewUrlInput = typeof TrellisResolvePreviewUrlInput.Type;

export const TrellisResolvePreviewUrlResult = Schema.Struct({
  url: Schema.String,
});
export type TrellisResolvePreviewUrlResult = typeof TrellisResolvePreviewUrlResult.Type;
