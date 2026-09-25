// @effect-diagnostics nodeBuiltinImport:off
/**
 * TrellisCatalog - keeps one T3 project per Trellis workspace path and serves
 * the client-facing Trellis operations.
 *
 * Trellis is the source of truth for names. The sync polls the Trellis
 * catalog, creates missing T3 projects (matched by `workspaceRoot`, so it never
 * duplicates), renames them to the Trellis name, and retires projects whose
 * Trellis item was trashed or graduated. A user rename in T3 is pushed to
 * Trellis (which pins the name) instead of being overwritten. Nothing runs
 * while the integration is off.
 *
 * New ideas are created lazily: a new-idea draft belongs to the hidden landing
 * pad project (`TRELLIS_LANDING_PAD_PROJECT_ID`), and its first send creates
 * the idea and moves the thread into the idea's project (see ws.ts).
 *
 * @module trellis/TrellisCatalog
 */
import * as NodePath from "node:path";

import {
  CommandId,
  ProjectId,
  type ThreadId,
  TRELLIS_LANDING_PAD_PROJECT_ID,
  TrellisError,
  type TrellisCreateResult,
  type TrellisFindHit,
  type TrellisFindResult,
  type TrellisIdeaDraftTarget,
  type TrellisRestoreInput,
  type TrellisRestoreResult,
  type TrellisStatus,
  type TrellisTrashItem,
  type TrellisTrashProjectResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { forkParked } from "../serverActivation.ts";
import {
  isTrellisManagedPath,
  Trellis,
  type TrellisFindHitView,
  TrellisProjectView,
  type TrellisTrashView,
} from "./Trellis.ts";
import { pathsOverlap } from "./TrellisCheckpoints.ts";

const POLL_INTERVAL = "3 seconds";
const encodeListing = Schema.encodeSync(Schema.fromJsonString(Schema.Array(TrellisProjectView)));
const SYNC_COMMAND_PREFIX = "server:trellis-sync:";

export interface CatalogProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

interface CatalogThreadTitle {
  readonly id: ThreadId;
  readonly title: string;
}

export interface CatalogThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly archived: boolean;
  /** ISO time of the last change, including an unarchive. */
  readonly updatedAt: string;
}

export type CatalogSyncAction =
  | { readonly type: "create"; readonly workspaceRoot: string; readonly title: string }
  | { readonly type: "rename"; readonly projectId: ProjectId; readonly title: string }
  | {
      readonly type: "retire";
      readonly projectId: ProjectId;
      /** Active threads to archive; archiving is reversible and keeps them. */
      readonly archiveThreadIds: ReadonlyArray<ThreadId>;
      /** Only a project without any threads is deleted. */
      readonly deleteProject: boolean;
    };

export interface DesiredProject {
  readonly workspaceRoot: string;
  readonly title: string;
  /** False for fork workspaces, whose title is derived from the project name. */
  readonly primary: boolean;
}

const normalizeRoot = (root: string) => NodePath.posix.normalize(root).replace(/(.)\/+$/, "$1");

const isLive = (item: TrellisProjectView) => item.deleted_at === null && item.graduated_to === null;

const titleOf = (name: string, path: string) =>
  name.trim() || NodePath.posix.basename(path) || "Trellis project";

/** One T3 project per live Trellis idea and per workspace of a live dedicated project. */
export function desiredProjects(
  items: ReadonlyArray<TrellisProjectView>,
): ReadonlyArray<DesiredProject> {
  const desired: Array<DesiredProject> = [];
  for (const item of items) {
    if (!isLive(item)) continue;
    const name = titleOf(item.name, item.path);
    if (item.kind === "idea" || item.workspaces.length === 0) {
      desired.push({ workspaceRoot: normalizeRoot(item.path), title: name, primary: true });
      continue;
    }
    for (const workspace of item.workspaces) {
      const primary = workspace.id === item.workspace_id;
      desired.push({
        workspaceRoot: normalizeRoot(workspace.path),
        title: primary ? name : `${name} · ${workspace.name.trim() || workspace.id}`,
        primary,
      });
    }
  }
  return desired;
}

