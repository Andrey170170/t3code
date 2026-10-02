// @effect-diagnostics nodeBuiltinImport:off
/**
 * Trellis - client for the optional local Trellis workspace service.
 *
 * Trellis manages isolated workspaces (Btrfs subvolumes run as rootless podman
 * containers). Its API is JSON over HTTP on a Unix socket. The integration is
 * off until the `trellis.enabled` server setting turns it on; while it is off
 * nothing talks to the socket. When it is off or Trellis is unreachable,
 * `current` is null and every Trellis-aware seam in T3 behaves as without
 * Trellis, except that Trellis project paths (see `expectedRoots`) are never
 * treated as ordinary host folders.
 *
 * Project files live at `<root>/workspaces/<ws>/project[/<idea>]`, and the same
 * path exists inside the workspace container, so T3 reads files and git state
 * from the host path and passes the same path as cwd to processes inside.
 *
 * @module trellis/Trellis
 */
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { type TrellisDetails, TrellisError, type TrellisStatus } from "@t3tools/contracts";
import {
  isTrellisManagedPath as isSharedTrellisManagedPath,
  trellisWorkspaceIdOf,
} from "@t3tools/shared/trellis";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const DEFAULT_TRELLIS_SOCKET = "/trellis/state/api.sock";

/** How long a failed implicit probe of Trellis is not repeated. */
const DISCOVERY_RETRY_MS = 10_000;

/** Turn messages wait while a workspace checkpoints; Trellis gives up after 15 minutes. */
const TURN_WAIT_MS = 16 * 60_000;

/** Who spawned a fork: the thread whose `fork` created it, and the workspace it forked. */
export const TrellisSpawnedBy = Schema.Struct({ thread: Schema.String, workspace: Schema.String });

export const TrellisWorkspaceView = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  name: Schema.String,
  path: Schema.String,
  deleted_at: Schema.NullOr(Schema.Finite),
  // Absent from older Trellis versions.
  project_id: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.Finite),
  /** Container state; always false in light listings. */
  running: Schema.optional(Schema.Boolean),
  checkpointing: Schema.optional(Schema.Boolean),
  parent_snapshot: Schema.optional(Schema.NullOr(Schema.String)),
  spawned_by: Schema.optional(Schema.NullOr(TrellisSpawnedBy)),
});
export type TrellisWorkspaceView = typeof TrellisWorkspaceView.Type;

export const TrellisProjectView = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  name: Schema.String,
  /**
   * Who named it: `default` (placeholder), `derived` (e.g. the git repo),
   * `generated` (a client's naming model), `agent` or `user`. Absent from
   * Trellis versions that predate it.
   */
  name_source: Schema.optional(Schema.String),
  description: Schema.String,
  workspace_id: Schema.String,
  path: Schema.String,
  updated_at: Schema.Finite,
  deleted_at: Schema.NullOr(Schema.Finite),
  graduated_to: Schema.NullOr(Schema.String),
  workspaces: Schema.Array(TrellisWorkspaceView),
});
export type TrellisProjectView = typeof TrellisProjectView.Type;

export const TrellisSnapshot = Schema.Struct({
  id: Schema.String,
  workspace_id: Schema.String,
  seq: Schema.Finite,
  kind: Schema.String,
  /** Pinned snapshots survive thinning. Absent from older Trellis versions. */
  pinned: Schema.optional(Schema.Boolean),
  thread: Schema.NullOr(Schema.String),
  turn: Schema.NullOr(Schema.String),
  created_at: Schema.Finite,
  label: Schema.optional(Schema.NullOr(Schema.String)),
});
export type TrellisSnapshot = typeof TrellisSnapshot.Type;

/** `at` is Unix seconds; `data` depends on `kind`. */
export const TrellisActivity = Schema.Struct({
  at: Schema.Finite,
  kind: Schema.String,
  data: Schema.Unknown,
});
export type TrellisActivity = typeof TrellisActivity.Type;

export const TrellisFindHitView = Schema.Struct({
  project: TrellisProjectView,
  matches: Schema.Array(Schema.Struct({ path: Schema.String, snippet: Schema.String })),
});
export type TrellisFindHitView = typeof TrellisFindHitView.Type;

export const TrellisResolved = Schema.Struct({
  workspace: TrellisWorkspaceView,
  project: Schema.NullOr(TrellisProjectView),
});
export type TrellisResolved = typeof TrellisResolved.Type;

/** A trashed project or workspace as `GET /v1/trash` lists it. */
export const TrellisTrashEntryView = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  name: Schema.String,
  project_id: Schema.optional(Schema.NullOr(Schema.String)),
  deleted_at: Schema.NullOr(Schema.Finite),
  /** When Trellis removes it for good; null keeps it until the trash is emptied. */
  expires_at: Schema.optional(Schema.NullOr(Schema.Finite)),
  /** Discarded forks only: whether its repository holds work its parent lacks. */
  unmerged: Schema.optional(Schema.NullOr(Schema.Boolean)),
  unmerged_reason: Schema.optional(Schema.NullOr(Schema.String)),
  /** An agent asked the user to purge it. */
  purge_requested: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        at: Schema.Finite,
        reason: Schema.NullOr(Schema.String),
        thread: Schema.NullOr(Schema.String),
      }),
    ),
  ),
  spawned_by: Schema.optional(Schema.NullOr(TrellisSpawnedBy)),
});
export type TrellisTrashEntryView = typeof TrellisTrashEntryView.Type;

export const TrellisTrashView = Schema.Struct({
  projects: Schema.Array(TrellisTrashEntryView),
  workspaces: Schema.Array(TrellisTrashEntryView),
  /** How long ideas stay in the trash; older Trellis versions sent `purge_after_days`. */
  idea_expiry_days: Schema.optional(Schema.Finite),
  purge_after_days: Schema.optional(Schema.Finite),
});
export type TrellisTrashView = typeof TrellisTrashView.Type;

const TrellisStatusView = Schema.Struct({
  root: Schema.String,
  /** Absent from Trellis versions before agent homes were configurable. */
  agent_homes: Schema.optional(
    Schema.Struct({ claude: Schema.NullOr(Schema.String), codex: Schema.NullOr(Schema.String) }),
  ),
});

/** A service a fork started (`POST /v1/fork {services}`), not yet ready. */
export const TrellisStartedService = Schema.Struct({
  name: Schema.String,
  state: Schema.String,
  error: Schema.optional(Schema.String),
  previews: Schema.optional(
    Schema.Array(Schema.Struct({ port: Schema.Finite, url: Schema.String })),
  ),
});
export type TrellisStartedService = typeof TrellisStartedService.Type;

