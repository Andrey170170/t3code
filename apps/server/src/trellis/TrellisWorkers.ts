// @effect-diagnostics nodeBuiltinImport:off
/**
 * TrellisWorkers - delegated workers in Trellis forks.
 *
 * - `spawnFork`: the `workspace: {fork}` option of `delegate_task`. Forks the
 *   caller's dedicated workspace from a checkpoint it names (`latest` or an
 *   id; a spawn never stops the workspace), records the caller's thread as
 *   the fork's `spawned_by`, and returns the fork's T3 project, which the
 *   catalog sync creates, for the child thread. Clients hide such projects
 *   from the sidebar (`workerRoots` in the status).
 * - `discardFork`: the `trellis_discard_fork` tool. Moves a fork of the
 *   caller's project to the trash (refused while its threads work) and can
 *   file a purge request, which only the user confirms.
 * - `start`: follows orchestration events, resuming after the last one it
 *   handled. A worker in another project that completes posts its result as
 *   the fork's `summary` activity (what `trellis merge-brief` shows the
 *   lead), kept in a file until Trellis takes it; archiving or deleting a
 *   thread cancels and archives its workers, transitively. Their forks stay.
 *
 * @module trellis/TrellisWorkers
 */
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpTaskFork,
  type ProjectId,
  ThreadId,
  TrellisDiscardForkMcpFailure,
  type TrellisDiscardForkMcpInput,
  type TrellisDiscardForkMcpResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { forkParked } from "../serverActivation.ts";
import { Trellis, type TrellisWorkspaceView, trellisRootOf } from "./Trellis.ts";
import { TrellisCatalog } from "./TrellisCatalog.ts";

/**
 * A refused fork spawn. `invalid` when the request is the caller's to fix (no
 * checkpoint, an idea, an unknown id), false when Trellis failed.
 */
export class TrellisForkSpawnError extends Schema.TaggedError<TrellisForkSpawnError>()(
  "TrellisForkSpawnError",
  { message: Schema.String, invalid: Schema.Boolean },
) {}

/**
 * An event not fully handled (a summary not queued, a worker not archived):
 * the follower retries it before moving its cursor.
 */
export class TrellisWorkersEventError extends Schema.TaggedError<TrellisWorkersEventError>()(
  "TrellisWorkersEventError",
  { message: Schema.String },
) {}

const isWorkersEventError = Schema.is(TrellisWorkersEventError);

export interface TrellisWorkerFork {
  /** The fork's T3 project, for the child thread. */
  readonly projectId: ProjectId;
  readonly fork: OrchestratorMcpTaskFork;
  /** Orientation prepended to the worker's task. */
  readonly guide: string;
}

export class TrellisWorkers extends Context.Service<
  TrellisWorkers,
  {
    readonly spawnFork: (input: {
      readonly parentThreadId: ThreadId;
      readonly from: string;
      readonly name?: string | undefined;
      readonly services?: "none" | "all" | ReadonlyArray<string> | undefined;
      /**
       * The caller's retry key (its clientRequestId). With one, the fork is
       * named from it and its checkpoint kept, so a retry after a lost
       * response finds that fork instead of forking again.
       */
      readonly requestKey?: string | undefined;
      /** Names a keyed fork when `name` is absent. */
      readonly title?: string | undefined;
    }) => Effect.Effect<TrellisWorkerFork, TrellisForkSpawnError>;
    /** Moves a fork spawned for a child that could not be created to the trash. */
    readonly abandonFork: (workspaceId: string) => Effect.Effect<void>;
    /**
     * The fork a delegated child works in (a retried spawn reports the
     * original one); undefined when it shares its lead's folder.
     */
    readonly forkOf: (
      childThreadId: ThreadId,
    ) => Effect.Effect<TrellisWorkerFork | undefined, TrellisForkSpawnError>;
    readonly discardFork: (
      scope: McpInvocationScope,
      input: TrellisDiscardForkMcpInput,
    ) => Effect.Effect<TrellisDiscardForkMcpResult, TrellisDiscardForkMcpFailure>;
    /** Follows orchestration events for summaries and the archive cascade. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /**
     * Handles one orchestration event as `start` does (tests feed it
     * directly). Fails when it could not finish, to be retried.
     */
    readonly handle: (
      event: OrchestrationV2DomainEvent,
    ) => Effect.Effect<void, TrellisWorkersEventError>;
    /** Posts the summaries Trellis could not take yet; `start` runs it every 30 s. */
    readonly flushSummaries: Effect.Effect<void>;
  }