/** `<ws>` when `root` is exactly `<trellis root>/workspaces/<ws>/project`. */
function workspaceIdOfRoot(trellisRoot: string, root: string): string | null {
  const relative = NodePath.posix
    .relative(NodePath.posix.join(trellisRoot, "workspaces"), root)
    .split("/");
  return relative.length === 2 && relative[1] === "project" && relative[0] ? relative[0] : null;
}

/**
 * Workspaces that T3 projects point at but the live listing does not
 * mention. Only these need a (costlier) workspace listing to learn whether
 * they were deleted.
 */
export function unlistedWorkspaceIds(input: {
  readonly root: string;
  readonly items: ReadonlyArray<TrellisProjectView>;
  readonly projects: ReadonlyArray<CatalogProject>;
}): ReadonlyArray<string> {
  const listed = new Set<string>();
  for (const item of input.items) {
    if (!isLive(item)) continue;
    listed.add(item.workspace_id);
    for (const workspace of item.workspaces) listed.add(workspace.id);
  }
  const unlisted = new Set<string>();
  for (const project of input.projects) {
    const id = workspaceIdOfRoot(input.root, normalizeRoot(project.workspaceRoot));
    if (id !== null && !listed.has(id)) unlisted.add(id);
  }
  return [...unlisted];
}

/**
 * Commands that bring the T3 projects in line with the Trellis catalog.
 * `items` must include trashed and graduated items (`?all=true`). Projects
 * outside Trellis project paths are never touched.
 */
export function planCatalogSync(input: {
  readonly root: string;
  readonly items: ReadonlyArray<TrellisProjectView>;
  readonly projects: ReadonlyArray<CatalogProject>;
  readonly threads: ReadonlyArray<CatalogThread>;
  /**
   * Workspaces Trellis reports as deleted, with their deletion time in Unix
   * seconds; see `unlistedWorkspaceIds`.
   */
  readonly deletedWorkspaces: ReadonlyMap<string, number>;
}): ReadonlyArray<CatalogSyncAction> {
  const actions: Array<CatalogSyncAction> = [];
  const projectsByRoot = new Map<string, CatalogProject>();
  for (const project of input.projects) {
    const root = normalizeRoot(project.workspaceRoot);
    if (!projectsByRoot.has(root)) projectsByRoot.set(root, project);
  }

  const desired = desiredProjects(input.items);
  const desiredRoots = new Set(desired.map((entry) => entry.workspaceRoot));
  for (const entry of desired) {
    const existing = projectsByRoot.get(entry.workspaceRoot);
    if (!existing) {
      actions.push({ type: "create", workspaceRoot: entry.workspaceRoot, title: entry.title });
    } else if (existing.title !== entry.title) {
      actions.push({ type: "rename", projectId: existing.id, title: entry.title });
    }
  }

  // Retire only on a positive signal: the path of a trashed or graduated
  // item, or the root of a workspace Trellis reports as deleted (a trashed
  // fork). Absence from the listing is never enough. The value is when it
  // happened, in Unix seconds (graduation records it as the update time).
  const retiredAt = new Map<string, number>();
  for (const item of input.items) {
    if (!isLive(item)) retiredAt.set(normalizeRoot(item.path), item.deleted_at ?? item.updated_at);
  }
  for (const [root, project] of projectsByRoot) {
    if (desiredRoots.has(root) || !isTrellisManagedPath(input.root, root)) continue;
    const workspaceId = workspaceIdOfRoot(input.root, root);
    const at =
      retiredAt.get(root) ??
      (workspaceId === null ? undefined : input.deletedWorkspaces.get(workspaceId));
    if (at === undefined) continue;
    const threads = input.threads.filter((thread) => thread.projectId === project.id);
    // Only threads untouched since the retirement: one the user unarchived
    // (or kept working in) afterwards stays where it is.
    const archiveThreadIds = threads
      .filter((thread) => !thread.archived && Date.parse(thread.updatedAt) < at * 1000)
      .map((thread) => thread.id);
    if (archiveThreadIds.length === 0 && threads.length > 0) continue;
    actions.push({
      type: "retire",
      projectId: project.id,
      archiveThreadIds,
      deleteProject: threads.length === 0,
    });
  }
  return actions;
}