/** `POST /v1/fork`: the new workspace, with resource warnings and started services. */
const TrellisForkView = Schema.Struct({
  ...TrellisWorkspaceView.fields,
  warnings: Schema.optional(Schema.Array(Schema.String)),
  services: Schema.optional(Schema.Array(TrellisStartedService)),
});
export type TrellisForkView = typeof TrellisForkView.Type;
const TrellisPurgeView = Schema.Struct({ purged: Schema.Finite });
const TrellisRollbackView = Schema.Struct({ undo_snapshot: Schema.optional(Schema.Unknown) });
const TrellisDescribeView = Schema.Struct({
  ignored: Schema.optional(Schema.Array(Schema.String)),
  // Older Trellis versions.
  ignored_pinned: Schema.optional(Schema.Array(Schema.String)),
});
const TrellisPreviewView = Schema.Struct({ host_port: Schema.Finite, url: Schema.String });
const TrellisPrimerView = Schema.Struct({ primer: Schema.String });

/**
 * A TCP port listening inside a running workspace. `reachable`: a preview of
 * it can connect (bound to loopback or all addresses); `preview`: the URL of
 * its existing preview, if any.
 */
export const TrellisPort = Schema.Struct({
  port: Schema.Int,
  address: Schema.String,
  reachable: Schema.Boolean,
  preview: Schema.NullOr(Schema.String),
});
export type TrellisPort = typeof TrellisPort.Type;
const TrellisErrorBody = Schema.Struct({ error: Schema.String });
const TrellisTurnsView = Schema.Struct({ restarted: Schema.Array(Schema.String) });

/** An open turn as Trellis records it. */
export const TrellisOpenTurn = Schema.Struct({
  workspace: Schema.String,
  /** The idea (or project) the turn's target resolved to; absent from older Trellis versions. */
  project: Schema.optional(Schema.NullOr(Schema.String)),
  thread: Schema.String,
  turn: Schema.String,
});
export type TrellisOpenTurn = typeof TrellisOpenTurn.Type;

const TrellisProc = Schema.Struct({ pid: Schema.Finite, cmd: Schema.String });

/** What a checkpoint did (`POST /v1/checkpoint`). */
export const TrellisCheckpointResult = Schema.Struct({
  snapshot: Schema.optional(Schema.Struct({ id: Schema.String })),
  checkpoint: Schema.Boolean,
  stopped: Schema.Array(TrellisProc),
  interrupted: Schema.Array(Schema.String),
  restarted: Schema.Boolean,
});
export type TrellisCheckpointResult = typeof TrellisCheckpointResult.Type;

/** A checkpoint Trellis refused or that failed; `details` carries how far it got. */
const TrellisCheckpointRefusal = Schema.Struct({
  error: Schema.String,
  details: Schema.optional(
    Schema.Struct({
      restarted: Schema.optional(Schema.Boolean),
      snapshot: Schema.optional(Schema.Unknown),
      stopped: Schema.optional(Schema.Array(TrellisProc)),
      late: Schema.optional(Schema.Array(TrellisProc)),
      survivors: Schema.optional(Schema.Array(TrellisProc)),
      ms: Schema.optional(Schema.Struct({ stop: Schema.optional(Schema.Finite) })),
    }),
  ),
});

/**
 * A checkpoint's outcome: its result, or Trellis's refusal or failure, with
 * whether the workspace was stopped and restarted anyway (its processes are
 * gone then).
 */
export type TrellisCheckpointOutcome =
  | { readonly ok: true; readonly result: TrellisCheckpointResult }
  | {
      readonly ok: false;
      readonly error: string;
      /** The stop ran (and Trellis restarted the workspace on its way out). */
      readonly restarted: boolean;
      /** Processes the stop ended, when it ran. */
      readonly stopped: ReadonlyArray<{ readonly pid: number; readonly cmd: string }>;
    };

/** A turn start Trellis refused because the idea graduated (409, `details.graduated_to`). */
const TrellisGraduatedRefusal = Schema.Struct({
  error: Schema.String,
  details: Schema.Struct({
    graduated_to: Schema.String,
    restarted: Schema.optional(Schema.Array(Schema.String)),
  }),
});

/** A graduation Trellis refused (409, `details.turns`: other threads mid-turn in the idea). */
const TrellisGraduationRefusal = Schema.Struct({
  error: Schema.String,
  details: Schema.optional(
    Schema.Struct({
      turns: Schema.optional(
        Schema.Array(Schema.Struct({ thread: Schema.String, turn: Schema.String })),
      ),
    }),
  ),
});

/**
 * What graduating an idea did: the new project, or Trellis's refusal or
 * failure, with the threads whose open turns refused it.
 */
export type TrellisGraduationOutcome =
  | { readonly ok: true; readonly project: TrellisProjectView }
  | {
      readonly ok: false;
      readonly error: string;
      readonly turns: ReadonlyArray<{ readonly thread: string; readonly turn: string }>;
    };

const TrellisBasesView = Schema.Struct({
  bases: Schema.optional(Schema.Array(Schema.String)),
  default_base: Schema.optional(Schema.String),
});

/**
 * `GET /v1/status` in full, for the settings page. Every field but `root` is
 * absent from some Trellis version; `restart_needed` from all before Ops 2.
 */
const TrellisDetailsView = Schema.Struct({
  root: Schema.String,
  version: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
  uptime_secs: Schema.optional(Schema.Finite),
  bases: Schema.optional(Schema.Array(Schema.String)),
  default_base: Schema.optional(Schema.NullOr(Schema.String)),
  missing_providers: Schema.optional(Schema.Array(Schema.String)),
  agent_homes: Schema.optional(
    Schema.Struct({ claude: Schema.NullOr(Schema.String), codex: Schema.NullOr(Schema.String) }),
  ),
  running_workspaces: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  restart_needed: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Struct({ workspace: Schema.String, reason: Schema.String }))),
  ),
  pending_operations: Schema.optional(
    Schema.Array(Schema.Struct({ kind: Schema.String, data: Schema.optional(Schema.Unknown) })),
  ),
  disk: Schema.optional(
    Schema.NullOr(Schema.Struct({ free_bytes: Schema.Finite, total_bytes: Schema.Finite })),
  ),
});

/** The workspace (`ws`) or project a pending operation's journal data names. */
function pendingTarget(data: unknown): string | null {
  for (const key of ["ws", "project"]) {
    if (Predicate.hasProperty(data, key) && typeof data[key] === "string") return data[key];
  }
  return null;
}

const toDetails = (view: typeof TrellisDetailsView.Type): TrellisDetails => ({
  root: view.root,
  version: view.version ?? null,
  commit: view.commit ?? null,
  uptimeSecs: view.uptime_secs ?? null,
  bases: view.bases ?? [],
  defaultBase: view.default_base ?? null,
  missingProviders: view.missing_providers ?? [],
  agentHomes: view.agent_homes ?? null,
  runningWorkspaces: view.running_workspaces?.map((id) => ({ id, name: null })) ?? null,
  restartNeeded:
    view.restart_needed?.map((entry) => ({
      id: entry.workspace,
      name: null,
      reason: entry.reason,
    })) ?? null,
  pendingOperations: (view.pending_operations ?? []).map((operation) => ({
    kind: operation.kind,
    target: pendingTarget(operation.data),
  })),
  disk:
    view.disk == null
      ? null
      : { freeBytes: view.disk.free_bytes, totalBytes: view.disk.total_bytes },
});

