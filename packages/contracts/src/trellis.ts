import * as Schema from "effect/Schema";
import {
  CheckpointId,
  NonNegativeInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

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
  state: TrellisState,
  /** Where Trellis project paths live; also reported while disabled or unavailable when known. */
  root: Schema.optionalKey(Schema.String),
  /**
   * Every root Trellis project paths may live under, including earlier roots,
   * so clients recognize those projects while Trellis is off or down.
   */
  knownRoots: Schema.Array(Schema.String),
  /** The API socket the server uses or would use. */
  socketPath: Schema.String,
  /**
   * Roots of T3 projects whose Trellis item is in the trash or graduated.
   * Clients hide such a project once it has no active thread.
   */
  retiredRoots: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Roots of live forks (non-primary workspaces), which are trashed on their own. */
  forkRoots: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * Roots of live worker forks (forks a thread spawned): clients keep them out
   * of the sidebar and list them with their project's workspaces.
   */
  workerRoots: Schema.optionalKey(Schema.Array(Schema.String)),
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
  /** What to pass to `restore` to undo the trash; absent when nothing was trashed. */
  restore: Schema.optional(
    Schema.Struct({
      kind: Schema.Literals(["idea", "project", "workspace"]),
      id: TrimmedNonEmptyString,
    }),
  ),
});
export type TrellisTrashProjectResult = typeof TrellisTrashProjectResult.Type;

/** An agent's request that the user purge a trashed item. */
export const TrellisPurgeRequest = Schema.Struct({
  /** Unix seconds. */
  at: Schema.Finite,
  reason: Schema.NullOr(Schema.String),
  /** The thread that asked, by title when T3 knows it. */
  by: Schema.NullOr(Schema.String),
});
export type TrellisPurgeRequest = typeof TrellisPurgeRequest.Type;

export const TrellisTrashItem = Schema.Struct({
  /** `workspace` is one trashed fork of a project that is still live. */
  kind: Schema.Literals(["idea", "project", "workspace"]),
  id: Schema.String,
  name: Schema.String,
  /** Unix seconds. */
  deletedAt: Schema.Finite,
  /** Unix seconds when it is removed for good; null when it stays until the trash is emptied. */
  expiresAt: Schema.NullOr(Schema.Finite),
  /**
   * Discarded forks: true when its repository holds work its parent lacks,
   * which keeps it until purged; null when not known.
   */
  unmerged: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  unmergedReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** An agent asked for it to be purged; only the user purges. */
  purgeRequested: Schema.optionalKey(Schema.NullOr(TrellisPurgeRequest)),
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

/** Purges the listed trashed items for good, e.g. confirming an agent's purge request. */
export const TrellisPurgeInput = Schema.Struct({
  ids: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
});
export type TrellisPurgeInput = typeof TrellisPurgeInput.Type;

/** The workspaces of the Trellis project behind a T3 project. */
export const TrellisWorkspacesInput = Schema.Struct({ projectId: ProjectId });
export type TrellisWorkspacesInput = typeof TrellisWorkspacesInput.Type;

/**
 * One workspace of a Trellis project: its primary workspace, a fork, or a
 * discarded fork still in the trash.
 */
export const TrellisWorkspaceEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** `primary` is the project's own workspace; forks are hidden from the sidebar when spawned. */
  kind: Schema.Literals(["primary", "fork"]),
  state: Schema.Literals(["running", "stopped", "checkpointing", "discarded"]),
  /** Its T3 project, when it has one (live workspaces). */
  projectId: Schema.NullOr(ProjectId),
  /** The thread that spawned it (a worker fork), by id and title. */
  spawnedBy: Schema.NullOr(
    Schema.Struct({ threadId: ThreadId, title: Schema.NullOr(Schema.String) }),
  ),
  /** Unix seconds. */
  createdAt: Schema.NullOr(Schema.Finite),
  deletedAt: Schema.NullOr(Schema.Finite),
  /** Discarded forks: see `TrellisTrashItem`. */
  unmerged: Schema.NullOr(Schema.Boolean),
  unmergedReason: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.Finite),
  purgeRequested: Schema.NullOr(TrellisPurgeRequest),
});
export type TrellisWorkspaceEntry = typeof TrellisWorkspaceEntry.Type;