/** `<ws>` when `path` is `<trellis root>/workspaces/<ws>/project` or below it. */
function workspaceIdOfPath(trellisRoot: string, path: string): string | null {
  const relative = NodePath.posix
    .relative(NodePath.posix.join(trellisRoot, "workspaces"), NodePath.posix.normalize(path))
    .split("/");
  return relative.length >= 2 && relative[1] === "project" && relative[0] && relative[0] !== ".."
    ? relative[0]
    : null;
}

/** What deleting the T3 project at `workspaceRoot` moves to the Trellis trash, if anything. */
export function trashTargetOf(
  items: ReadonlyArray<TrellisProjectView>,
  workspaceRoot: string,
):
  | { readonly kind: "project"; readonly id: string; readonly name: string }
  | { readonly kind: "workspace"; readonly id: string; readonly name: string }
  | null {
  const root = normalizeRoot(workspaceRoot);
  for (const item of items) {
    if (!isLive(item)) continue;
    const name = titleOf(item.name, item.path);
    if (item.kind === "idea" || item.workspaces.length === 0) {
      if (normalizeRoot(item.path) === root) return { kind: "project", id: item.id, name };
      continue;
    }
    const workspace = item.workspaces.find((entry) => normalizeRoot(entry.path) === root);
    if (workspace === undefined) continue;
    // The primary workspace stands for the whole project, forks for themselves.
    return workspace.id === item.workspace_id
      ? { kind: "project", id: item.id, name }
      : {
          kind: "workspace",
          id: workspace.id,
          name: `${name} · ${workspace.name.trim() || workspace.id}`,
        };
  }
  return null;
}

/**
 * Splits find hits per workspace: Trellis groups a project's matches, but a
 * match in a fork must open that fork's T3 project, not the primary one.
 * Returns one entry per T3 project root, in hit order.
 */
export function splitFindHits(
  trellisRoot: string,
  hits: ReadonlyArray<TrellisFindHitView>,
): ReadonlyArray<{
  readonly item: TrellisProjectView;
  readonly workspaceRoot: string;
  readonly title: string;
  readonly matches: TrellisFindHitView["matches"];
}> {
  const entries = [];
  for (const hit of hits) {
    const item = hit.project;
    const primaryRoot = normalizeRoot(item.path);
    const name = titleOf(item.name, item.path);
    if (item.kind === "idea" || item.workspaces.length === 0) {
      entries.push({ item, workspaceRoot: primaryRoot, title: name, matches: hit.matches });
      continue;
    }
    const byRoot = new Map<string, Array<TrellisFindHitView["matches"][number]>>();
    for (const match of hit.matches) {
      const workspaceId = workspaceIdOfPath(trellisRoot, match.path);
      const workspace = item.workspaces.find((entry) => entry.id === workspaceId);
      const root = workspace ? normalizeRoot(workspace.path) : primaryRoot;
      byRoot.set(root, [...(byRoot.get(root) ?? []), match]);
    }
    // A match on the name or description alone opens the primary workspace.
    if (byRoot.size === 0) byRoot.set(primaryRoot, []);
    for (const [root, matches] of byRoot) {
      const workspace = item.workspaces.find((entry) => normalizeRoot(entry.path) === root);
      const primary = workspace === undefined || workspace.id === item.workspace_id;
      entries.push({
        item,
        workspaceRoot: root,
        title: primary ? name : `${name} · ${workspace.name.trim() || workspace.id}`,
        matches,
      });
    }
  }
  return entries;
}

/**
 * Trash entries for the settings page. A fork trashed together with (or
 * after) its project comes back with it, so only the project is listed. The
 * expiry is what Trellis reports per item; Trellis versions without it purge
 * every kind after `purge_after_days`.
 */