const sameAgentHomes = (a: TrellisAgentHomes | undefined, b: TrellisAgentHomes | undefined) =>
  a?.claude === b?.claude && a?.codex === b?.codex && (a === undefined) === (b === undefined);

/** Trellis refuses a turn message older than one it applied (409). */
export const isStaleTurnMessage = (error: TrellisError) =>
  /^turn message -?\d+ is older than one already applied/.test(error.message);

/**
 * Host paths of the Claude and Codex homes Trellis mounts into workspaces;
 * null for a provider whose home it does not mount.
 */
export interface TrellisAgentHomes {
  readonly claude: string | null;
  readonly codex: string | null;
}

/** Enabled Trellis state. `shimDir` is null when provider shims could not be created. */
export interface TrellisEnv {
  readonly root: string;
  readonly bin: string;
  readonly shimDir: string | null;
  /** Absent when Trellis does not report them: it then mounts `~/.claude` and `~/.codex`. */
  readonly agentHomes?: TrellisAgentHomes;
}

/** See `TrellisState` in the contracts. */
export interface TrellisConnection {
  readonly state: "disabled" | "unavailable" | "ready";
  readonly root: string | null;
  readonly socketPath: string;
}

/** Message for work in a Trellis project path while the integration is off. */
export const TRELLIS_DISABLED_MESSAGE =
  "The Trellis integration is turned off on this server, so this project's workspace is unavailable. Turn it on in Settings → Trellis and try again.";

/** True when `cwd` is inside a Trellis project directory (`<root>/workspaces/<ws>/project`). */
export const isTrellisManagedPath = isSharedTrellisManagedPath;

/** The id of the Trellis workspace holding `path` under any of `roots`, else null. */
export function trellisWorkspaceOf(roots: ReadonlyArray<string>, path: string): string | null {
  for (const root of roots) {
    const workspace = trellisWorkspaceIdOf(root, path);
    if (workspace !== null) return workspace;
  }
  return null;
}

/** `<root>` for a socket at the conventional `<root>/state/api.sock`, else null. */
function rootFromSocketPath(socketPath: string): string | null {
  const stateDir = NodePath.posix.dirname(socketPath);
  return NodePath.posix.basename(socketPath) === "api.sock" &&
    NodePath.posix.basename(stateDir) === "state"
    ? NodePath.posix.dirname(stateDir)
    : null;
}