>()("t3/trellis/TrellisWorkers") {}

/** The newest checkpoint for `latest`, else the one named; null when there is none. */
function pickCheckpoint(
  snapshots: ReadonlyArray<{ readonly id: string; readonly kind: string }>,
  from: string,
): { readonly id: string } | { readonly error: string } {
  const checkpoints = snapshots.filter((snapshot) => snapshot.kind === "checkpoint");
  if (from === "latest") {
    const latest = checkpoints.at(-1);
    return latest !== undefined
      ? { id: latest.id }
      : {
          error:
            'This workspace has no checkpoint yet, and a fork starts from one. Call trellis_checkpoint first (it ends your turn and continues you with the result), then spawn with from: "latest".',
        };
  }
  if (checkpoints.some((snapshot) => snapshot.id === from)) return { id: from };
  const known = checkpoints
    .slice(-5)
    .map((snapshot) => snapshot.id)
    .join(", ");
  return {
    error: `${from} is not a checkpoint of this workspace${known ? ` (newest last: ${known})` : ", which has none yet; call trellis_checkpoint first"}. Use from: "latest" or a checkpoint id.`,
  };
}

/** The threads below `ancestor` (its delegated workers, and theirs). */
function descendantsOf(
  ancestor: ThreadId,
  threads: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "id" | "lineage">>,
): ReadonlyArray<ThreadId> {
  const found = new Set<ThreadId>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const thread of threads) {
      const parent = thread.lineage.parentThreadId;
      if (
        thread.lineage.relationshipToParent === "subagent" &&
        parent !== null &&
        (parent === ancestor || found.has(parent)) &&
        !found.has(thread.id)
      ) {
        found.add(thread.id);
        grew = true;
      }
    }
  }
  return [...found];
}

/** What a worker in a fork is told before its task. */
function workerGuide(input: {
  readonly name: string;
  readonly workspaceId: string;
  readonly snapshot: string;
}): string {
  return [
    `[Trellis worker] You work in your own Trellis fork "${input.name}" (${input.workspaceId}), made from checkpoint ${input.snapshot} of your lead's workspace. Your files are yours alone until the lead merges them.`,
    "Commit your work and put a jj bookmark on it (`jj commit -m MSG && jj bookmark set NAME -r @-`).",
    "Your final message is recorded as the fork's summary, which the lead reads with `trellis merge-brief`: say what you did, the bookmark to fetch, and which environment changes (installed packages, configuration) the lead should carry over.",
  ].join("\n");
}

/**
 * A keyed spawn's fork name: the requested name (or title) as a slug and a
 * short hash of the request, the same on every retry.
 */
function keyedForkName(base: string, thread: string, key: string): string {
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "worker";
  const hash = NodeCrypto.createHash("sha256").update(`${thread}\n${key}`).digest("hex");
  return `${slug}-${hash.slice(0, 6)}`;
}

/** The checkpoint each keyed spawn resolved, by request key. */
const PendingSpawns = Schema.Record(
  Schema.String,
  Schema.Struct({ snapshot: Schema.String, at: Schema.Finite }),
);
type PendingSpawns = typeof PendingSpawns.Type;
const decodeSpawns = Schema.decodeUnknownEffect(Schema.fromJsonString(PendingSpawns));
const encodeSpawns = Schema.encodeEffect(Schema.fromJsonString(PendingSpawns));
/** How long a keyed spawn's checkpoint is remembered for its retries. */
const SPAWN_MEMORY_MS = 2 * 24 * 60 * 60 * 1000;

/** A client-side failure to reach Trellis, as opposed to Trellis's own refusal. */
const isUnreachable = (message: string) =>
  /^(Trellis is unavailable|This Trellis does not support|Trellis answered|Unexpected Trellis response|The Trellis integration is turned off)/.test(
    message,
  );

const normalizeRoot = (root: string) => NodePath.posix.normalize(root).replace(/(.)\/+$/, "$1");