export function trashItems(view: TrellisTrashView): ReadonlyArray<TrellisTrashItem> {
  const expiryOf = (entry: TrellisTrashView["projects"][number], deletedAt: number) =>
    entry.expires_at !== undefined
      ? entry.expires_at
      : view.idea_expiry_days !== undefined
        ? entry.kind === "idea"
          ? deletedAt + view.idea_expiry_days * 86_400
          : null
        : deletedAt + (view.purge_after_days ?? 30) * 86_400;
  const projectDeletedAt = new Map<string, number>();
  const items: Array<TrellisTrashItem> = [];
  for (const entry of view.projects) {
    if (entry.deleted_at === null) continue;
    projectDeletedAt.set(entry.id, entry.deleted_at);
    items.push({
      kind: entry.kind === "idea" ? "idea" : "project",
      id: entry.id,
      name: entry.name.trim() || entry.id,
      deletedAt: entry.deleted_at,
      expiresAt: expiryOf(entry, entry.deleted_at),
    });
  }
  for (const entry of view.workspaces) {
    if (entry.deleted_at === null || entry.kind === "scratch") continue;
    const projectAt = entry.project_id == null ? undefined : projectDeletedAt.get(entry.project_id);
    if (projectAt !== undefined && entry.deleted_at >= projectAt) continue;
    items.push({
      kind: "workspace",
      id: entry.id,
      name: entry.name.trim() || entry.id,
      deletedAt: entry.deleted_at,
      expiresAt: expiryOf(entry, entry.deleted_at),
    });
  }
  return items.toSorted((left, right) => right.deletedAt - left.deletedAt);
}

export class TrellisCatalog extends Context.Service<
  TrellisCatalog,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Runs one sync pass and returns the T3 project id for each synced workspace root. */
    readonly syncNow: Effect.Effect<ReadonlyMap<string, ProjectId>>;
    /** Probes Trellis first when the integration is on but not yet reachable. */
    readonly status: Effect.Effect<TrellisStatus>;
    readonly newIdea: (input: {
      readonly name?: string | undefined;
    }) => Effect.Effect<TrellisCreateResult, TrellisError>;
    /** Ensures the landing pad project that new-idea drafts belong to. Creates no idea. */
    readonly prepareIdeaDraft: Effect.Effect<TrellisIdeaDraftTarget, TrellisError>;
    /** Moves the Trellis item behind a T3 project to the trash; the sync then retires it. */
    readonly trashProject: (
      projectId: ProjectId,
    ) => Effect.Effect<TrellisTrashProjectResult, TrellisError>;
    readonly listTrash: Effect.Effect<ReadonlyArray<TrellisTrashItem>, TrellisError>;
    readonly restore: (
      input: TrellisRestoreInput,
    ) => Effect.Effect<TrellisRestoreResult, TrellisError>;
    readonly emptyTrash: Effect.Effect<number, TrellisError>;
    readonly newProject: (input: {
      readonly name?: string | undefined;
      readonly gitUrl?: string | undefined;
      readonly base?: string | undefined;
    }) => Effect.Effect<TrellisCreateResult, TrellisError>;
    readonly find: (query: string) => Effect.Effect<TrellisFindResult, TrellisError>;
  }
>()("t3/trellis/TrellisCatalog") {}