export const TrellisWorkspaceList = Schema.Struct({
  /** The Trellis project; null when the T3 project is not a Trellis project. */
  trellisProjectId: Schema.NullOr(Schema.String),
  items: Schema.Array(TrellisWorkspaceEntry),
});
export type TrellisWorkspaceList = typeof TrellisWorkspaceList.Type;

export const TrellisCheckpointsInput = Schema.Struct({ workspaceId: TrimmedNonEmptyString });
export type TrellisCheckpointsInput = typeof TrellisCheckpointsInput.Type;

/** A checkpoint snapshot, which forks start from. */
export const TrellisCheckpointEntry = Schema.Struct({
  id: Schema.String,
  label: Schema.NullOr(Schema.String),
  /** Unix seconds. */
  createdAt: Schema.Finite,
});
export type TrellisCheckpointEntry = typeof TrellisCheckpointEntry.Type;

/** Newest first. */
export const TrellisCheckpointList = Schema.Struct({
  items: Schema.Array(TrellisCheckpointEntry),
});
export type TrellisCheckpointList = typeof TrellisCheckpointList.Type;

/**
 * Forks a workspace from one of its checkpoints, for the user: a visible
 * workspace (no `spawned_by`), whose threads are leads.
 */
export const TrellisForkWorkspaceInput = Schema.Struct({
  workspaceId: TrimmedNonEmptyString,
  snapshot: TrimmedNonEmptyString,
  name: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(100))),
});
export type TrellisForkWorkspaceInput = typeof TrellisForkWorkspaceInput.Type;

export const TrellisForkWorkspaceResult = Schema.Struct({
  workspaceId: Schema.String,
  name: Schema.String,
  /** The fork's T3 project, once synced. */
  projectId: Schema.NullOr(ProjectId),
  /** Resource warnings (many running workspaces, memory nearly full). */
  warnings: Schema.Array(Schema.String),
});
export type TrellisForkWorkspaceResult = typeof TrellisForkWorkspaceResult.Type;

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

/** The checkpoint a file restore would return to: by id, or by its turn count. */
export const TrellisRestoreConflictsInput = Schema.Struct({
  threadId: ThreadId,
  checkpointId: Schema.optionalKey(CheckpointId),
  turnCount: Schema.optionalKey(NonNegativeInt),
});
export type TrellisRestoreConflictsInput = typeof TrellisRestoreConflictsInput.Type;

const TrellisRestoreConflictThread = Schema.Struct({ threadId: ThreadId, title: Schema.String });
const TrellisRestoreLaterWork = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  /** Its latest run with changes; the rollback acknowledges exactly this. */
  runId: RunId,
});

/**
 * Other threads in the same Trellis restore scope (an idea's folder or a
 * whole workspace). A restore is refused while any is `running`; `later`
 * threads did work there after the checkpoint, which the restore undoes, so
 * the rollback must name them, with their run, in `acknowledgeWork`. Both are empty
 * outside Trellis projects.
 */
export const TrellisRestoreConflicts = Schema.Struct({
  running: Schema.Array(TrellisRestoreConflictThread),
  later: Schema.Array(TrellisRestoreLaterWork),
});
export type TrellisRestoreConflicts = typeof TrellisRestoreConflicts.Type;

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

/**
 * Input for the `trellis_checkpoint` MCP tool: a checkpoint of the calling
 * thread's dedicated Trellis workspace, which ends the calling turn. The
 * result arrives as the thread's next message.
 */