/** How often summaries Trellis could not take are retried, and for how long. */
const SUMMARY_RETRY_INTERVAL = "30 seconds";
const PENDING_SUMMARY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** A worker's result owed to its fork as a `summary` activity. */
const PendingSummary = Schema.Struct({
  /** The task and its completion, against repeated events. */
  key: Schema.String,
  parentThreadId: Schema.String,
  childThreadId: Schema.String,
  text: Schema.String,
  /** Epoch milliseconds when it was queued. */
  at: Schema.Finite,
  /**
   * The fork's folder, resolved when queued, so delivery needs no thread;
   * absent when it could not be resolved then (tried again at each flush).
   */
  target: Schema.optionalKey(Schema.String),
});
type PendingSummary = typeof PendingSummary.Type;
const decodePending = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(PendingSummary)),
);
const encodePending = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(PendingSummary)));

const make = Effect.gen(function* () {
  const trellis = yield* Trellis;
  const catalog = yield* TrellisCatalog;
  const threads = yield* OrchestratorV2;
  const projects = yield* ProjectStoreV2;
  const applicationEvents = yield* OrchestrationEventStore;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  // The sequence of the last event handled, so a restart resumes after it
  // instead of skipping what arrived (or was retrying) while T3 was down.
  const stateDir = (yield* ServerConfig).stateDir;
  const cursorPath = NodePath.join(stateDir, "trellis-workers-cursor");
  const pendingPath = NodePath.join(stateDir, "trellis-pending-summaries.json");
  const spawnsPath = NodePath.join(stateDir, "trellis-pending-spawns.json");
  const spawnsLock = yield* Semaphore.make(1);
  const readSpawns = fileSystem.readFileString(spawnsPath).pipe(
    Effect.flatMap(decodeSpawns),
    // Only retries read it: a missing or unreadable record means resolving again.
    Effect.orElseSucceed((): PendingSpawns => ({})),
  );
  const rememberSpawn = (key: string, snapshot: string) =>
    spawnsLock.withPermits(1)(
      Effect.gen(function* () {
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const kept = Object.fromEntries(
          Object.entries(yield* readSpawns).filter(([, entry]) => now - entry.at < SPAWN_MEMORY_MS),
        );
        const partial = `${spawnsPath}.partial`;
        yield* fileSystem.writeFileString(
          partial,
          yield* encodeSpawns({ ...kept, [key]: { snapshot, at: now } }),
        );
        yield* fileSystem.rename(partial, spawnsPath);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("could not remember a fork spawn's checkpoint", { cause }),
        ),
      ),
    );

  const commandId = (operation: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((id) => CommandId.make(`server:trellis-workers:${operation}:${id}`)),
    );

  const projectRoot = (projectId: ProjectId) =>
    projects.get(projectId).pipe(
      Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot),
      Effect.orElseSucceed(() => undefined),
    );

  /** The canonical Trellis folder a thread works in, or undefined outside Trellis. */
  const folderOf = (thread: Pick<OrchestrationV2ThreadShell, "projectId" | "worktreePath">) =>
    Effect.gen(function* () {
      const folder = thread.worktreePath ?? (yield* projectRoot(thread.projectId));
      if (folder === undefined) return undefined;
      const path = yield* trellis.canonicalPath(folder);
      return trellisRootOf(yield* trellis.expectedRoots, path) === null ? undefined : path;
    });

  const spawnFork: TrellisWorkers["Service"]["spawnFork"] = Effect.fn("TrellisWorkers.spawnFork")(
    function* (input) {
      const invalid = (message: string) => new TrellisForkSpawnError({ message, invalid: true });
      const unavailable = (error: { readonly message: string }) =>
        new TrellisForkSpawnError({
          message: `Trellis could not fork the workspace: ${error.message}`,
          invalid: false,
        });
      if ((yield* trellis.discover) === null) {
        return yield* invalid(
          "Trellis is not available on this server, so the child cannot get a fork.",
        );
      }
      const parent = yield* threads
        .getThreadShell(input.parentThreadId)
        .pipe(Effect.orElseSucceed(() => null));
      const cwd = parent === null || parent === undefined ? undefined : yield* folderOf(parent);
      if (cwd === undefined) {
        return yield* invalid(
          "This thread does not work in a Trellis project, so there is no workspace to fork.",
        );
      }
      const resolved = yield* trellis.resolve(cwd).pipe(Effect.mapError(unavailable));
      if (resolved.workspace.kind !== "dedicated") {
        return yield* invalid(
          "This thread works in an idea, which shares the scratch workspace and has no forks. Delegate without workspace (it runs here), or graduate the idea first.",
        );
      }
      const key = input.requestKey;
      const name =
        key === undefined
          ? input.name
          : keyedForkName(input.name ?? input.title ?? "worker", input.parentThreadId, key);
      if (key !== undefined) {
        // A retry: the fork an earlier attempt created (its response lost) is reused.
        const existing = (yield* trellis
          .listWorkspaces({ all: false, spawnedBy: input.parentThreadId })
          .pipe(Effect.mapError(unavailable))).find(
          (workspace) => workspace.name === name && workspace.deleted_at === null,
        );
        if (existing !== undefined) {
          const ids = yield* catalog.syncNow;
          const projectId = ids.get(normalizeRoot(existing.path));
          if (projectId !== undefined) {
            const snapshot = existing.parent_snapshot ?? "";
            return {
              projectId,
              fork: {
                workspaceId: existing.id,
                name: existing.name,
                path: existing.path,
                snapshot,
                warnings: [],
                services: [],
              },
              guide: workerGuide({ name: existing.name, workspaceId: existing.id, snapshot }),
            } satisfies TrellisWorkerFork;
          }
        }
      }
      // A keyed spawn forks from the checkpoint its first attempt resolved.
      // Keyed by thread too: another thread may reuse the same clientRequestId.
      const spawnKey = key === undefined ? undefined : `${input.parentThreadId}\n${key}`;
      const remembered =
        spawnKey === undefined ? undefined : (yield* readSpawns)[spawnKey]?.snapshot;
      const checkpoint =
        remembered !== undefined
          ? { id: remembered }
          : pickCheckpoint(
              yield* trellis
                .listSnapshots(resolved.workspace.id)
                .pipe(Effect.mapError(unavailable)),
              input.from,
            );
      if ("error" in checkpoint) return yield* invalid(checkpoint.error);
      if (spawnKey !== undefined && remembered === undefined) {
        yield* rememberSpawn(spawnKey, checkpoint.id);
      }
      const fork = yield* trellis
        .fork({
          target: resolved.workspace.id,
          snapshot: checkpoint.id,
          name,
          thread: input.parentThreadId,
          services: input.services,
        })
        .pipe(
          Effect.mapError((error) =>
            // Trellis's own refusals (an unknown service, say) are the caller's to fix.
            isUnreachable(error.message)
              ? unavailable(error)
              : invalid(`Trellis refused the fork: ${error.message}`),
          ),
        );
      const ids = yield* catalog.syncNow;
      const projectId = ids.get(normalizeRoot(fork.path));
      if (projectId === undefined) {
        yield* abandonFork(fork.id);
        return yield* new TrellisForkSpawnError({
          message: `Trellis forked ${fork.id}, but its T3 project could not be created, so the fork was moved to the trash.`,
          invalid: false,
        });
      }
      return {
        projectId,
        fork: {
          workspaceId: fork.id,
          name: fork.name,
          path: fork.path,
          snapshot: checkpoint.id,
          warnings: fork.warnings ?? [],
          services: (fork.services ?? []).map((service) => ({
            name: service.name,
            state: service.state,
            ...(service.error === undefined ? {} : { error: service.error }),
            previews: service.previews ?? [],
          })),
        },
        guide: workerGuide({
          name: fork.name,
          workspaceId: fork.id,
          snapshot: checkpoint.id,
        }),
      } satisfies TrellisWorkerFork;
    },
  );

  const abandonFork = (workspaceId: string) =>
    trellis.trashWorkspace(workspaceId).pipe(
      Effect.andThen(catalog.syncNow),
      Effect.catchCause((cause) =>
        Effect.logWarning("could not trash a fork spawned for a child that was not created", {
          workspaceId,
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.asVoid,
    );

  const forkOf: TrellisWorkers["Service"]["forkOf"] = Effect.fn("TrellisWorkers.forkOf")(
    function* (childThreadId) {
      const child = yield* threads
        .getThreadShell(childThreadId)
        .pipe(Effect.orElseSucceed(() => null));
      const root = child == null ? undefined : yield* projectRoot(child.projectId);
      if (child == null || root === undefined) return undefined;
      const workspaces = yield* trellis.listWorkspaces({ all: true }).pipe(
        Effect.mapError(
          (error) =>
            new TrellisForkSpawnError({
              message: `Trellis could not list the workspaces: ${error.message}`,
              invalid: false,
            }),
        ),
      );
      const fork = workspaces.find(
        (workspace) =>
          normalizeRoot(workspace.path) === normalizeRoot(root) && workspace.spawned_by != null,
      );
      if (fork === undefined) return undefined;
      return {
        projectId: child.projectId,
        fork: {
          workspaceId: fork.id,
          name: fork.name,
          path: fork.path,
          snapshot: fork.parent_snapshot ?? "",
          warnings: [],
          services: [],
        },
        guide: "",
      } satisfies TrellisWorkerFork;
    },
  );

  const discardFork: TrellisWorkers["Service"]["discardFork"] = Effect.fn(
    "TrellisWorkers.discardFork",
  )(function* (callScope, input) {
    const failure = (code: TrellisDiscardForkMcpFailure["code"], message: string) =>
      new TrellisDiscardForkMcpFailure({ code, message });
    const unavailable = (error: { readonly message: string }) =>
      failure("trellis_unavailable", `Trellis could not be asked: ${error.message}`);
    if (!callScope.capabilities.has("orchestration")) {
      return yield* failure("capability_denied", "This credential cannot control threads.");
    }
    if ((yield* trellis.discover) === null) {
      return yield* failure("not_a_trellis_workspace", "Trellis is not available on this server.");
    }
    const caller = yield* threads
      .getThreadShell(callScope.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (caller === null || caller === undefined || caller.deletedAt !== null) {
      return yield* failure("thread_not_found", "The calling thread was not found.");
    }
    const cwd = yield* folderOf(caller);
    if (cwd === undefined) {
      return yield* failure(
        "not_a_trellis_workspace",
        "This thread does not work in a Trellis project, so it has no forks.",
      );
    }
    const resolved = yield* trellis.resolve(cwd).pipe(Effect.mapError(unavailable));
    const project = resolved.project;
    if (project === null || project.kind === "idea") {
      return yield* failure(
        "not_a_trellis_workspace",
        "This thread works in an idea, which has no forks.",
      );
    }
    const workspaces = yield* trellis
      .listWorkspaces({ all: true })
      .pipe(Effect.mapError(unavailable));
    const ofProject = workspaces.filter((workspace) => workspace.project_id === project.id);
    // An exact id first; else a name, where a live fork wins over trashed ones.
    const named = ofProject.filter((workspace) => workspace.name === input.fork);
    const fork: TrellisWorkspaceView | undefined =
      ofProject.find((workspace) => workspace.id === input.fork) ??
      named.find((workspace) => workspace.deleted_at === null) ??
      named.at(-1);
    if (fork === undefined) {
      const names = ofProject
        .filter((workspace) => workspace.id !== project.workspace_id)
        .map((workspace) => `${workspace.name} (${workspace.id})`)
        .join(", ");
      return yield* failure(
        "fork_not_found",
        `No fork "${input.fork}" in this project${names ? `; its forks: ${names}` : ""}.`,
      );
    }
    if (fork.id === project.workspace_id) {
      return yield* failure(
        "fork_not_found",
        `${fork.name} is the project's own workspace, not a fork.`,
      );
    }
    if (fork.id === resolved.workspace.id) {
      return yield* failure(
        "fork_not_found",
        `${fork.name} is the workspace this thread works in; a lead discards it.`,
      );
    }
    // Only forks this thread or its own workers spawned; others belong to other leads or the user.
    const spawner = fork.spawned_by?.thread ?? null;
    const shellForOwner = yield* threads
      .getShellSnapshot()
      .pipe(Effect.mapError((error) => failure("operation_failed", error.message)));
    const own = new Set<string>([
      caller.id,
      ...descendantsOf(caller.id, [...shellForOwner.threads, ...shellForOwner.archivedThreads]),
    ]);
    if (spawner === null || !own.has(spawner)) {
      return yield* failure(
        "fork_not_owned",
        `${fork.name} (${fork.id}) was not spawned by this thread or its workers${spawner === null ? " (the user made it)" : ""}, so it is not yours to discard. Ask the user.`,
      );
    }
    let discarded = false;
    if (fork.deleted_at === null) {
      // Refused while a thread there works; Trellis would stop it mid-turn.
      const ids = yield* catalog.syncNow;
      const forkProject = ids.get(normalizeRoot(fork.path));
      const shell = yield* threads
        .getShellSnapshot({ location: "active" })
        .pipe(Effect.mapError((error) => failure("operation_failed", error.message)));
      const busy = shell.threads.filter(
        (thread) =>
          forkProject !== undefined &&
          thread.projectId === forkProject &&
          (thread.activeRunId !== null || thread.activityRunStatus != null),
      );
      if (busy.length > 0) {
        const one = busy.length === 1;
        return yield* failure(
          "threads_running",
          `${busy.map((thread) => `"${thread.title}"`).join(", ")} ${one ? "is" : "are"} still working in ${fork.name}. Wait for ${one ? "it" : "them"} to finish (or cancel the task with task_cancel), then discard it.`,
        );
      }
      discarded = yield* catalog
        .discardFork(fork.id)
        .pipe(Effect.mapError((error) => failure("operation_failed", error.message)));
    }
    if (input.requestPurge === true) {
      yield* trellis
        .requestPurge({ ids: [fork.id], reason: input.reason, thread: callScope.threadId })
        .pipe(Effect.mapError((error) => failure("operation_failed", error.message)));
    }
    const trash = yield* trellis.listTrash.pipe(Effect.mapError(unavailable));
    const entry = trash.workspaces.find((candidate) => candidate.id === fork.id);
    return {
      workspaceId: fork.id,
      name: fork.name,
      discarded,
      unmerged: entry?.unmerged ?? null,
      unmergedReason: entry?.unmerged_reason ?? null,
      expiresAt: entry?.expires_at ?? null,
      purgeRequested: entry?.purge_requested != null,
    } satisfies TrellisDiscardForkMcpResult;
  });

  // Summaries not yet in Trellis, kept in a file until written, so neither a
  // Trellis outage nor a T3 restart loses one (the merge brief needs it).
  const pendingLock = yield* Semaphore.make(1);
  // Keys written in this run, against an event handled again (a resubscription).
  const posted = new Set<string>();
  const markPosted = (key: string) => {
    posted.add(key);
    if (posted.size > 2_000) posted.delete(posted.values().next().value!);
  };
  // Empty only when there is no file: an unreadable one fails, so nothing overwrites it.
  const readPending = Effect.gen(function* () {
    if (!(yield* fileSystem.exists(pendingPath))) return [] as ReadonlyArray<PendingSummary>;
    return yield* decodePending(yield* fileSystem.readFileString(pendingPath));
  });
  const writePending = (entries: ReadonlyArray<PendingSummary>) =>
    Effect.gen(function* () {
      const partial = `${pendingPath}.partial`;
      yield* fileSystem.writeFileString(partial, yield* encodePending(entries));
      yield* fileSystem.rename(partial, pendingPath);
    });

  /** Writes one summary to its worker's fork; true once written or not owed. */
  /**
   * Where a worker's summary goes: its fork's folder, `none` for a worker
   * sharing its lead's folder (nothing owed), `unknown` while its threads
   * cannot be read.
   */
  const summaryTarget = (parentThreadId: string, childThreadId: string) =>
    Effect.gen(function* () {
      const [parent, child] = yield* Effect.all([
        threads.getThreadShell(ThreadId.make(parentThreadId)),
        threads.getThreadShell(ThreadId.make(childThreadId)),
      ]);
      if (parent == null || child == null) return "unknown" as const;
      if (parent.projectId === child.projectId) return "none" as const;
      return (yield* folderOf(child)) ?? ("unknown" as const);
    }).pipe(Effect.catchCause(() => Effect.succeed("unknown" as const)));

  /** Writes one summary to its worker's fork; true once written or not owed. */
  const writeSummary = (entry: PendingSummary) =>
    Effect.gen(function* () {
      const target =
        entry.target ?? (yield* summaryTarget(entry.parentThreadId, entry.childThreadId));
      if (target === "none") return true;
      // Kept until its fork is known (or it ages out); never dropped for a missing thread.
      if (target === "unknown") return false;
      yield* trellis.recordActivity({
        target,
        kind: "summary",
        data: { text: entry.text, thread: entry.childThreadId },
      });
      return true;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not post a worker's summary to its Trellis fork; will retry", {
          childThreadId: entry.childThreadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    );

  /** Writes the pending summaries Trellis takes; keeps the others (up to a week). */
  const flushSummaries = pendingLock.withPermits(1)(
    Effect.gen(function* () {
      const pending = yield* readPending;
      if (pending.length === 0) return;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const kept: Array<PendingSummary> = [];
      for (const entry of pending) {
        if (yield* writeSummary(entry)) {
          markPosted(entry.key);
          continue;
        }
        if (now - entry.at < PENDING_SUMMARY_MAX_AGE_MS) kept.push(entry);
        else yield* Effect.logWarning("dropped a worker summary Trellis never took", entry);
      }
      if (kept.length !== pending.length) yield* writePending(kept);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not post the pending worker summaries", {
          cause: Cause.pretty(cause),
        }),
      ),
    ),
  );

  const queueSummary = (entry: PendingSummary) =>
    Effect.gen(function* () {
      const target = yield* summaryTarget(entry.parentThreadId, entry.childThreadId);
      if (target === "none") return;
      yield* pendingLock.withPermits(1)(
        Effect.gen(function* () {
          const pending = yield* readPending;
          if (posted.has(entry.key) || pending.some((candidate) => candidate.key === entry.key)) {
            return;
          }
          yield* writePending([...pending, target === "unknown" ? entry : { ...entry, target }]);
        }),
      );
    });

  /**
   * Cancels and archives the workers below a thread archived (or deleted) at `archivedAt`;
   * their forks stay. A replayed event acts only while the lead is still
   * archived, and only on workers that existed then. Fails (so the follower
   * retries the event) when a worker could not be archived.
   */
  const archiveWorkers = (leadId: ThreadId, archivedAt: DateTime.Utc, deleted = false) =>
    Effect.gen(function* () {
      if (!(yield* trellis.enabled)) return;
      // Lineage through archived workers too; only active ones are stopped.
      const shell = yield* threads.getShellSnapshot();
      const all = [...shell.threads, ...shell.archivedThreads];
      // A deleted lead is gone for good (and from the snapshot); an archived one may be reopened.
      if (!deleted && all.find((thread) => thread.id === leadId)?.archivedAt == null) return;
      const workers = new Set(descendantsOf(leadId, all));
      const failed: Array<ThreadId> = [];
      for (const worker of shell.threads) {
        if (!workers.has(worker.id) || worker.archivedAt !== null) continue;
        if (DateTime.toEpochMillis(worker.createdAt) > DateTime.toEpochMillis(archivedAt)) continue;
        if (worker.activeRunId !== null) {
          yield* threads
            .dispatch({
              type: "run.interrupt",
              commandId: yield* commandId("cancel"),
              threadId: worker.id,
              runId: worker.activeRunId,
              reason: "Its lead was archived.",
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("could not cancel a worker of an archived lead", {
                  threadId: worker.id,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
        }
        yield* threads
          .dispatch({
            type: "thread.archive",
            commandId: yield* commandId("archive"),
            threadId: worker.id,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("could not archive a worker of an archived lead", {
                threadId: worker.id,
                cause: Cause.pretty(cause),
              }).pipe(Effect.andThen(Effect.sync(() => void failed.push(worker.id)))),
            ),
          );
      }
      if (failed.length > 0) {
        return yield* new TrellisWorkersEventError({
          message: `could not archive the workers ${failed.join(", ")} of ${leadId}`,
        });
      }
    }).pipe(
      Effect.mapError((error) =>
        isWorkersEventError(error)
          ? error
          : new TrellisWorkersEventError({ message: String(error) }),
      ),
    );

  const handle: TrellisWorkers["Service"]["handle"] = (event) => {
    if (event.type === "thread.archived") {
      return archiveWorkers(event.threadId, event.payload.archivedAt ?? event.occurredAt);
    }
    if (event.type === "thread.deleted") {
      return archiveWorkers(event.threadId, event.payload.deletedAt ?? event.occurredAt, true);
    }
    if (event.type !== "subagent.updated") return Effect.void;
    const task = event.payload;
    if (
      task.origin !== "app_owned" ||
      task.status !== "completed" ||
      task.childThreadId === null ||
      task.result === null ||
      task.result.trim() === ""
    ) {
      return Effect.void;
    }
    const childThreadId = task.childThreadId;
    const text = task.result;
    return Effect.gen(function* () {
      yield* queueSummary({
        key: `${task.id}:${task.completedAt === null ? "" : DateTime.toEpochMillis(task.completedAt)}`,
        parentThreadId: task.threadId,
        childThreadId,
        text,
        at: DateTime.toEpochMillis(yield* DateTime.now),
      });
      yield* flushSummaries;
    }).pipe(
      // Not queued: the follower retries the event before moving its cursor.
      Effect.mapError((error) => new TrellisWorkersEventError({ message: String(error) })),
      Effect.tapCause((cause) =>
        Effect.logWarning("could not queue a worker's summary", {
          childThreadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  };

  /** Whether `handle` acts on the event; only those move the cursor. */
  const relevant = (event: OrchestrationV2DomainEvent) =>
    event.type === "thread.archived" ||
    event.type === "thread.deleted" ||
    (event.type === "subagent.updated" && event.payload.status === "completed");

  const previousCursorPath = `${cursorPath}.previous`;
  /**
   * Written whole (a temporary file renamed over it); the cursor it replaces
   * stays as `.previous`, the fallback should this one ever be unreadable.
   */
  const saveCursor = (sequence: number) =>
    Effect.gen(function* () {
      const partial = `${cursorPath}.partial`;
      yield* fileSystem.writeFileString(partial, `${sequence}\n`);
      if (yield* fileSystem.exists(cursorPath)) {
        yield* fileSystem.rename(cursorPath, previousCursorPath);
      }
      yield* fileSystem.rename(partial, cursorPath);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not save the Trellis workers' event cursor", { cause }),
      ),
    );

  /** A saved cursor: the sequence, `missing` when there is no file, else `invalid`. */
  const readCursor = (path: string) =>
    Effect.gen(function* () {
      if (!(yield* fileSystem.exists(path))) return "missing" as const;
      const text = (yield* fileSystem.readFileString(path)).trim();
      return /^\d+$/.test(text) && Number.isSafeInteger(Number(text))
        ? Number(text)
        : ("invalid" as const);
    }).pipe(Effect.orElseSucceed(() => "invalid" as const));

  const start: TrellisWorkers["Service"]["start"] = Effect.fn("TrellisWorkers.start")(function* () {
    const latest = yield* applicationEvents.latestApplicationSequence.pipe(
      Effect.orElseSucceed(() => 0),
    );
    // The first start (no cursor) begins now, saved at once so a restart
    // replays from here; later ones resume after the last event handled. An
    // unreadable cursor falls back to the one before it, else to the start of
    // the retained events: handling an event twice is harmless, missing one is not.
    const saved = yield* readCursor(cursorPath);
    const fallback = saved === "invalid" ? yield* readCursor(previousCursorPath) : saved;
    let cursor =
      saved === "missing" ? latest : typeof fallback === "number" ? Math.min(fallback, latest) : 0;
    if (saved !== "missing" && typeof saved !== "number") {
      yield* Effect.logWarning("the Trellis workers' event cursor was unreadable; replaying", {
        from: cursor,
      });
    }
    if (cursor !== saved) yield* saveCursor(cursor);
    let failures = 0;
    const follow = Effect.suspend(() =>
      applicationEvents.streamApplicationEvents({ afterSequence: cursor }).pipe(
        Stream.runForEach((stored) =>
          Effect.gen(function* () {
            failures = 0;
            if ("aggregateKind" in stored || !relevant(stored.event)) return;
            yield* handle(stored.event);
            cursor = stored.sequence;
            yield* saveCursor(cursor);
          }),
        ),
      ),
    ).pipe(
      // A dropped subscription resumes after the last event handled; one that
      // keeps failing (events no longer retained) skips to now.
      Effect.tapCause((cause) =>
        Effect.gen(function* () {
          failures += 1;
          yield* Effect.logWarning("Trellis workers lost the orchestration event stream", {
            cause: Cause.pretty(cause),
          });
          if (failures >= 5) {
            cursor = yield* applicationEvents.latestApplicationSequence.pipe(
              Effect.orElseSucceed(() => cursor),
            );
            failures = 0;
          }
        }),
      ),
      Effect.retry({ schedule: Schedule.spaced("5 seconds") }),
    );
    yield* forkParked(follow);
    // Summaries Trellis could not take yet.
    yield* forkParked(
      flushSummaries.pipe(Effect.repeat(Schedule.spaced(SUMMARY_RETRY_INTERVAL)), Effect.asVoid),
    );
  });

  return TrellisWorkers.of({
    spawnFork,
    abandonFork,
    forkOf,
    discardFork,
    start,
    handle,
    flushSummaries,
  });
});

export const layer = Layer.effect(TrellisWorkers, make);