const make = Effect.gen(function* () {
  const trellis = yield* Trellis;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  // An empty directory owned by T3, outside every Trellis path, so nothing
  // treats the landing pad as a workspace. No thread is ever created there.
  const landingPadRoot = NodePath.join(serverConfig.stateDir, "trellis-landing-pad");
  const landingPadLock = yield* Semaphore.make(1);
  const providerService = yield* Effect.serviceOption(ProviderService);

  // Titles of threads whose provider is running (or starting) a turn inside
  // or above one of `paths`.
  const activeThreadTitlesIn = (paths: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (Option.isNone(providerService) || paths.length === 0) return [];
      const sessions = yield* providerService.value.listSessions();
      const ids = sessions
        .filter(
          (session) =>
            (session.status === "running" ||
              session.status === "connecting" ||
              session.activeTurnId !== undefined) &&
            session.cwd !== undefined &&
            paths.some((path) => pathsOverlap(normalizeRoot(path), normalizeRoot(session.cwd!))),
        )
        .map((session) => session.threadId);
      if (ids.length === 0) return [];
      const shell = yield* snapshots
        .getShellSnapshot()
        .pipe(Effect.orElseSucceed(() => ({ threads: [] as ReadonlyArray<CatalogThreadTitle> })));
      return ids.map(
        (id) => shell.threads.find((thread) => thread.id === id)?.title ?? "Another thread",
      );
    });
  const lock = yield* Semaphore.make(1);
  // The last Trellis listing that was fully applied; unchanged listings skip
  // the T3 read unless a T3 project or thread changed meanwhile.
  const lastApplied = yield* Ref.make<{
    readonly fingerprint: string;
    readonly items: ReadonlyArray<TrellisProjectView>;
    readonly ids: ReadonlyMap<string, ProjectId>;
  } | null>(null);
  const dirty = yield* Ref.make(true);

  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`${SYNC_COMMAND_PREFIX}${tag}:${uuid}`)),
    );

  const readT3 = Effect.gen(function* () {
    const active = yield* snapshots.getShellSnapshot();
    const archived = yield* snapshots.getArchivedShellSnapshot();
    const threads: Array<CatalogThread> = [
      ...active.threads.map((thread) => ({
        id: thread.id,
        projectId: thread.projectId,
        archived: thread.archivedAt !== null,
        updatedAt: thread.updatedAt,
      })),
      ...archived.threads.map((thread) => ({
        id: thread.id,
        projectId: thread.projectId,
        archived: true,
        updatedAt: thread.updatedAt,
      })),
    ];
    return { projects: active.projects, threads };
  });

  const apply = Effect.fn("TrellisCatalog.apply")(function* (action: CatalogSyncAction) {
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    switch (action.type) {
      case "create": {
        const projectId = ProjectId.make(yield* crypto.randomUUIDv4);
        yield* engine.dispatch({
          type: "project.create",
          commandId: yield* commandId("create"),
          projectId,
          title: action.title,
          workspaceRoot: action.workspaceRoot,
          createdAt,
        });
        return { root: action.workspaceRoot, projectId };
      }
      case "rename":
        yield* engine.dispatch({
          type: "project.meta.update",
          commandId: yield* commandId("rename"),
          projectId: action.projectId,
          title: action.title,
        });
        return undefined;
      case "retire":
        for (const threadId of action.archiveThreadIds) {
          yield* engine.dispatch({
            type: "thread.archive",
            commandId: yield* commandId("archive"),
            threadId,
          });
        }
        if (action.deleteProject) {
          yield* engine.dispatch({
            type: "project.delete",
            commandId: yield* commandId("retire"),
            projectId: action.projectId,
          });
        }
        return undefined;
    }
  });

  const syncOnce = Effect.gen(function* () {
    const env = yield* trellis.refresh;
    if (env === null) {
      yield* Ref.set(lastApplied, null);
      return new Map<string, ProjectId>();
    }
    const items = yield* trellis.listProjects({ all: true });
    const fingerprint = encodeListing(items);
    const previous = yield* Ref.get(lastApplied);
    if (previous?.fingerprint === fingerprint && !(yield* Ref.get(dirty))) {
      return previous.ids;
    }
    const t3 = yield* readT3;
    yield* Ref.set(dirty, false);
    const ids = new Map<string, ProjectId>();
    for (const project of t3.projects) ids.set(normalizeRoot(project.workspaceRoot), project.id);
    const unlisted = unlistedWorkspaceIds({ root: env.root, items, projects: t3.projects });
    const deletedWorkspaces = new Map<string, number>();
    if (unlisted.length > 0) {
      for (const workspace of yield* trellis.listWorkspaces({ all: true })) {
        if (workspace.deleted_at !== null && unlisted.includes(workspace.id)) {
          deletedWorkspaces.set(workspace.id, workspace.deleted_at);
        }
      }
    }
    const actions = planCatalogSync({
      root: env.root,
      items,
      projects: t3.projects,
      threads: t3.threads,
      deletedWorkspaces,
    });
    let failed = false;
    for (const action of actions) {
      const created = yield* apply(action).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Trellis catalog sync action failed", {
            action: action.type,
            detail: error.message,
          }).pipe(
            Effect.tap(() => Effect.sync(() => (failed = true))),
            Effect.as(undefined),
          ),
        ),
      );
      if (created) ids.set(created.root, created.projectId);
    }
    // A failed action (for example a projection lagging behind a dispatch)
    // is retried on the next poll.
    if (failed) yield* Ref.set(dirty, true);
    yield* Ref.set(lastApplied, { fingerprint, items, ids });
    return ids as ReadonlyMap<string, ProjectId>;
  });

  const syncNow = lock
    .withPermits(1)(syncOnce)
    .pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Trellis catalog sync failed", { cause: Cause.pretty(cause) }).pipe(
              Effect.andThen(Ref.get(lastApplied)),
              Effect.map((applied) => applied?.ids ?? new Map<string, ProjectId>()),
            ),
      ),
    );

  // A user rename of a Trellis-managed project in T3 is pushed to Trellis,
  // which pins the name. Fork titles are derived, so renaming one is not pushed.
  const pushRename = Effect.fn("TrellisCatalog.pushRename")(function* (
    projectId: ProjectId,
    title: string,
  ) {
    const env = yield* trellis.current;
    const applied = yield* Ref.get(lastApplied);
    if (env === null || applied === null) return;
    const project = (yield* snapshots.getShellSnapshot()).projects.find(
      (entry) => entry.id === projectId,
    );
    if (!project) return;
    const root = normalizeRoot(project.workspaceRoot);
    const target = desiredProjects(applied.items).find(
      (entry) => entry.primary && entry.workspaceRoot === root,
    );
    if (!target || target.title === title) return;
    yield* trellis.describe({ target: root, name: title });
  });

  const start: TrellisCatalog["Service"]["start"] = Effect.fn("TrellisCatalog.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(
      Stream.runForEach(events, (event) => {
        switch (event.type) {
          case "project.meta-updated": {
            const title = event.payload.title;
            const fromSync = event.commandId?.startsWith(SYNC_COMMAND_PREFIX) === true;
            return Ref.set(dirty, true).pipe(
              Effect.andThen(
                title === undefined || fromSync
                  ? Effect.void
                  : lock
                      .withPermits(1)(pushRename(event.payload.projectId, title))
                      .pipe(
                        Effect.andThen(syncNow),
                        Effect.catchCause((cause) =>
                          // Keep the subscription alive whatever happens here.
                          Cause.hasInterruptsOnly(cause)
                            ? Effect.interrupt
                            : Effect.logWarning("failed to push project rename to Trellis", {
                                projectId: event.payload.projectId,
                                cause: Cause.pretty(cause),
                              }),
                        ),
                      ),
              ),
              Effect.asVoid,
            );
          }
          case "project.created":
          case "project.deleted":
          case "thread.created":
          case "thread.archived":
          case "thread.unarchived":
          case "thread.deleted":
            return Ref.set(dirty, true);
          default:
            return Effect.void;
        }
      }),
    );
    yield* forkParked(syncNow.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL)), Effect.asVoid));
  });

  const created = Effect.fn("TrellisCatalog.created")(function* (item: TrellisProjectView) {
    const ids = yield* syncNow;
    const projectId = ids.get(normalizeRoot(item.path));
    if (projectId === undefined) {
      return yield* new TrellisError({
        message: `Trellis created ${item.name}, but its T3 project is not available yet.`,
      });
    }
    return { projectId, workspaceRoot: item.path, name: item.name } satisfies TrellisCreateResult;
  });

  const find: TrellisCatalog["Service"]["find"] = Effect.fn("TrellisCatalog.find")(
    function* (query) {
      const env = yield* trellis.current;
      const hits = yield* trellis.find(query);
      const entries = splitFindHits(env?.root ?? "/", hits);
      const idFor = (ids: ReadonlyMap<string, ProjectId>, root: string) => ids.get(root) ?? null;
      let ids = (yield* Ref.get(lastApplied))?.ids ?? new Map<string, ProjectId>();
      if (entries.some((entry) => isLive(entry.item) && idFor(ids, entry.workspaceRoot) === null)) {
        ids = yield* syncNow;
      }
      return {
        hits: entries.map((entry): TrellisFindHit => ({
          projectId: isLive(entry.item) ? idFor(ids, entry.workspaceRoot) : null,
          kind: entry.item.kind === "idea" ? "idea" : "project",
          name: entry.title,
          description: entry.item.description,
          path: entry.workspaceRoot,
          matches: entry.matches,
        })),
      };
    },
  );

  const requireReady = Effect.gen(function* () {
    const env = (yield* trellis.current) ?? (yield* trellis.refresh);
    if (env === null) {
      return yield* new TrellisError({
        message: (yield* trellis.enabled)
          ? "Trellis is not running on this server."
          : "The Trellis integration is turned off on this server.",
      });
    }
    return env;
  });

  const prepareIdeaDraft = Effect.gen(function* () {
    yield* requireReady;
    const existing = yield* snapshots
      .getProjectShellById(TRELLIS_LANDING_PAD_PROJECT_ID)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(existing)) {
      return {
        projectId: TRELLIS_LANDING_PAD_PROJECT_ID,
        workspaceRoot: existing.value.workspaceRoot,
      } satisfies TrellisIdeaDraftTarget;
    }
    yield* fileSystem.makeDirectory(landingPadRoot, { recursive: true });
    yield* engine
      .dispatch({
        type: "project.create",
        commandId: yield* commandId("landing-pad"),
        projectId: TRELLIS_LANDING_PAD_PROJECT_ID,
        title: "New idea",
        workspaceRoot: landingPadRoot,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      })
      .pipe(
        // The projection can lag behind an earlier create; the engine knows.
        Effect.catch((error) =>
          error.message.includes("already exists") ? Effect.void : Effect.fail(error),
        ),
      );
    return {
      projectId: TRELLIS_LANDING_PAD_PROJECT_ID,
      workspaceRoot: landingPadRoot,
    } satisfies TrellisIdeaDraftTarget;
  }).pipe(
    landingPadLock.withPermits(1),
    Effect.catch((error) =>
      error._tag === "TrellisError"
        ? Effect.fail(error)
        : Effect.fail(
            new TrellisError({ message: `Could not prepare a new idea: ${error.message}` }),
          ),
    ),
  );

  const trashProject: TrellisCatalog["Service"]["trashProject"] = Effect.fn(
    "TrellisCatalog.trashProject",
  )(function* (projectId) {
    yield* requireReady;
    const project = yield* snapshots.getProjectShellById(projectId).pipe(
      Effect.orElseSucceed(() => Option.none()),
      Effect.map(Option.getOrUndefined),
    );
    if (project === undefined) {
      return yield* new TrellisError({ message: "This project no longer exists." });
    }
    const items = yield* trellis.listProjects({ all: false });
    const target = trashTargetOf(items, project.workspaceRoot);
    if (target === null) {
      return { trashed: null, name: project.title } satisfies TrellisTrashProjectResult;
    }
    // Trashing moves the files away and stops the workspace, so running
    // agents inside it would lose their work.
    const item = items.find((entry) =>
      target.kind === "project"
        ? entry.id === target.id
        : entry.workspaces.some((workspace) => workspace.id === target.id),
    );
    const scopes =
      target.kind === "workspace"
        ? (item?.workspaces.filter((workspace) => workspace.id === target.id) ?? []).map(
            (workspace) => workspace.path,
          )
        : item === undefined || item.kind === "idea" || item.workspaces.length === 0
          ? [project.workspaceRoot]
          : item.workspaces.map((workspace) => workspace.path);
    const busy = yield* activeThreadTitlesIn(scopes);
    if (busy.length > 0) {
      return yield* new TrellisError({
        message: `${busy.map((title) => `"${title}"`).join(", ")} ${busy.length === 1 ? "is" : "are"} still working in ${target.name}. Wait for ${busy.length === 1 ? "it" : "them"} to finish or stop ${busy.length === 1 ? "it" : "them"}, then try again.`,
      });
    }
    if (target.kind === "project") yield* trellis.trashProject(target.id);
    else yield* trellis.trashWorkspace(target.id);
    yield* syncNow;
    return { trashed: target.kind, name: target.name } satisfies TrellisTrashProjectResult;
  });

  // Restoring also unarchives the conversations the sync archived when the
  // item went to the trash (archived since then), the reverse of retiring it.
  const restore: TrellisCatalog["Service"]["restore"] = Effect.fn("TrellisCatalog.restore")(
    function* (input) {
      const env = yield* requireReady;
      const trash = yield* trellis.listTrash;
      const deletedAt =
        [...trash.projects, ...trash.workspaces].find((entry) => entry.id === input.id)
          ?.deleted_at ?? null;
      let root: string;
      // Every T3 project the restore brings back: a project restores its forks too.
      let roots: ReadonlyArray<string>;
      if (input.kind === "workspace") {
        yield* trellis.restoreWorkspace(input.id);
        root = NodePath.posix.join(env.root, "workspaces", input.id, "project");
        roots = [root];
      } else {
        const restored = yield* trellis.restoreProject(input.id);
        root = restored.path;
        roots =
          restored.kind === "idea" || restored.workspaces.length === 0
            ? [root]
            : restored.workspaces.map((workspace) => workspace.path);
      }
      const ids = yield* syncNow;
      const projectId = ids.get(normalizeRoot(root)) ?? null;
      const restoredProjectIds = new Set(
        roots.flatMap((entry) => {
          const id = ids.get(normalizeRoot(entry));
          return id === undefined ? [] : [id];
        }),
      );
      if (deletedAt !== null) {
        const archived = yield* snapshots
          .getArchivedShellSnapshot()
          .pipe(Effect.orElseSucceed(() => ({ threads: [] })));
        for (const thread of archived.threads) {
          if (
            restoredProjectIds.has(thread.projectId) &&
            thread.archivedAt !== null &&
            Date.parse(thread.archivedAt) >= deletedAt * 1000
          ) {
            yield* commandId("restore-unarchive").pipe(
              Effect.flatMap((id) =>
                engine.dispatch({ type: "thread.unarchive", commandId: id, threadId: thread.id }),
              ),
              Effect.catch((error) =>
                Effect.logWarning("could not unarchive a restored Trellis thread", {
                  threadId: thread.id,
                  detail: error.message,
                }),
              ),
            );
          }
        }
      }
      return { projectId } satisfies TrellisRestoreResult;
    },
  );

  return TrellisCatalog.of({
    start,
    syncNow,
    status: Effect.gen(function* () {
      let connection = yield* trellis.connection;
      if (connection.state === "unavailable") {
        yield* trellis.refresh;
        connection = yield* trellis.connection;
      }
      return {
        state: connection.state,
        available: connection.state === "ready",
        ...(connection.root === null ? {} : { root: connection.root }),
        socketPath: connection.socketPath,
      } satisfies TrellisStatus;
    }),
    newIdea: (input) => trellis.createIdea(input).pipe(Effect.flatMap(created)),
    newProject: (input) => trellis.createProject(input).pipe(Effect.flatMap(created)),
    prepareIdeaDraft,
    trashProject,
    listTrash: requireReady.pipe(Effect.andThen(trellis.listTrash), Effect.map(trashItems)),
    restore,
    emptyTrash: requireReady.pipe(Effect.andThen(trellis.emptyTrash)),
    find,
  });
});

export const layer = Layer.effect(TrellisCatalog, make);

const unavailable = () => Effect.fail(new TrellisError({ message: "Trellis is unavailable." }));

/** For runtimes without Trellis: status is unavailable and operations fail. */
export const layerDisabled = Layer.succeed(
  TrellisCatalog,
  TrellisCatalog.of({
    start: () => Effect.void,
    syncNow: Effect.succeed(new Map()),
    status: Effect.succeed({ state: "disabled", available: false }),
    newIdea: unavailable,
    newProject: unavailable,
    prepareIdeaDraft: unavailable(),
    trashProject: unavailable,
    listTrash: unavailable(),
    restore: unavailable,
    emptyTrash: unavailable(),
    find: unavailable,
  }),
);