export const TrellisCheckpointMcpInput = Schema.Struct({
  name: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
      description: "Name of the checkpoint (it names and pins the snapshot).",
    }),
  ),
  interrupt: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Also end the running turns of your own delegated workers (and theirs) in this workspace; they continue after the restart. Other threads' running turns always refuse the checkpoint.",
    }),
  ),
});
export type TrellisCheckpointMcpInput = typeof TrellisCheckpointMcpInput.Type;

/**
 * Input for the `trellis_discard_fork` MCP tool: moves a fork of the caller's
 * project to the Trellis trash, and optionally asks the user to purge it.
 */
export const TrellisDiscardForkMcpInput = Schema.Struct({
  fork: TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
    description: "The fork's workspace id (ws-...) or name within this project.",
  }),
  requestPurge: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Also ask the user to purge it for good (agents never purge). Use only when its work is truly not needed; a fork already in the trash is not discarded again.",
    }),
  ),
  reason: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)).annotate({
      description: "Why it can go, shown to the user with the purge request.",
    }),
  ),
});
export type TrellisDiscardForkMcpInput = typeof TrellisDiscardForkMcpInput.Type;

export const TrellisDiscardForkMcpResult = Schema.Struct({
  workspaceId: Schema.String,
  name: Schema.String,
  /** False when it was already in the trash. */
  discarded: Schema.Boolean,
  /** Whether it holds work its parent lacks (kept until purged), when Trellis knows. */
  unmerged: Schema.NullOr(Schema.Boolean),
  unmergedReason: Schema.NullOr(Schema.String),
  /** Unix seconds when it expires; null keeps it until purged. */
  expiresAt: Schema.NullOr(Schema.Finite),
  purgeRequested: Schema.Boolean,
});
export type TrellisDiscardForkMcpResult = typeof TrellisDiscardForkMcpResult.Type;

export class TrellisDiscardForkMcpFailure extends Schema.TaggedError<TrellisDiscardForkMcpFailure>()(
  "TrellisDiscardForkMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "thread_not_found",
      "not_a_trellis_workspace",
      "fork_not_found",
      "fork_not_owned",
      "threads_running",
      "trellis_unavailable",
      "operation_failed",
    ]),
    message: Schema.String,
  },
) {}

export const TrellisCheckpointMcpResult = Schema.Struct({
  status: Schema.Literal("started"),
  /** Workers whose turns are being ended, by title. */
  interrupting: Schema.Array(Schema.String),
  note: Schema.String,
});
export type TrellisCheckpointMcpResult = typeof TrellisCheckpointMcpResult.Type;

export class TrellisCheckpointMcpFailure extends Schema.TaggedError<TrellisCheckpointMcpFailure>()(
  "TrellisCheckpointMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "thread_not_found",
      "not_a_trellis_workspace",
      "threads_running",
      "checkpoint_in_progress",
      "trellis_unavailable",
      "operation_failed",
    ]),
    message: Schema.String,
  },
) {}

/**
 * Input for the `trellis_graduate` MCP tool: graduates the calling thread's
 * idea into a dedicated project and moves its threads there, which ends the
 * calling turn. The result arrives as the thread's next message, in the new
 * project.
 */
export const TrellisGraduateMcpInput = Schema.Struct({
  base: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
      description: "Base image of the new project's workspace; default: Trellis's default base.",
    }),
  ),
  name: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
      description: "Name of the new project; default: the idea's name.",
    }),
  ),
  interrupt: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Also end the running turns of your own delegated workers (and theirs) in this idea; they continue in the new project. Other threads' running turns always refuse the graduation.",
    }),
  ),
});
export type TrellisGraduateMcpInput = typeof TrellisGraduateMcpInput.Type;

export const TrellisGraduateMcpResult = Schema.Struct({
  status: Schema.Literal("started"),
  /** Workers whose turns are being ended, by title. */
  interrupting: Schema.Array(Schema.String),
  note: Schema.String,
});
export type TrellisGraduateMcpResult = typeof TrellisGraduateMcpResult.Type;