export class Trellis extends Context.Service<
  Trellis,
  {
    /** Last known state; null when Trellis is disabled or unreachable. */
    readonly current: Effect.Effect<TrellisEnv | null>;
    /**
     * Re-reads `/v1/status` (and creates provider shims on first success).
     * Null without touching the socket while the integration is off.
     */
    readonly refresh: Effect.Effect<TrellisEnv | null>;
    /**
     * `current`, or a refresh when the integration is on but Trellis is not
     * known to be up. A failed probe is not repeated for a short while, so an
     * unresponsive socket delays at most one caller per interval.
     */
    readonly discover: Effect.Effect<TrellisEnv | null>;
    /**
     * `path` with symlinks resolved, so an alias of a workspace path is
     * classified as the workspace path it is; `path` itself when it cannot be
     * resolved. A path inside a Trellis root is named under that root as
     * Trellis names it, so a symlinked root still matches its paths.
     */
    readonly canonicalPath: (path: string) => Effect.Effect<string>;
    /** Whether the `trellis.enabled` setting is on. */
    readonly enabled: Effect.Effect<boolean>;
    /** Disabled, unavailable or ready, from the setting and the last refresh. */
    readonly connection: Effect.Effect<TrellisConnection>;
    /**
     * Every place Trellis project paths may live, also while Trellis is off or
     * unreachable: the live root, every root Trellis ever reported (persisted
     * across restarts), `TRELLIS_ROOT`, and the root implied by the socket
     * path. Work in those paths must fail rather than silently run on the host.
     * While enabled but not known to be up, Trellis is asked first, so a root
     * only it can report is never missed.
     */
    readonly expectedRoots: Effect.Effect<ReadonlyArray<string>>;
    /** The `trellis` binary, for `trellis exec`. */
    readonly bin: string;
    /**
     * `all` includes trashed workspaces; `spawnedBy` keeps forks a thread (or
     * threads of a workspace) spawned. This listing queries container state.
     */
    readonly listWorkspaces: (options: {
      readonly all: boolean;
      readonly spawnedBy?: string | undefined;
    }) => Effect.Effect<ReadonlyArray<TrellisWorkspaceView>, TrellisError>;
    /**
     * Forks `target`'s workspace from `snapshot` (a checkpoint). A `thread`
     * is recorded as the fork's `spawned_by`; `services` starts those
     * workspace services in it.
     */
    readonly fork: (input: {
      readonly target: string;
      readonly snapshot: string;
      readonly name?: string | undefined;
      readonly thread?: string | undefined;
      readonly services?: "none" | "all" | ReadonlyArray<string> | undefined;
    }) => Effect.Effect<TrellisForkView, TrellisError>;
    /** Records activity in the target's workspace (for example a `summary`). */
    readonly recordActivity: (input: {
      readonly target: string;
      readonly kind: string;
      readonly data: unknown;
    }) => Effect.Effect<void, TrellisError>;
    /** Asks the user to purge trashed items; agents never purge. */
    readonly requestPurge: (input: {
      readonly ids: ReadonlyArray<string>;
      readonly reason?: string | undefined;
      readonly thread?: string | undefined;
    }) => Effect.Effect<void, TrellisError>;
    /** Permanently removes the listed trashed items. */
    readonly purge: (ids: ReadonlyArray<string>) => Effect.Effect<number, TrellisError>;
    /** `all` includes trashed and graduated items; the list never includes container state. */
    readonly listProjects: (options: {
      readonly all: boolean;
    }) => Effect.Effect<ReadonlyArray<TrellisProjectView>, TrellisError>;
    readonly createIdea: (input: {
      readonly name?: string | undefined;
    }) => Effect.Effect<TrellisProjectView, TrellisError>;
    readonly createProject: (input: {
      readonly name?: string | undefined;
      readonly gitUrl?: string | undefined;
      readonly base?: string | undefined;
    }) => Effect.Effect<TrellisProjectView, TrellisError>;
    /**
     * Sets the name and/or description. `user` (the default) pins them as a
     * user edit. `generated` and `refined` apply only while the name is still
     * `default` or `generated`; a `refined` name is final for generation.
     * Returns the fields Trellis kept instead.
     */
    readonly describe: (input: {
      readonly target: string;
      readonly name?: string | undefined;
      readonly description?: string | undefined;
      readonly source?: "user" | "generated" | "refined";
    }) => Effect.Effect<{ readonly ignored: ReadonlyArray<string> }, TrellisError>;
    readonly find: (
      query: string,
    ) => Effect.Effect<ReadonlyArray<TrellisFindHitView>, TrellisError>;
    readonly resolve: (target: string) => Effect.Effect<TrellisResolved, TrellisError>;
    readonly listSnapshots: (
      target: string,
    ) => Effect.Effect<ReadonlyArray<TrellisSnapshot>, TrellisError>;
    /** Activity recorded in the target's workspace, newest first. */
    readonly listActivities: (input: {
      readonly target: string;
      readonly kind: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<TrellisActivity>, TrellisError>;
    /**
     * A `turn` snapshot of the target's workspace, tagged with `turn` (and
     * `thread`). `pinned` pins it as it is created; Trellis versions before
     * that ignore it and create it unpinned.
     */
    readonly createSnapshot: (input: {
      readonly target: string;
      readonly thread?: string | undefined;
      readonly turn: string;
      readonly pinned?: boolean;
    }) => Effect.Effect<TrellisSnapshot, TrellisError>;
    /** Pins or unpins a snapshot; thinning keeps pinned ones. Fails when it is gone. */
    readonly setSnapshotPinned: (
      id: string,
      pinned: boolean,
    ) => Effect.Effect<TrellisSnapshot, TrellisError>;
    /** Moves a project (with all its workspaces) to the trash. */
    readonly trashProject: (id: string) => Effect.Effect<void, TrellisError>;
    /** Moves one fork to the trash; the last one trashes its project. */
    readonly trashWorkspace: (id: string) => Effect.Effect<void, TrellisError>;
    readonly restoreProject: (id: string) => Effect.Effect<TrellisProjectView, TrellisError>;
    readonly restoreWorkspace: (id: string) => Effect.Effect<void, TrellisError>;
    readonly listTrash: Effect.Effect<TrellisTrashView, TrellisError>;
    /** Permanently removes everything in the trash. */
    readonly emptyTrash: Effect.Effect<number, TrellisError>;
    /**
     * Idea targets restore only the folder; workspace targets restart the
     * container. Returns the snapshot holding the state from just before.
     */
    readonly rollback: (input: {
      readonly target: string;
      readonly snapshot: string;
    }) => Effect.Effect<{ readonly undoSnapshot: string | null }, TrellisError>;
    /**
     * Publishes a workspace port on the preview host (idempotent per
     * workspace and port). `url` is reachable from the user's browser.
     */
    readonly preview: (input: {
      readonly target: string;
      readonly port: number;
    }) => Effect.Effect<{ readonly hostPort: number; readonly url: string }, TrellisError>;
    /** The published ports of `target`'s workspace, each with its browser `url`. */
    readonly listPreviews: (
      target: string,
    ) => Effect.Effect<ReadonlyArray<{ readonly url: string }>, TrellisError>;
    /**
     * Ports listening inside workspace `workspaceId`. Fails while it is not
     * running or its relay is too old to list them.
     */
    readonly ports: (
      workspaceId: string,
    ) => Effect.Effect<ReadonlyArray<TrellisPort>, TrellisError>;
    /** Short agent orientation for sessions started in `target`. */
    readonly primer: (target: string) => Effect.Effect<string, TrellisError>;
    /**
     * Counts the times Trellis became reachable (from unreachable, or at
     * startup), so a client can resynchronize on every connect.
     */
    readonly connects: Effect.Effect<number>;
    /**
     * Reports a turn starting or ending in `target` (user socket only). A
     * start waits while the workspace is checkpointing; `restarted` lists the
     * workspaces a checkpoint stopped and restarted meanwhile. A start in an
     * idea that graduated is refused, with `graduatedTo` naming its project.
     */
    readonly reportTurn: (input: {
      readonly target: string;
      readonly thread: string;
      readonly turn: string;
      readonly event: "start" | "end";
      readonly seq: number;
    }) => Effect.Effect<
      { readonly restarted: ReadonlyArray<string>; readonly graduatedTo?: string },
      TrellisError
    >;
    /** Replaces the whole set of open turns; waits like a start for named workspaces. */
    readonly replaceTurns: (input: {
      readonly open: ReadonlyArray<{
        readonly target: string;
        readonly thread: string;
        readonly turn: string;
      }>;
      readonly seq: number;
    }) => Effect.Effect<{ readonly restarted: ReadonlyArray<string> }, TrellisError>;
    /** The open turns of `target`'s workspace. */
    readonly listTurns: (
      target: string,
    ) => Effect.Effect<ReadonlyArray<TrellisOpenTurn>, TrellisError>;
    /**
     * Takes a checkpoint of a dedicated workspace: waits for guards, stops
     * it, snapshots it and restarts it. Other threads' open turns refuse it
     * unless `interrupt`. Trellis's refusals and failures are outcomes; only
     * an unreachable Trellis fails.
     */
    readonly checkpoint: (input: {
      readonly target: string;
      readonly name?: string | undefined;
      readonly thread: string;
      readonly interrupt: boolean;
    }) => Effect.Effect<TrellisCheckpointOutcome, TrellisError>;
    /**
     * Graduates an idea into a new dedicated project (user socket). Refused
     * while threads other than `thread` have open turns in the idea; refusals
     * and failures are outcomes, only an unreachable Trellis fails.
     */
    readonly graduate: (input: {
      readonly id: string;
      readonly base?: string | undefined;
      readonly name?: string | undefined;
      readonly thread?: string | undefined;
    }) => Effect.Effect<TrellisGraduationOutcome, TrellisError>;
    /** A project or idea by id, trashed and graduated ones included. */
    readonly getProject: (id: string) => Effect.Effect<TrellisProjectView, TrellisError>;
    /** The bases new projects can start from, and the default. */
    readonly bases: Effect.Effect<
      { readonly bases: ReadonlyArray<string>; readonly defaultBase: string | null },
      TrellisError
    >;
    /** Everything `/v1/status` reports, for display; workspace names are left null. */
    readonly details: Effect.Effect<TrellisDetails, TrellisError>;
  }
>()("t3/trellis/Trellis") {}

interface RawResponse {
  readonly status: number;
  readonly body: string;
}

function requestOverSocket(input: {
  readonly socketPath: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly body: unknown;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = input.body === undefined ? undefined : JSON.stringify(input.body);
    const request = NodeHttp.request(
      {
        socketPath: input.socketPath,
        method: input.method,
        path: input.path,
        signal: input.signal,
        headers: {
          accept: "application/json",
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }),
        },
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.setTimeout(input.timeoutMs, () =>
      request.destroy(new Error(`timed out after ${input.timeoutMs}ms`)),
    );
    request.on("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

const decodeJson = <S extends Schema.Top>(schema: S, text: string, status: number) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError(
      (error) =>
        new TrellisError({
          message: `Unexpected Trellis response (HTTP ${status}): ${error.message}`,
        }),
    ),
  );

/**
 * Routes newer than the Trellis T3 first ran against, with the first Trellis
 * that serves them. An older Trellis answers 404 or 405 without an error body.
 */
const ROUTE_MINIMUM: ReadonlyArray<{ readonly route: string; readonly since: string }> = [
  {
    route: "GET /v1/activities",
    since: "main at or after PR #15 (core/checkpoint, d949d28)",
  },
  ...["POST /v1/turns", "PUT /v1/turns", "GET /v1/turns", "POST /v1/checkpoint"].map((route) => ({
    route,
    since: "main at or after PR #15 (core/checkpoint, d949d28)",
  })),
  {
    route: "POST /v1/trash/purge-requests",
    since: "main at or after PR #26 (core/stage-b-forks, 90c1ab6)",
  },
];

/** The error for a failed response whose body is not Trellis' `{error}`. */
function trellisStatusError(method: string, path: string, status: number): TrellisError {
  const route = `${method} ${path.split("?")[0]}`;
  if (status === 404 || status === 405) {
    const minimum = ROUTE_MINIMUM.find((entry) => entry.route === route);
    return new TrellisError({
      message: `This Trellis does not support ${route}, which T3 needs here. Update Trellis to ${minimum?.since ?? "a newer version"}.`,
    });
  }
  return new TrellisError({ message: `Trellis answered ${route} with HTTP ${status}.` });
}

const query = (params: Record<string, string>) => new URLSearchParams(params).toString();

/**
 * The roots listed in the `trellis-root` state file, one per line. Keeps
 * absolute paths only, and never `/` itself, which would claim every host path.
 */
export function parseKnownRoots(text: string): ReadonlyArray<string> {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/\/+$/, ""))
    .filter((line) => line.startsWith("/"));
}

/**
 * For the offline CLI, which runs without Trellis or its catalog: refuses
 * deleting a project under a Trellis root this state directory has used,
 * since that would delete its conversations and the catalog would bring it
 * back. See `TrellisCatalog.checkProjectDelete` for the server's check.
 */
export const refuseOfflineTrellisProjectDelete = (input: {
  readonly stateDir: string;
  readonly workspaceRoot: string;
  readonly title: string;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const roots = yield* fileSystem
      .readFileString(NodePath.join(input.stateDir, "trellis-root"))
      .pipe(
        Effect.map(parseKnownRoots),
        // No file: Trellis was never used here. Any other failure refuses,
        // since a Trellis project could not be told apart.
        Effect.catch((error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed<ReadonlyArray<string>>([])
            : Effect.fail(
                new TrellisError({
                  message: `Could not read the recorded Trellis roots, so "${input.title}" was not removed: ${error.message}`,
                }),
              ),
        ),
      );
    if (roots.some((root) => isTrellisManagedPath(root, input.workspaceRoot))) {
      return yield* new TrellisError({
        message: `"${input.title}" is a Trellis project. Start T3 and move it to the Trellis trash instead; removing only its T3 entry would delete its conversations, and the project would come back.`,
      });
    }
  });

const make = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const serverSettings = yield* ServerSettingsService;
  const socketPath = yield* Config.String("TRELLIS_SOCKET").pipe(
    Config.withDefault(DEFAULT_TRELLIS_SOCKET),
  );
  const bin = yield* Config.String("TRELLIS_BIN").pipe(Config.withDefault("trellis"));
  // The `trellis` CLI's own root override, which shims and terminals inherit.
  const envRoot = yield* Config.String("TRELLIS_ROOT").pipe(
    Config.option,
    Effect.map((value) => Option.getOrNull(value)),
  );
  const shimDir = NodePath.join(serverConfig.stateDir, "trellis-shims");
  // Every root Trellis reported, one per line, kept so their paths stay
  // recognizable while the integration is off or Trellis is down, including
  // after a restart or a root change.
  const rootFile = NodePath.join(serverConfig.stateDir, "trellis-root");
  const state = yield* Ref.make<TrellisEnv | null>(null);
  const persistedRoots = yield* fileSystem.readFileString(rootFile).pipe(
    Effect.map(parseKnownRoots),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  const knownRoots = yield* Ref.make<ReadonlyArray<string>>(persistedRoots);
  let lastShimAttemptMs = 0;

  const enabled = serverSettings.getSettings.pipe(
    Effect.map((value) => value.trellis.enabled),
    Effect.orElseSucceed(() => false),
  );

  const request = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options: { readonly body?: unknown; readonly timeoutMs?: number } = {},
  ) =>
    Effect.gen(function* () {
      if (!(yield* enabled)) {
        return yield* new TrellisError({
          message: "The Trellis integration is turned off on this server.",
        });
      }
      return yield* Effect.tryPromise({
        try: (signal) =>
          requestOverSocket({
            socketPath,
            method,
            path,
            body: options.body,
            timeoutMs: options.timeoutMs ?? 15_000,
            signal,
          }),
        catch: (cause) =>
          new TrellisError({
            message: `Trellis is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      });
    });

  const call = <S extends Schema.Top>(
    schema: S,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options: { readonly body?: unknown; readonly timeoutMs?: number } = {},
  ) =>
    request(method, path, options).pipe(
      Effect.flatMap((response) =>
        response.status >= 400
          ? // Trellis' own refusals carry `{error}`; a missing route does not.
            decodeJson(TrellisErrorBody, response.body, response.status).pipe(
              Effect.mapError(() => trellisStatusError(method, path, response.status)),
              Effect.flatMap((body) => Effect.fail(new TrellisError({ message: body.error }))),
            )
          : decodeJson(schema, response.body, response.status),
      ),
    );

  // Shims are symlinks named `codex` and `claude` to the trellis binary. Run in
  // a Trellis project path they execute the provider inside the workspace.
  const ensureShims = Effect.gen(function* () {
    yield* fileSystem.makeDirectory(shimDir, { recursive: true });
    const result = yield* processRunner.run({
      command: bin,
      args: ["shims", "--dir", shimDir],
      timeout: "10 seconds",
    });
    if (result.code !== 0) {
      return yield* new TrellisError({
        message: result.stderr.trim() || `trellis shims exited with code ${result.code}`,
      });
    }
    const present = yield* Effect.all([
      fileSystem.exists(NodePath.join(shimDir, "codex")),
      fileSystem.exists(NodePath.join(shimDir, "claude")),
    ]);
    return present.every(Boolean) ? shimDir : null;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Trellis provider shims could not be created", {
        shimDir,
        cause,
      }).pipe(Effect.as(null)),
    ),
  );

  // When a probe last found Trellis unreachable.
  let lastFailedProbeMs = Number.NEGATIVE_INFINITY;
  let connects = 0;
  // Serialized so concurrent refreshes never run `trellis shims` twice or
  // let a slower refresh overwrite a newer result.
  const refreshLock = yield* Semaphore.make(1);
  const refreshUnlocked = Effect.gen(function* () {
    const previous = yield* Ref.get(state);
    if (!(yield* enabled)) {
      if (previous !== null) yield* Effect.logInfo("Trellis integration turned off");
      yield* Ref.set(state, null);
      return null;
    }
    const status = yield* call(TrellisStatusView, "GET", "/v1/status", { timeoutMs: 3_000 }).pipe(
      Effect.option,
    );
    if (status._tag === "None") {
      lastFailedProbeMs = yield* Clock.currentTimeMillis;
      if (previous !== null) yield* Effect.logInfo("Trellis became unavailable");
      yield* Ref.set(state, null);
      return null;
    }
    if (previous === null) connects += 1;
    const agentHomes: Partial<Pick<TrellisEnv, "agentHomes">> =
      status.value.agent_homes === undefined ? {} : { agentHomes: status.value.agent_homes };
    // A failed shim setup is retried at most once a minute.
    const now = yield* Clock.currentTimeMillis;
    if (
      previous !== null &&
      previous.root === status.value.root &&
      (previous.shimDir !== null || now - lastShimAttemptMs < 60_000)
    ) {
      // A restarted Trellis may mount other homes under the same root.
      if (sameAgentHomes(previous.agentHomes, agentHomes.agentHomes)) return previous;
      const { agentHomes: _previousHomes, ...rest } = previous;
      const updated: TrellisEnv = { ...rest, ...agentHomes };
      yield* Ref.set(state, updated);
      return updated;
    }
    lastShimAttemptMs = now;
    const known = yield* Ref.get(knownRoots);
    if (!known.includes(status.value.root)) {
      const next = [...known, status.value.root];
      yield* Ref.set(knownRoots, next);
      yield* fileSystem
        .writeFileString(rootFile, `${next.join("\n")}\n`)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("could not persist the Trellis root", { rootFile, cause }),
          ),
        );
    }
    const next: TrellisEnv = {
      root: status.value.root,
      bin,
      shimDir: yield* ensureShims,
      ...agentHomes,
    };
    yield* Effect.logInfo("Trellis is available", { root: next.root, shimDir: next.shimDir });
    yield* Ref.set(state, next);
    return next;
  });
  const refresh = refreshUnlocked.pipe(refreshLock.withPermits(1));

  const socketRoot = rootFromSocketPath(socketPath);
  // Known state, or null while a failed probe is recent; checked again under
  // the lock so callers queued behind an in-flight probe share its result.
  const settled = Effect.gen(function* () {
    if (!(yield* enabled)) return Option.some(null);
    const known = yield* Ref.get(state);
    if (known !== null) return Option.some(known);
    const now = yield* Clock.currentTimeMillis;
    return now - lastFailedProbeMs < DISCOVERY_RETRY_MS ? Option.some(null) : Option.none();
  });
  const discover = Effect.gen(function* () {
    const fast = yield* settled;
    if (Option.isSome(fast)) return fast.value;
    return yield* Effect.gen(function* () {
      const queued = yield* settled;
      return Option.isSome(queued) ? queued.value : yield* refreshUnlocked;
    }).pipe(refreshLock.withPermits(1));
  });

  const expectedRoots = Effect.gen(function* () {
    const live = (yield* discover)?.root ?? null;
    const roots = [live, ...(yield* Ref.get(knownRoots)), envRoot, socketRoot].filter(
      (root): root is string => root !== null,
    );
    return [...new Set(roots)];
  });

  const realPathOr = (path: string) =>
    fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));
  // Resolved, then named under the first expected root that holds it as
  // that root is named, so a symlinked root and its paths stay aligned.
  const canonicalPath = (path: string) =>
    Effect.gen(function* () {
      const real = yield* realPathOr(path);
      for (const root of yield* expectedRoots) {
        const relative = NodePath.relative(yield* realPathOr(root), real);
        if (relative === "") return root;
        if (relative !== ".." && !relative.startsWith("../") && !NodePath.isAbsolute(relative)) {
          return NodePath.join(root, relative);
        }
      }
      return real;
    });

  const connection = Effect.gen(function* () {
    const on = yield* enabled;
    const env = on ? yield* Ref.get(state) : null;
    return {
      state: !on ? "disabled" : env === null ? "unavailable" : "ready",
      root: env?.root ?? (yield* Ref.get(knownRoots)).at(-1) ?? envRoot ?? socketRoot,
      socketPath,
    } satisfies TrellisConnection;
  });

  return Trellis.of({
    // Null as soon as the setting turns off, before the next refresh.
    current: Effect.gen(function* () {
      return (yield* enabled) ? yield* Ref.get(state) : null;
    }),
    refresh,
    discover,
    canonicalPath,
    enabled,
    connection,
    expectedRoots,
    bin,
    listWorkspaces: ({ all, spawnedBy }) =>
      call(
        Schema.Array(TrellisWorkspaceView),
        "GET",
        `/v1/workspaces?${query({
          ...(all ? { all: "true" } : {}),
          ...(spawnedBy === undefined ? {} : { spawned_by: spawnedBy }),
        })}`,
      ),
    fork: ({ target, snapshot, name, thread, services }) =>
      call(TrellisForkView, "POST", "/v1/fork", {
        body: {
          target,
          snapshot,
          ...(name === undefined ? {} : { name }),
          ...(thread === undefined ? {} : { thread }),
          ...(services === undefined ? {} : { services }),
        },
        // A reflink copy of the snapshot, and with services a container start.
        timeoutMs: 5 * 60_000,
      }),
    recordActivity: (body) =>
      call(Schema.Unknown, "POST", "/v1/activities", { body }).pipe(Effect.asVoid),
    requestPurge: ({ ids, reason, thread }) =>
      call(Schema.Unknown, "POST", "/v1/trash/purge-requests", {
        body: {
          ids,
          ...(reason === undefined ? {} : { reason }),
          ...(thread === undefined ? {} : { thread }),
        },
      }).pipe(Effect.asVoid),
    purge: (ids) =>
      call(TrellisPurgeView, "POST", "/v1/trash/purge", {
        body: { ids },
        timeoutMs: 5 * 60_000,
      }).pipe(Effect.map((view) => view.purged)),
    listProjects: ({ all }) =>
      call(
        Schema.Array(TrellisProjectView),
        "GET",
        `/v1/projects?${query({ light: "true", ...(all ? { all: "true" } : {}) })}`,
      ),
    createIdea: ({ name }) =>
      call(TrellisProjectView, "POST", "/v1/ideas", { body: name ? { name } : {} }),
    createProject: ({ name, gitUrl, base }) =>
      call(TrellisProjectView, "POST", "/v1/projects", {
        body: {
          ...(name ? { name } : {}),
          ...(gitUrl ? { git_url: gitUrl } : {}),
          ...(base ? { base } : {}),
        },
        // Creation may clone a repository.
        timeoutMs: 15 * 60_000,
      }),
    describe: ({ target, name, description, source = "user" }) =>
      call(TrellisDescribeView, "POST", "/v1/describe", {
        body: {
          target,
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
          source,
          ...(source === "user" ? { pin: true } : {}),
        },
      }).pipe(Effect.map((view) => ({ ignored: view.ignored ?? view.ignored_pinned ?? [] }))),
    find: (text) => call(Schema.Array(TrellisFindHitView), "GET", `/v1/find?${query({ q: text })}`),
    resolve: (target) => call(TrellisResolved, "GET", `/v1/resolve?${query({ target })}`),
    listActivities: ({ target, kind, limit = 50 }) =>
      call(
        Schema.Array(TrellisActivity),
        "GET",
        `/v1/activities?${query({ target, kind, limit: String(limit) })}`,
      ),
    listSnapshots: (target) =>
      call(Schema.Array(TrellisSnapshot), "GET", `/v1/snapshots?${query({ target })}`),
    createSnapshot: ({ target, thread, turn, pinned }) =>
      call(TrellisSnapshot, "POST", "/v1/snapshots", {
        body: {
          target,
          kind: "turn",
          turn,
          ...(thread === undefined ? {} : { thread }),
          ...(pinned === undefined ? {} : { pinned }),
        },
        // Btrfs snapshots take milliseconds; these run on the shared
        // checkpoint worker, so a hung Trellis must not stall other threads.
        timeoutMs: 15_000,
      }),
    setSnapshotPinned: (id, pinned) =>
      call(TrellisSnapshot, "PATCH", `/v1/snapshots/${encodeURIComponent(id)}`, {
        body: { pinned },
      }),
    trashProject: (id) =>
      call(Schema.Unknown, "DELETE", `/v1/projects/${encodeURIComponent(id)}`).pipe(Effect.asVoid),
    trashWorkspace: (id) =>
      call(Schema.Unknown, "DELETE", `/v1/workspaces/${encodeURIComponent(id)}`).pipe(
        Effect.asVoid,
      ),
    restoreProject: (id) =>
      call(TrellisProjectView, "POST", `/v1/projects/${encodeURIComponent(id)}/restore`),
    restoreWorkspace: (id) =>
      call(Schema.Unknown, "POST", `/v1/workspaces/${encodeURIComponent(id)}/restore`).pipe(
        Effect.asVoid,
      ),
    listTrash: call(TrellisTrashView, "GET", "/v1/trash"),
    emptyTrash: call(TrellisPurgeView, "POST", "/v1/trash/purge", {
      body: { all: true },
      timeoutMs: 5 * 60_000,
    }).pipe(Effect.map((view) => view.purged)),
    rollback: ({ target, snapshot }) =>
      call(TrellisRollbackView, "POST", "/v1/rollback", {
        body: { target, snapshot },
        // Includes a container restart for dedicated workspaces.
        timeoutMs: 60_000,
      }).pipe(
        Effect.map((view) => {
          const undo = view.undo_snapshot;
          const id =
            typeof undo === "string"
              ? undo
              : Predicate.hasProperty(undo, "id") && typeof undo.id === "string"
                ? undo.id
                : null;
          return { undoSnapshot: id };
        }),
      ),
    preview: ({ target, port }) =>
      call(TrellisPreviewView, "POST", "/v1/previews", { body: { target, port } }).pipe(
        Effect.map((view) => ({ hostPort: view.host_port, url: view.url })),
      ),
    listPreviews: (target) =>
      call(Schema.Array(TrellisPreviewView), "GET", `/v1/previews?${query({ target })}`),
    ports: (workspaceId) =>
      call(
        Schema.Array(TrellisPort),
        "GET",
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/ports`,
        { timeoutMs: 5_000 },
      ),
    primer: (target) =>
      call(TrellisPrimerView, "GET", `/v1/primer?${query({ target })}`, { timeoutMs: 5_000 }).pipe(
        Effect.map((view) => view.primer),
      ),
    connects: Effect.sync(() => connects),
    reportTurn: (body) =>
      // A start waits while the workspace is checkpointing (Trellis gives up after 15 min).
      request("POST", "/v1/turns", { body, timeoutMs: TURN_WAIT_MS }).pipe(
        Effect.flatMap((response) =>
          response.status === 409
            ? decodeJson(TrellisGraduatedRefusal, response.body, response.status).pipe(
                Effect.map((refusal) => ({
                  restarted: refusal.details.restarted ?? [],
                  graduatedTo: refusal.details.graduated_to,
                })),
                // Any other conflict (a stale message) is an error as before.
                Effect.catch(() =>
                  decodeJson(TrellisErrorBody, response.body, response.status).pipe(
                    Effect.mapError(() => trellisStatusError("POST", "/v1/turns", 409)),
                    Effect.flatMap((body) =>
                      Effect.fail(new TrellisError({ message: body.error })),
                    ),
                  ),
                ),
              )
            : response.status >= 400
              ? decodeJson(TrellisErrorBody, response.body, response.status).pipe(
                  Effect.mapError(() => trellisStatusError("POST", "/v1/turns", response.status)),
                  Effect.flatMap((body) => Effect.fail(new TrellisError({ message: body.error }))),
                )
              : decodeJson(TrellisTurnsView, response.body, response.status),
        ),
      ),
    replaceTurns: (body) =>
      call(TrellisTurnsView, "PUT", "/v1/turns", { body, timeoutMs: TURN_WAIT_MS }),
    listTurns: (target) =>
      call(Schema.Array(TrellisOpenTurn), "GET", `/v1/turns?${query({ target })}`),
    checkpoint: ({ target, name, thread, interrupt }) =>
      request("POST", "/v1/checkpoint", {
        body: { target, thread, interrupt, ...(name === undefined ? {} : { name }) },
        // Up to five minutes for guarded commands, the graceful stop, the
        // snapshot and the restart.
        timeoutMs: 10 * 60_000,
      }).pipe(
        Effect.flatMap((response): Effect.Effect<TrellisCheckpointOutcome, TrellisError> =>
          response.status >= 400
            ? decodeJson(TrellisCheckpointRefusal, response.body, response.status).pipe(
                Effect.mapError(() =>
                  trellisStatusError("POST", "/v1/checkpoint", response.status),
                ),
                Effect.map((body) => {
                  // A failure after the stop may not say `restarted` (Trellis
                  // restarts the workspace while unwinding); the stop shows.
                  const details = body.details;
                  const stopped = [...(details?.stopped ?? []), ...(details?.late ?? [])];
                  return {
                    ok: false as const,
                    error: body.error,
                    restarted:
                      details?.restarted === true ||
                      details?.snapshot !== undefined ||
                      (details?.ms?.stop ?? 0) > 0 ||
                      stopped.length + (details?.survivors?.length ?? 0) > 0,
                    stopped,
                  };
                }),
              )
            : decodeJson(TrellisCheckpointResult, response.body, response.status).pipe(
                Effect.map((result) => ({ ok: true as const, result })),
              ),
        ),
      ),
    graduate: ({ id, base, name, thread }) =>
      request("POST", `/v1/projects/${encodeURIComponent(id)}/graduate`, {
        body: {
          ...(base === undefined ? {} : { base }),
          ...(name === undefined ? {} : { name }),
          ...(thread === undefined ? {} : { thread }),
        },
        // Copies the idea's folder into a new workspace and computes its record.
        timeoutMs: 15 * 60_000,
      }).pipe(
        Effect.flatMap((response): Effect.Effect<TrellisGraduationOutcome, TrellisError> =>
          response.status >= 400
            ? decodeJson(TrellisGraduationRefusal, response.body, response.status).pipe(
                Effect.mapError(() =>
                  trellisStatusError("POST", "/v1/projects/{id}/graduate", response.status),
                ),
                Effect.map((body) => ({
                  ok: false as const,
                  error: body.error,
                  turns: body.details?.turns ?? [],
                })),
              )
            : decodeJson(TrellisProjectView, response.body, response.status).pipe(
                Effect.map((project) => ({ ok: true as const, project })),
              ),
        ),
      ),
    getProject: (id) => call(TrellisProjectView, "GET", `/v1/projects/${encodeURIComponent(id)}`),
    bases: call(TrellisBasesView, "GET", "/v1/status").pipe(
      Effect.map((view) => ({ bases: view.bases ?? [], defaultBase: view.default_base ?? null })),
    ),
    details: call(TrellisDetailsView, "GET", "/v1/status").pipe(Effect.map(toDetails)),
  });
});

export const layer = Layer.effect(Trellis, make).pipe(Layer.provide(ProcessRunner.layer));

/**
 * True when `cwd` is a Trellis project path, including while Trellis is
 * unreachable, so callers never treat such a path as an ordinary host folder.
 */
const isTrellisPath = Effect.fn("Trellis.isTrellisPath")(function* (
  trellis: Trellis["Service"],
  cwd: string | undefined,
) {
  if (cwd === undefined) return false;
  return trellisRootOf(yield* trellis.expectedRoots, yield* trellis.canonicalPath(cwd)) !== null;
});

/** The root among `roots` that manages `path`, or null for an ordinary host path. */
export function trellisRootOf(roots: ReadonlyArray<string>, path: string): string | null {
  return roots.find((root) => isTrellisManagedPath(root, path)) ?? null;
}

/**
 * The client-facing status. Trellis is asked again on every read (a no-op
 * while the integration is off), so the state follows it going up or down.
 */
export const readTrellisStatus = Effect.fn("Trellis.readStatus")(function* (
  trellis: Trellis["Service"],
) {
  yield* trellis.refresh;
  const connection = yield* trellis.connection;
  return {
    state: connection.state,
    ...(connection.root === null ? {} : { root: connection.root }),
    knownRoots: yield* trellis.expectedRoots,
    socketPath: connection.socketPath,
  } satisfies TrellisStatus;
});

export const TRELLIS_WORKTREE_REFUSAL =
  "Git worktrees are not supported in Trellis projects: they would live outside the workspace and run on the host. Use `trellis fork` for parallel work instead.";

/**
 * Fails with `TRELLIS_WORKTREE_REFUSAL` when `cwd` is a Trellis project path.
 * `trellis` is the optional service captured when the caller was built.
 */
export const refuseWorktreeIn = <E>(
  trellis: Option.Option<Trellis["Service"]>,
  cwd: string,
  makeError: (detail: string) => E,
): Effect.Effect<void, E> =>
  Option.isNone(trellis)
    ? Effect.void
    : isTrellisPath(trellis.value, cwd).pipe(
        Effect.flatMap((managed) =>
          managed ? Effect.fail(makeError(TRELLIS_WORKTREE_REFUSAL)) : Effect.void,
        ),
      );

/**
 * A Trellis service for tests: ready at `env` (or off with `env: null`),
 * with every operation failing loudly unless overridden.
 */
export function makeTestTrellis(
  overrides: Partial<Trellis["Service"]> & { readonly env?: TrellisEnv | null } = {},
): Trellis["Service"] {
  const { env = { root: "/trellis", bin: "trellis", shimDir: "/shims" }, ...rest } = overrides;
  const unused = () => Effect.die(new Error("unused Trellis operation"));
  return Trellis.of({
    current: Effect.succeed(env),
    refresh: Effect.succeed(env),
    discover: Effect.succeed(env),
    canonicalPath: (path) => Effect.succeed(path),
    enabled: Effect.succeed(env !== null),
    connection: Effect.succeed({
      state: env === null ? "disabled" : "ready",
      root: env?.root ?? null,
      socketPath: DEFAULT_TRELLIS_SOCKET,
    }),
    expectedRoots: Effect.succeed(env === null ? [] : [env.root]),
    bin: env?.bin ?? "trellis",
    listWorkspaces: unused,
    fork: unused,
    recordActivity: unused,
    requestPurge: unused,
    purge: unused,
    listProjects: unused,
    createIdea: unused,
    createProject: unused,
    describe: unused,
    find: unused,
    resolve: unused,
    listSnapshots: unused,
    listActivities: unused,
    createSnapshot: unused,
    setSnapshotPinned: unused,
    trashProject: unused,
    trashWorkspace: unused,
    restoreProject: unused,
    restoreWorkspace: unused,
    listTrash: Effect.die(new Error("unused Trellis operation")),
    emptyTrash: Effect.die(new Error("unused Trellis operation")),
    rollback: unused,
    preview: unused,
    listPreviews: unused,
    ports: unused,
    primer: unused,
    connects: Effect.succeed(1),
    reportTurn: () => Effect.succeed({ restarted: [] }),
    replaceTurns: () => Effect.succeed({ restarted: [] }),
    listTurns: () => Effect.succeed([]),
    checkpoint: unused,
    graduate: unused,
    getProject: unused,
    bases: Effect.die(new Error("unused Trellis operation")),
    details: Effect.die(new Error("unused Trellis operation")),
    ...rest,
  });
}