export class TrellisGraduateMcpFailure extends Schema.TaggedError<TrellisGraduateMcpFailure>()(
  "TrellisGraduateMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "thread_not_found",
      "not_an_idea",
      "threads_running",
      "graduation_in_progress",
      "trellis_unavailable",
      "operation_failed",
    ]),
    message: Schema.String,
  },
) {}

/** Graduates the idea behind a T3 project into a dedicated project (the "Graduate" action). */
export const TrellisGraduateInput = Schema.Struct({
  projectId: ProjectId,
  base: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
});
export type TrellisGraduateInput = typeof TrellisGraduateInput.Type;

export const TrellisGraduateResult = Schema.Struct({
  /** The new project's T3 project. */
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  name: Schema.String,
  /** Threads that could not move now (they move once their turn ends). */
  notMoved: Schema.Array(Schema.String),
});
export type TrellisGraduateResult = typeof TrellisGraduateResult.Type;

/** The bases a Trellis project can start from. */
export const TrellisBasesResult = Schema.Struct({
  bases: Schema.Array(Schema.String),
  defaultBase: Schema.NullOr(Schema.String),
});
export type TrellisBasesResult = typeof TrellisBasesResult.Type;

/** A Trellis workspace named by id, with its display name when T3 knows its project. */
export const TrellisWorkspaceRef = Schema.Struct({
  id: Schema.String,
  /** The project's name for its primary workspace, `project · fork` for a fork, `Ideas` for the scratch workspace. */
  name: Schema.NullOr(Schema.String),
});
export type TrellisWorkspaceRef = typeof TrellisWorkspaceRef.Type;

/**
 * The Trellis service as `GET /v1/status` reports it, for the settings page.
 * Older Trellis versions lack most fields: those read as null (or empty).
 */
export const TrellisDetails = Schema.Struct({
  root: Schema.String,
  version: Schema.NullOr(Schema.String),
  /** The build's commit; `-dirty` marks uncommitted changes. */
  commit: Schema.NullOr(Schema.String),
  uptimeSecs: Schema.NullOr(Schema.Finite),
  bases: Schema.Array(Schema.String),
  /**
   * Per base, whether it was built from its current definition: `current`,
   * `stale`, `unrecorded` or `custom` (others may come); null when not reported.
   */
  baseStates: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  /** May name a base that is not built (absent from `bases`). */
  defaultBase: Schema.NullOr(Schema.String),
  /** Configured provider CLIs not found on the service's PATH. */
  missingProviders: Schema.Array(Schema.String),
  /** Host paths of the provider homes mounted into workspaces; null when not reported. */
  agentHomes: Schema.NullOr(
    Schema.Struct({ claude: Schema.NullOr(Schema.String), codex: Schema.NullOr(Schema.String) }),
  ),
  /** Null when Trellis could not ask podman or does not report them. */
  runningWorkspaces: Schema.NullOr(Schema.Array(TrellisWorkspaceRef)),
  /** Running workspaces started with an older mount layout or binary; null when not reported. */
  restartNeeded: Schema.NullOr(
    Schema.Array(Schema.Struct({ ...TrellisWorkspaceRef.fields, reason: Schema.String })),
  ),
  /** Journaled operations an interruption left unfinished, with the workspace or project they touch. */
  pendingOperations: Schema.Array(
    Schema.Struct({ kind: Schema.String, target: Schema.NullOr(Schema.String) }),
  ),
  /** The root's filesystem; null when not reported. */
  disk: Schema.NullOr(Schema.Struct({ freeBytes: Schema.Finite, totalBytes: Schema.Finite })),
});
export type TrellisDetails = typeof TrellisDetails.Type;

export const TrellisBuildBaseInput = Schema.Struct({
  name: TrimmedNonEmptyString,
});
export type TrellisBuildBaseInput = typeof TrellisBuildBaseInput.Type;

export const TrellisBuildBaseResult = Schema.Struct({
  name: Schema.String,
  state: Schema.NullOr(Schema.String),
});
export type TrellisBuildBaseResult = typeof TrellisBuildBaseResult.Type;
