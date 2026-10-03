// @effect-diagnostics nodeBuiltinImport:off
/**
 * TrellisCatalog - keeps one T3 project per Trellis workspace path and serves
 * the client-facing Trellis operations.
 *
 * Trellis is the source of truth for names. The sync polls the Trellis
 * catalog, creates missing T3 projects (matched by `workspaceRoot`, so it never
 * duplicates), renames them to the Trellis name, and retires projects whose
 * Trellis item was trashed or graduated: their conversations are archived
 * (reversibly) and only an empty project is deleted. An idea graduated
 * elsewhere (`trellis graduate`) is followed instead: its active threads
 * move into the new project, without a continuation. A user rename in T3 is
 * pushed to Trellis (which pins the name) instead of being overwritten.
 * Nothing runs while the integration is off.
 *
 * New ideas are created lazily: a new-idea draft belongs to the hidden landing
 * pad project (`TRELLIS_LANDING_PAD_PROJECT_ID`), and its first send creates
 * the idea and moves the thread into the idea's project (TrellisIdeaPromotion).
 *
 * @module trellis/TrellisCatalog
 */
import * as NodePath from "node:path";

import {
  CommandId,
  ProjectId,
  ThreadId,
  TRELLIS_LANDING_PAD_PROJECT_ID,
  TrellisError,
  type TrellisBasesResult,
  type TrellisBuildBaseResult,
  type TrellisSetPreviewHostResult,
  type TrellisDetails,
  type TrellisHistorySettings,
  type TrellisHistorySettingsUpdateResult,
  type TrellisHistoryValues,
  type TrellisProfile,
  type TrellisCreateResult,
  type TrellisFindHit,
  type TrellisFindResult,
  type TrellisIdeaDraftTarget,
  type TrellisRestoreConflicts,
  type TrellisRestoreConflictsInput,
  type TrellisRestoreInput,
  type TrellisRestoreResult,
  type TrellisStatus,
  type TrellisCheckpointEntry,
  type TrellisForkWorkspaceInput,
  type TrellisForkWorkspaceResult,
  type TrellisTrashItem,
  type TrellisTrashProjectResult,
  type TrellisWorkspaceEntry,
  type TrellisWorkspaceList,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
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
import { pathsOverlap } from "@t3tools/shared/trellis";

import { ServerConfig } from "../config.ts";
import { fileRestoreTargetOf } from "../orchestration-v2/CheckpointService.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import {
  isTrellisManagedPath,
  Trellis,
  type TrellisFindHitView,
  TrellisProjectView,
  type TrellisTrashView,
  type TrellisWorkspaceView,
} from "./Trellis.ts";
import { TrellisCheckpointPins } from "./TrellisCheckpointStore.ts";
import {
  captureOutstandingIn,
  restoreConflictsIn,
  restoreScopeOf,
  TrellisRestoreGate,
} from "./TrellisRestore.ts";

const POLL_INTERVAL = "3 seconds";
const PIN_RECONCILE_INTERVAL = "10 minutes";
const encodeListing = Schema.encodeSync(Schema.fromJsonString(Schema.Array(TrellisProjectView)));
const SYNC_COMMAND_PREFIX = "server:trellis-sync:";

export interface CatalogProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface CatalogThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly archived: boolean;
  /** Epoch milliseconds of the last change, including an unarchive. */
  readonly updatedAtMs: number;
}

export type CatalogSyncAction =
  | { readonly type: "create"; readonly workspaceRoot: string; readonly title: string }
  | { readonly type: "rename"; readonly projectId: ProjectId; readonly title: string }
  | {
      readonly type: "retire";
      readonly projectId: ProjectId;
      /** Active threads to archive; archiving is reversible and keeps them. */
      readonly archiveThreadIds: ReadonlyArray<ThreadId>;
      /**
       * Only a project without any threads is deleted, and only once its item
       * cannot come back (graduated or purged): one in the trash keeps its id
       * for a restore, hidden meanwhile.
       */
      readonly deleteProject: boolean;
    }
  | {
      /** Moves a graduated idea's active threads into the project it became. */
      readonly type: "repoint";
      readonly projectId: ProjectId;
      readonly toRoot: string;
      readonly threadIds: ReadonlyArray<ThreadId>;
    };

export interface DesiredProject {
  readonly workspaceRoot: string;
  readonly title: string;
  /** False for fork workspaces, whose title is derived from the project name. */
  readonly primary: boolean;
  /** A fork a thread spawned (Trellis `spawned_by`): hidden from the sidebar. */
  readonly worker: boolean;
}

const normalizeRoot = (root: string) => NodePath.posix.normalize(root).replace(/(.)\/+$/, "$1");

const isLive = (item: TrellisProjectView) => item.deleted_at === null && item.graduated_to === null;

const titleOf = (name: string, path: string) =>
  name.trim() || NodePath.posix.basename(path) || "Trellis project";

/** One T3 project per live Trellis idea and per workspace of a live dedicated project. */
function desiredProjects(items: ReadonlyArray<TrellisProjectView>): ReadonlyArray<DesiredProject> {
  const desired: Array<DesiredProject> = [];
  for (const item of items) {
    if (!isLive(item)) continue;
    const name = titleOf(item.name, item.path);
    if (item.kind === "idea" || item.workspaces.length === 0) {
      desired.push({
        workspaceRoot: normalizeRoot(item.path),
        title: name,
        primary: true,
        worker: false,
      });
      continue;
    }
    for (const workspace of item.workspaces) {
      // A trashed fork of a live project is retired, not desired.
      if (workspace.deleted_at !== null) continue;
      const primary = workspace.id === item.workspace_id;
      desired.push({
        workspaceRoot: normalizeRoot(workspace.path),
        title: primary ? name : `${name} · ${workspace.name.trim() || workspace.id}`,
        primary,
        worker: !primary && workspace.spawned_by != null,
      });
    }
  }
  return desired;
}

/** Roots of live worker forks (Trellis `spawned_by`), which clients keep out of the sidebar. */
export function workerRoots(items: ReadonlyArray<TrellisProjectView>): ReadonlyArray<string> {
  return desiredProjects(items)
    .filter((entry) => entry.worker)
    .map((entry) => entry.workspaceRoot);
}

/**
 * Names the workspaces `details` lists from a catalog listing: the project's
 * name for its primary workspace, `project · fork` for a fork, `Ideas` for
 * the scratch workspace. Workspaces the listing lacks stay unnamed.
 */
export function nameDetailsWorkspaces(
  details: TrellisDetails,
  items: ReadonlyArray<TrellisProjectView>,
): TrellisDetails {
  const names = new Map<string, string>();
  for (const item of items) {
    for (const workspace of item.workspaces) {
      names.set(
        workspace.id,
        workspace.kind === "scratch"
          ? "Ideas"
          : workspace.id === item.workspace_id
            ? item.name
            : `${item.name} · ${workspace.name}`,
      );
    }
  }
  const named = <T extends { readonly id: string }>(entry: T) => ({
    ...entry,
    name: names.get(entry.id) ?? null,
  });
  return {
    ...details,
    runningWorkspaces: details.runningWorkspaces?.map(named) ?? null,
    restartNeeded: details.restartNeeded?.map(named) ?? null,
  };
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
    for (const workspace of item.workspaces) {
      if (workspace.deleted_at === null) listed.add(workspace.id);
    }
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
  /**
   * Managed roots that are in no listing and gone from disk (purged before
   * T3 saw them trashed), with when that was first seen, in Unix seconds.
   */
  readonly missingRoots?: ReadonlyMap<string, number>;
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
  // Graduated ideas' roots, to the root of the live project each became.
  const graduatedInto = new Map<string, string>();
  for (const item of input.items) {
    if (item.graduated_to === null || item.deleted_at !== null) continue;
    const target = input.items.find((candidate) => candidate.id === item.graduated_to);
    if (target !== undefined && isLive(target)) {
      graduatedInto.set(normalizeRoot(item.path), normalizeRoot(target.path));
    }
  }
  // Roots in the Trellis trash, which a restore brings back.
  const inTrash = new Set<string>();
  for (const item of input.items) {
    if (!isLive(item)) {
      retiredAt.set(normalizeRoot(item.path), item.deleted_at ?? item.updated_at);
      if (item.deleted_at !== null) inTrash.add(normalizeRoot(item.path));
    } else {
      for (const workspace of item.workspaces) {
        if (workspace.deleted_at !== null) {
          retiredAt.set(normalizeRoot(workspace.path), workspace.deleted_at);
          inTrash.add(normalizeRoot(workspace.path));
        }
      }
    }
  }
  for (const [root, project] of projectsByRoot) {
    if (desiredRoots.has(root) || !isTrellisManagedPath(input.root, root)) continue;
    const workspaceId = workspaceIdOfRoot(input.root, root);
    const trashedWorkspaceAt =
      workspaceId === null ? undefined : input.deletedWorkspaces.get(workspaceId);
    const at = retiredAt.get(root) ?? trashedWorkspaceAt ?? input.missingRoots?.get(root);
    if (at === undefined) continue;
    const threads = input.threads.filter((thread) => thread.projectId === project.id);
    const toRoot = graduatedInto.get(root);
    const active = threads.filter((thread) => !thread.archived);
    // Followed into the project; retired once only archived threads are left.
    if (toRoot !== undefined && active.length > 0) {
      actions.push({
        type: "repoint",
        projectId: project.id,
        toRoot,
        threadIds: active.map((thread) => thread.id),
      });
      continue;
    }
    // Only threads untouched since the retirement: one the user unarchived
    // (or kept working in) afterwards stays where it is.
    const archiveThreadIds = threads
      // `at` is in whole seconds: a thread updated during that second is older.
      .filter((thread) => !thread.archived && thread.updatedAtMs < (at + 1) * 1000)
      .map((thread) => thread.id);
    const deleteProject =
      threads.length === 0 && !inTrash.has(root) && trashedWorkspaceAt === undefined;
    if (archiveThreadIds.length === 0 && !deleteProject) continue;
    actions.push({ type: "retire", projectId: project.id, archiveThreadIds, deleteProject });
  }
  return actions;
}

const MissingRootsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Finite));

/**
 * The file recording when purged roots were first found missing (Unix
 * seconds per root). An unreadable file is set aside as `<path>.unreadable`
 * and logged, and the record starts empty; if it cannot be set aside, it is
 * never overwritten (`write` then does nothing).
 */
export const openMissingRootsRecord = Effect.fn("TrellisCatalog.openMissingRootsRecord")(function* (
  path: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  let writable = true;
  const initial: ReadonlyMap<string, number> = new Map(
    Object.entries(
      (yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false)))
        ? yield* fileSystem.readFileString(path).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(MissingRootsJson)),
            Effect.catchCause((cause) =>
              Effect.logWarning("unreadable record of missing Trellis roots; set aside", {
                path,
                cause,
              }).pipe(
                Effect.andThen(fileSystem.rename(path, `${path}.unreadable`)),
                Effect.catchCause((renameCause) =>
                  Effect.logWarning("could not set the unreadable record aside; not persisting", {
                    cause: renameCause,
                  }).pipe(Effect.andThen(Effect.sync(() => void (writable = false)))),
                ),
                Effect.as({}),
              ),
            ),
          )
        : {},
    ),
  );
  const write = (record: ReadonlyMap<string, number>) =>
    Effect.gen(function* () {
      if (!writable) return;
      const partial = `${path}.partial`;
      yield* fileSystem.writeFileString(
        partial,
        yield* Schema.encodeEffect(MissingRootsJson)(Object.fromEntries(record)),
      );
      yield* fileSystem.rename(partial, path);
    });
  return { initial, write };
});

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
 * The provider sessions a trash ends. Trashing a project or fork stops its
 * workspace and the provider processes running in it, so the sessions working
 * there are released and the next turn there (after a restore) opens a new
 * process instead of reusing the dead one. An idea's folder lives in the
 * shared scratch workspace, which keeps running, so trashing one ends none.
 */
export function sessionsEndedByTrash<Id extends string>(input: {
  readonly dedicated: boolean;
  readonly roots: ReadonlyArray<string>;
  readonly live: ReadonlyArray<{ readonly providerSessionId: Id; readonly cwd: string }>;
}): ReadonlyArray<Id> {
  if (!input.dedicated) return [];
  const roots = input.roots.map(normalizeRoot);
  const within = (cwd: string) => roots.some((root) => cwd === root || cwd.startsWith(`${root}/`));
  return [
    ...new Set(
      input.live
        .filter((session) => within(normalizeRoot(session.cwd)))
        .map((session) => session.providerSessionId),
    ),
  ];
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
export function trashItems(
  view: TrellisTrashView,
  /** Thread titles by id, to name who asked for a purge. */
  titles: ReadonlyMap<string, string> = new Map(),
): ReadonlyArray<TrellisTrashItem> {
  const expiryOf = (entry: TrellisTrashView["projects"][number], deletedAt: number) =>
    entry.expires_at !== undefined
      ? entry.expires_at
      : view.idea_expiry_days !== undefined
        ? entry.kind === "idea"
          ? deletedAt + view.idea_expiry_days * 86_400
          : null
        : deletedAt + (view.purge_after_days ?? 30) * 86_400;
  // Only what this Trellis reports: versions before purge requests send neither field.
  const purgeRequestOf = (entry: TrellisTrashView["projects"][number]) =>
    entry.purge_requested === undefined
      ? {}
      : {
          purgeRequested:
            entry.purge_requested === null
              ? null
              : {
                  at: entry.purge_requested.at,
                  reason: entry.purge_requested.reason,
                  by:
                    entry.purge_requested.thread === null
                      ? null
                      : (titles.get(entry.purge_requested.thread) ?? entry.purge_requested.thread),
                },
        };
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
      ...purgeRequestOf(entry),
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
      ...(entry.unmerged === undefined
        ? {}
        : { unmerged: entry.unmerged, unmergedReason: entry.unmerged_reason ?? null }),
      ...purgeRequestOf(entry),
    });
  }
  return items.toSorted((left, right) => right.deletedAt - left.deletedAt);
}

/**
 * The workspaces of one Trellis project for its workspace list: the primary
 * workspace, then live forks, then discarded forks still in the trash, each
 * oldest first. `workspaces` is a listing with `all` (trashed ones too).
 */
export function workspaceEntries(input: {
  readonly trellisProjectId: string;
  readonly primaryWorkspaceId: string;
  readonly workspaces: ReadonlyArray<TrellisWorkspaceView>;
  readonly trash: TrellisTrashView;
  /** T3 project ids by workspace root. */
  readonly projectIds: ReadonlyMap<string, ProjectId>;
  /** Thread titles by id. */
  readonly titles: ReadonlyMap<string, string>;
}): ReadonlyArray<TrellisWorkspaceEntry> {
  const trashed = new Map(trashItems(input.trash, input.titles).map((item) => [item.id, item]));
  const entries: Array<TrellisWorkspaceEntry> = [];
  for (const workspace of input.workspaces) {
    if (workspace.project_id !== input.trellisProjectId) continue;
    const primary = workspace.id === input.primaryWorkspaceId;
    const discarded = workspace.deleted_at !== null;
    // A fork trashed with its project is not listed (the project is gone).
    const trash = trashed.get(workspace.id);
    if (discarded && (primary || trash === undefined)) continue;
    const spawnedBy = workspace.spawned_by ?? null;
    entries.push({
      id: workspace.id,
      name: workspace.name.trim() || workspace.id,
      kind: primary ? "primary" : "fork",
      state: discarded
        ? "discarded"
        : workspace.checkpointing === true
          ? "checkpointing"
          : workspace.running === true
            ? "running"
            : "stopped",
      projectId: discarded ? null : (input.projectIds.get(normalizeRoot(workspace.path)) ?? null),
      spawnedBy:
        spawnedBy === null
          ? null
          : {
              threadId: ThreadId.make(spawnedBy.thread),
              title: input.titles.get(spawnedBy.thread) ?? null,
            },
      createdAt: workspace.created_at ?? null,
      deletedAt: workspace.deleted_at,
      unmerged: trash?.unmerged ?? null,
      unmergedReason: trash?.unmergedReason ?? null,
      expiresAt: trash?.expiresAt ?? null,
      purgeRequested: trash?.purgeRequested ?? null,
    });
  }
  const rank = (entry: TrellisWorkspaceEntry) =>
    entry.kind === "primary" ? 0 : entry.state === "discarded" ? 2 : 1;
  return entries.toSorted(
    (left, right) => rank(left) - rank(right) || (left.createdAt ?? 0) - (right.createdAt ?? 0),
  );
}

/**
 * T3 project roots whose Trellis item is gone (trashed or graduated), from a
 * listing with `all`: every path of a non-live item, trashed forks of live
 * items, and `goneRoots` (workspaces Trellis reports as deleted, roots of
 * purged items). Clients hide such projects once nothing in them is active.
 */
export function retiredRoots(
  items: ReadonlyArray<TrellisProjectView>,
  goneRoots: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const live = new Set(
    desiredProjects(
      items.map((item) => ({
        ...item,
        workspaces: item.workspaces.filter((workspace) => workspace.deleted_at === null),
      })),
    ).map((entry) => entry.workspaceRoot),
  );
  const roots = new Set<string>();
  for (const item of items) {
    if (!isLive(item)) {
      roots.add(normalizeRoot(item.path));
      // An idea's workspace is the shared scratch, which stays.
      if (item.kind !== "idea") {
        for (const workspace of item.workspaces) roots.add(normalizeRoot(workspace.path));
      }
    } else {
      for (const workspace of item.workspaces) {
        if (workspace.deleted_at !== null) roots.add(normalizeRoot(workspace.path));
      }
    }
  }
  for (const root of goneRoots) roots.add(normalizeRoot(root));
  return [...roots].filter((root) => !live.has(root)).toSorted();
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
    /**
     * Creates the idea for a new-idea draft's first send, with its T3 project.
     * `trellisId` lets the caller discard it if the move fails; an idea whose
     * T3 project cannot be created is discarded here.
     */
    readonly createIdeaForDraft: Effect.Effect<
      TrellisCreateResult & { readonly trellisId: string },
      TrellisError
    >;
    /** Trashes an idea that never got a thread. Never fails. */
    readonly discardIdea: (trellisId: string) => Effect.Effect<void>;
    /** Ensures the landing pad project that new-idea drafts belong to. Creates no idea. */
    readonly prepareIdeaDraft: Effect.Effect<TrellisIdeaDraftTarget, TrellisError>;
    /** Moves the Trellis item behind a T3 project to the trash and archives its conversations. */
    readonly trashProject: (
      projectId: ProjectId,
    ) => Effect.Effect<TrellisTrashProjectResult, TrellisError>;
    readonly listTrash: Effect.Effect<ReadonlyArray<TrellisTrashItem>, TrellisError>;
    /** Restores a trashed item and unarchives the conversations its trashing archived. */
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
    /** Who a file restore to a checkpoint would conflict with (see the contract). */
    readonly restoreConflicts: (
      input: TrellisRestoreConflictsInput,
    ) => Effect.Effect<TrellisRestoreConflicts, TrellisError>;
    /**
     * Refuses removing only T3's entry for a live Trellis project (its
     * conversations would be deleted and the sync would bring the project
     * back), and any Trellis project while Trellis is unreachable.
     */
    readonly checkProjectDelete: (projectId: ProjectId) => Effect.Effect<void, TrellisError>;
    /** The workspaces of the Trellis project behind a T3 project, worker forks included. */
    readonly listWorkspaces: (
      projectId: ProjectId,
    ) => Effect.Effect<TrellisWorkspaceList, TrellisError>;
    /** A workspace's checkpoints, newest first. */
    readonly listCheckpoints: (
      workspaceId: string,
    ) => Effect.Effect<ReadonlyArray<TrellisCheckpointEntry>, TrellisError>;
    /** Forks a workspace from a checkpoint for the user (no `spawned_by`), with its T3 project. */
    readonly forkWorkspace: (
      input: TrellisForkWorkspaceInput,
    ) => Effect.Effect<TrellisForkWorkspaceResult, TrellisError>;
    /** Purges the listed trashed items for good. */
    readonly purge: (ids: ReadonlyArray<string>) => Effect.Effect<number, TrellisError>;
    /**
     * Moves one fork to the Trellis trash as a project's trash does: refused
     * while a thread works in it, its sessions released and its threads
     * archived. Returns false when it was already in the trash.
     */
    readonly discardFork: (workspaceId: string) => Effect.Effect<boolean, TrellisError>;
    /** The bases a new project (or a graduating idea) can start from. */
    readonly listBases: Effect.Effect<TrellisBasesResult, TrellisError>;
    /**
     * Rebuilds a base from its built-in definition; see `Trellis.buildBase`.
     * The build runs detached from the caller, so a dropped connection does
     * not abort it, and a second request for a base being built joins it
     * rather than queueing another build.
     */
    readonly buildBase: (name: string) => Effect.Effect<TrellisBuildBaseResult, TrellisError>;
    /** Changes where previews listen; see `Trellis.setPreviewHost`. */
    readonly setPreviewHost: (
      setting: string,
    ) => Effect.Effect<TrellisSetPreviewHostResult, TrellisError>;
    /** The Trellis service's status in full, workspaces named from the last sync. */
    readonly details: Effect.Effect<TrellisDetails, TrellisError>;
    /** Trellis's snapshot timer, retention and expiry settings, for Settings. */
    readonly historySettings: Effect.Effect<TrellisHistorySettings, TrellisError>;
    /** Changes the given history settings; Trellis validates them. */
    readonly updateHistorySettings: (
      values: TrellisHistoryValues,
    ) => Effect.Effect<TrellisHistorySettingsUpdateResult, TrellisError>;
    /** Runs Trellis maintenance now; see `Trellis.runMaintenance`. */
    readonly runMaintenance: Effect.Effect<void, TrellisError>;
    /** A workspace's effective agent profile, or (null) the agent homes' and global layer's. */
    readonly profile: (target: string | null) => Effect.Effect<TrellisProfile, TrellisError>;
    /** The T3 project for a Trellis item just created (a graduation's), made now rather than at the next poll. */
    readonly projectFor: (
      item: TrellisProjectView,
    ) => Effect.Effect<TrellisCreateResult, TrellisError>;
  }
>()("t3/trellis/TrellisCatalog") {}

/**
 * `TrellisCatalog.checkProjectDelete` for the project delete entry points
 * (RPC, HTTP, MCP); a no-op where the catalog is not wired.
 */
export const refuseTrellisProjectDelete = (projectId: ProjectId) =>
  Effect.serviceOption(TrellisCatalog).pipe(
    Effect.flatMap((catalog) =>
      Option.isNone(catalog) ? Effect.void : catalog.value.checkProjectDelete(projectId),
    ),
  );

const isTrellisError = Schema.is(TrellisError);

/** A restore whose unarchives may not have finished; see `finishRestore`. */
const PendingRestore = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["idea", "project", "workspace"]),
  /** When the item went to the trash, in Unix seconds. */
  deletedAt: Schema.Finite,
  /** The trashed project a fork's restore brings back, if any. */
  ownerId: Schema.NullOr(Schema.String),
});
type PendingRestore = typeof PendingRestore.Type;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

const make = Effect.gen(function* () {
  const trellis = yield* Trellis;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  // Read only: whether a stopped run's checkpoint capture is still queued.
  const effectOutbox = yield* EffectOutbox.EffectOutboxV2;
  // Absent in tests that never trash; trash then only checks for busy threads.
  const restoreGate = yield* Effect.serviceOption(TrellisRestoreGate);
  const checkpointPins = yield* Effect.serviceOption(TrellisCheckpointPins);
  const providerSessions = yield* ProviderSessionManagerV2;
  const orchestrator = yield* OrchestratorV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const projectService = yield* ProjectService;
  const applicationEvents = yield* OrchestrationEventStore;
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  // An empty directory owned by T3, outside every Trellis path, so nothing
  // treats the landing pad as a workspace. No thread ever runs there.
  const landingPadRoot = NodePath.join(serverConfig.stateDir, "trellis-landing-pad");
  const landingPadLock = yield* Semaphore.make(1);
  const lock = yield* Semaphore.make(1);
  // The last Trellis listing that was fully applied; unchanged listings skip
  // the T3 read unless a T3 project or thread changed meanwhile.
  const lastApplied = yield* Ref.make<{
    readonly fingerprint: string;
    readonly items: ReadonlyArray<TrellisProjectView>;
    readonly ids: ReadonlyMap<string, ProjectId>;
    readonly retiredRoots: ReadonlyArray<string>;
  } | null>(null);
  const dirty = yield* Ref.make(true);
  // When each purged root was first found missing (see `syncOnce`), so a
  // conversation unarchived afterwards is not archived again, also after a
  // server restart.
  const missingRecord = yield* openMissingRootsRecord(
    NodePath.join(serverConfig.stateDir, "trellis-missing-roots.json"),
  );
  const missingSince = new Map(missingRecord.initial);
  // Set when the map changed and the file does not have it yet; a failed
  // write is retried on the next sync.
  let missingSinceDirty = false;
  const persistMissingSince = missingRecord.write(missingSince).pipe(
    Effect.andThen(Effect.sync(() => void (missingSinceDirty = false))),
    Effect.catchCause((cause) =>
      Effect.logWarning("could not persist when Trellis roots went missing", { cause }),
    ),
  );

  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`${SYNC_COMMAND_PREFIX}${tag}:${uuid}`)),
    );

  const activeProjects = projectStore.list().pipe(
    Effect.map((rows) =>
      rows.map((row): CatalogProject => ({
        id: row.projectId,
        title: row.title,
        workspaceRoot: row.workspaceRoot,
      })),
    ),
  );

  // Active and archived threads (`threads` lists only the active ones).
  const readThreads = orchestrator
    .getShellSnapshot()
    .pipe(Effect.map((snapshot) => [...snapshot.threads, ...snapshot.archivedThreads]));

  const readT3 = Effect.gen(function* () {
    const projects = yield* activeProjects;
    const threads: Array<CatalogThread> = (yield* readThreads).map((thread) => ({
      id: thread.id,
      projectId: thread.projectId,
      archived: thread.archivedAt !== null,
      updatedAtMs: DateTime.toEpochMillis(thread.updatedAt),
    }));
    return { projects, threads };
  });

  /** Moves a thread out of `from`; already in `to` counts as done. */
  const moveThread = (threadId: ThreadId, from: ProjectId, to: ProjectId) =>
    Effect.gen(function* () {
      const id = yield* commandId("repoint");
      yield* orchestrator
        .dispatch({
          type: "thread.project.move",
          commandId: id,
          threadId,
          projectId: to,
          expectedProjectId: from,
        })
        .pipe(
          Effect.catch((error) =>
            orchestrator
              .getThreadShell(threadId)
              .pipe(
                Effect.flatMap((shell) =>
                  shell?.projectId === to ? Effect.void : Effect.fail(error),
                ),
              ),
          ),
        );
    });

  const archiveThread = (threadId: ThreadId) =>
    commandId("archive").pipe(
      Effect.flatMap((id) =>
        orchestrator.dispatch({ type: "thread.archive", commandId: id, threadId }),
      ),
    );

  const apply = Effect.fn("TrellisCatalog.apply")(function* (
    action: CatalogSyncAction,
    ids: ReadonlyMap<string, ProjectId>,
  ) {
    switch (action.type) {
      case "create": {
        const projectId = ProjectId.make(yield* crypto.randomUUIDv4);
        yield* projectService.create({
          commandId: yield* commandId("create"),
          projectId,
          title: action.title,
          workspaceRoot: action.workspaceRoot,
        });
        return { root: action.workspaceRoot, projectId };
      }
      case "rename":
        yield* projectService.update({
          commandId: yield* commandId("rename"),
          projectId: action.projectId,
          title: action.title,
        });
        return undefined;
      case "retire":
        for (const threadId of action.archiveThreadIds) yield* archiveThread(threadId);
        if (action.deleteProject) {
          yield* projectService.delete({
            commandId: yield* commandId("retire"),
            projectId: action.projectId,
          });
        }
        return undefined;
      case "repoint": {
        const to = ids.get(action.toRoot);
        if (to === undefined) {
          return yield* new TrellisError({ message: `No T3 project for ${action.toRoot} yet.` });
        }
        // Each on its own: a thread mid-turn is refused and tried on the next poll.
        const failed: Array<string> = [];
        for (const threadId of action.threadIds) {
          yield* moveThread(threadId, action.projectId, to).pipe(
            Effect.catch((error) =>
              Effect.sync(() => void failed.push(`${threadId}: ${errorMessage(error)}`)),
            ),
          );
        }
        if (failed.length > 0) {
          // Retried on every poll; a fork that has not run yet stays until it
          // is archived (it cannot follow, and cannot run in the idea).
          return yield* new TrellisError({
            message: `could not move threads of a graduated idea (a fork that has not run yet stays until archived): ${failed.join("; ")}`,
          });
        }
        // The next pass retires the idea's project, now without active threads.
        yield* Ref.set(dirty, true);
        return undefined;
      }
    }
  });

  const syncOnce = Effect.gen(function* () {
    const env = yield* trellis.refresh;
    // Unreachable or off: the last applied catalog stays, so retired
    // projects stay hidden; `status` reports the connection on its own.
    if (env === null) return new Map<string, ProjectId>();
    const items = yield* trellis.listProjects({ all: true });
    const fingerprint = encodeListing(items);
    const previous = yield* Ref.get(lastApplied);
    if (previous?.fingerprint === fingerprint && !(yield* Ref.get(dirty))) {
      // A record write that failed is retried even when nothing changed.
      if (missingSinceDirty) yield* persistMissingSince;
      return previous.ids;
    }
    yield* Ref.set(dirty, false);
    const t3 = yield* readT3;
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
    // A purged item leaves the listing and its files are gone. Its project
    // stays retired (clients keep hiding it), and when T3 never saw it
    // trashed its conversations are archived as for a trashed one. Only a
    // root positively absent counts: in no listing, and missing from disk
    // (an unreadable path counts as present).
    const listedRoots = new Set<string>();
    for (const item of items) {
      listedRoots.add(normalizeRoot(item.path));
      for (const workspace of item.workspaces) listedRoots.add(normalizeRoot(workspace.path));
    }
    const purgedRoots: Array<string> = [];
    for (const project of t3.projects) {
      const root = normalizeRoot(project.workspaceRoot);
      const workspaceId = workspaceIdOfRoot(env.root, root);
      if (
        listedRoots.has(root) ||
        !isTrellisManagedPath(env.root, root) ||
        (workspaceId !== null && deletedWorkspaces.has(workspaceId))
      ) {
        continue;
      }
      if (!(yield* fileSystem.exists(root).pipe(Effect.orElseSucceed(() => true)))) {
        purgedRoots.push(root);
      }
    }
    const nowSeconds = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
    for (const root of purgedRoots) {
      if (!missingSince.has(root)) {
        missingSince.set(root, nowSeconds);
        missingSinceDirty = true;
      }
    }
    for (const root of missingSince.keys()) {
      if (!purgedRoots.includes(root)) {
        missingSince.delete(root);
        missingSinceDirty = true;
      }
    }
    if (missingSinceDirty) yield* persistMissingSince;
    const actions = planCatalogSync({
      root: env.root,
      items,
      projects: t3.projects,
      threads: t3.threads,
      deletedWorkspaces,
      missingRoots: missingSince,
    });
    let failed = false;
    for (const action of actions) {
      const created = yield* apply(action, ids).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Trellis catalog sync action failed", {
            action: action.type,
            detail: errorMessage(error),
          }).pipe(
            Effect.tap(() => Effect.sync(() => (failed = true))),
            Effect.as(undefined),
          ),
        ),
      );
      if (created) ids.set(created.root, created.projectId);
    }
    // A failed action is retried on the next poll.
    if (failed) yield* Ref.set(dirty, true);
    yield* Ref.set(lastApplied, {
      fingerprint,
      items,
      ids,
      retiredRoots: retiredRoots(items, [
        ...[...deletedWorkspaces.keys()].map((id) =>
          NodePath.posix.join(env.root, "workspaces", id, "project"),
        ),
        ...purgedRoots,
      ]),
    });
    return ids as ReadonlyMap<string, ProjectId>;
  });

  /** One sync pass whose failures propagate, for callers that must not act on stale ids. */
  const syncStrict = lock.withPermits(1)(syncOnce);

  const syncNow = syncStrict.pipe(
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
    const project = yield* projectStore.get(projectId);
    if (Option.isNone(project)) return;
    const root = normalizeRoot(project.value.workspaceRoot);
    const target = desiredProjects(applied.items).find(
      (entry) => entry.primary && entry.workspaceRoot === root,
    );
    if (!target || target.title === title) return;
    yield* trellis.describe({ target: root, name: title });
  });

  const keepAlive = (label: string) =>
    Effect.catchCause((cause: Cause.Cause<unknown>) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning(label, { cause: Cause.pretty(cause) }),
    );

  // Releases the checkpoint pins of threads that no longer exist (archived
  // threads keep theirs: they can be unarchived and reverted).
  const reconcilePins = Effect.gen(function* () {
    if (Option.isNone(checkpointPins) || (yield* trellis.current) === null) return;
    const readAt = yield* DateTime.now;
    const shell = yield* projectionStore.getShellSnapshot();
    // With each thread's workspace assignment: a thread that moved keeps a
    // baseline in every project it worked in.
    const liveThreads = yield* Effect.forEach(
      [...shell.threads, ...shell.archivedThreads].filter((thread) => thread.deletedAt === null),
      (thread) =>
        projectionStore.getThread(thread.id).pipe(
          Effect.map((record) => ({
            id: thread.id,
            workspaceAssignment: record.workspaceAssignment,
          })),
        ),
    );
    yield* checkpointPins.value.reconcile({ liveThreads, readAt });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("could not read threads to reconcile Trellis pins", { cause }),
    ),
  );

  const start: TrellisCatalog["Service"]["start"] = Effect.fn("TrellisCatalog.start")(function* () {
    const fromSequence = yield* applicationEvents.latestApplicationSequence.pipe(
      Effect.orElseSucceed(() => 0),
    );
    yield* forkParked(
      Stream.runForEach(
        applicationEvents.streamApplicationEvents({ afterSequence: fromSequence }),
        (stored) => {
          if (!("aggregateKind" in stored)) {
            switch (stored.event.type) {
              case "thread.deleted":
                return Ref.set(dirty, true).pipe(
                  Effect.andThen(Effect.forkDetach(reconcilePins)),
                  Effect.asVoid,
                );
              case "thread.created":
              case "thread.archived":
              case "thread.unarchived":
              case "thread.project-moved":
                return Ref.set(dirty, true);
              default:
                return Effect.void;
            }
          }
          if (stored.type !== "project.meta-updated") return Ref.set(dirty, true);
          const title = stored.payload.title;
          const fromSync = stored.commandId?.startsWith(SYNC_COMMAND_PREFIX) === true;
          return Ref.set(dirty, true).pipe(
            Effect.andThen(
              title === undefined || fromSync
                ? Effect.void
                : lock
                    .withPermits(1)(pushRename(stored.payload.projectId, title))
                    .pipe(
                      Effect.andThen(syncNow),
                      keepAlive("failed to push a project rename to Trellis"),
                    ),
            ),
          );
        },
      ).pipe(keepAlive("the Trellis catalog stopped following project events")),
    );
    yield* forkParked(
      syncNow.pipe(
        Effect.andThen(resumePendingRestores),
        Effect.repeat(Schedule.spaced(POLL_INTERVAL)),
        Effect.asVoid,
      ),
    );
    // At startup, then now and then: pins of threads deleted while the
    // server was down or Trellis unreachable, and pins left by a crash.
    yield* forkParked(
      reconcilePins.pipe(Effect.repeat(Schedule.spaced(PIN_RECONCILE_INTERVAL)), Effect.asVoid),
    );
  });

  const requireReady = Effect.gen(function* () {
    const env = yield* trellis.discover;
    if (env === null) {
      return yield* new TrellisError({
        message: (yield* trellis.enabled)
          ? "Trellis is not running on this server."
          : "The Trellis integration is turned off on this server.",
      });
    }
    return env;
  });

  const asTrellisError = (prefix: string) =>
    Effect.mapError((error: unknown) =>
      isTrellisError(error)
        ? error
        : new TrellisError({ message: `${prefix}: ${errorMessage(error)}` }),
    );

  // The T3 project for a newly created Trellis item, created directly rather
  // than waiting for the poll. Under the sync lock, so the poll never creates
  // a second project for the same root.
  const projectFor = Effect.fn("TrellisCatalog.projectFor")(function* (item: TrellisProjectView) {
    const root = normalizeRoot(item.path);
    const title = titleOf(item.name, item.path);
    const projectId = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* projectStore.findActiveByWorkspaceRoot(root);
        if (Option.isSome(existing)) return existing.value.projectId;
        const projectId = ProjectId.make(yield* crypto.randomUUIDv4);
        yield* projectService.create({
          commandId: yield* commandId("create"),
          projectId,
          title,
          workspaceRoot: root,
        });
        return projectId;
      }),
    );
    yield* Ref.set(dirty, true);
    return { projectId, workspaceRoot: root, name: title } satisfies TrellisCreateResult;
  }, asTrellisError("Trellis created the item, but its T3 project could not be created"));

  const find: TrellisCatalog["Service"]["find"] = Effect.fn("TrellisCatalog.find")(
    function* (query) {
      const env = yield* requireReady;
      const hits = yield* trellis.find(query);
      const entries = splitFindHits(env.root, hits);
      let ids = (yield* Ref.get(lastApplied))?.ids ?? new Map<string, ProjectId>();
      if (entries.some((entry) => isLive(entry.item) && !ids.has(entry.workspaceRoot))) {
        ids = yield* syncNow;
      }
      return {
        hits: entries.map((entry): TrellisFindHit => ({
          projectId: isLive(entry.item) ? (ids.get(entry.workspaceRoot) ?? null) : null,
          kind: entry.item.kind === "idea" ? "idea" : "project",
          name: entry.title,
          description: entry.item.description,
          path: entry.workspaceRoot,
          matches: entry.matches,
        })),
      };
    },
  );

  const prepareIdeaDraft = Effect.gen(function* () {
    yield* requireReady;
    const existing = yield* projectStore.get(TRELLIS_LANDING_PAD_PROJECT_ID);
    if (Option.isSome(existing)) {
      return {
        projectId: TRELLIS_LANDING_PAD_PROJECT_ID,
        workspaceRoot: existing.value.workspaceRoot,
      } satisfies TrellisIdeaDraftTarget;
    }
    const project = yield* projectService.create({
      commandId: yield* commandId("landing-pad"),
      projectId: TRELLIS_LANDING_PAD_PROJECT_ID,
      title: "New idea",
      workspaceRoot: landingPadRoot,
      createWorkspaceRootIfMissing: true,
    });
    return {
      projectId: TRELLIS_LANDING_PAD_PROJECT_ID,
      workspaceRoot: project.workspaceRoot,
    } satisfies TrellisIdeaDraftTarget;
  }).pipe(landingPadLock.withPermits(1), asTrellisError("Could not prepare a new idea"));

  // Threads of the T3 projects under `scopes` that are running or about to.
  const busyThreadTitlesIn = Effect.fn("TrellisCatalog.busyThreadTitlesIn")(function* (
    scopes: ReadonlyArray<string>,
  ) {
    if (scopes.length === 0) return [];
    const projectIds = new Set(
      (yield* activeProjects)
        .filter((project) =>
          scopes.some((scope) =>
            pathsOverlap(normalizeRoot(scope), normalizeRoot(project.workspaceRoot)),
          ),
        )
        .map((project) => project.id),
    );
    const active = yield* orchestrator.getShellSnapshot({ location: "active" });
    return (
      active.threads
        // `activityRunStatus` also covers a run waiting on its checkpoint
        // capture, which still reads the workspace.
        .filter(
          (thread) =>
            projectIds.has(thread.projectId) &&
            (thread.activeRunId !== null || thread.activityRunStatus != null),
        )
        .map((thread) => thread.title)
    );
  });

  // Archives the active threads of the T3 projects rooted at `roots`. Archiving
  // detaches their provider sessions, as a client archive does.
  const archiveThreadsIn = (roots: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const wanted = new Set(roots.map(normalizeRoot));
      const projectIds = new Set(
        (yield* activeProjects)
          .filter((project) => wanted.has(normalizeRoot(project.workspaceRoot)))
          .map((project) => project.id),
      );
      const active = yield* orchestrator.getShellSnapshot({ location: "active" });
      const failed: Array<string> = [];
      for (const thread of active.threads) {
        if (!projectIds.has(thread.projectId) || thread.archivedAt !== null) continue;
        yield* archiveThread(thread.id).pipe(
          Effect.catch((error) =>
            Effect.logWarning("could not archive a trashed Trellis thread", {
              threadId: thread.id,
              detail: errorMessage(error),
            }).pipe(Effect.andThen(Effect.sync(() => void failed.push(thread.title)))),
          ),
        );
      }
      if (failed.length > 0) {
        return yield* new TrellisError({
          message: `these conversations could not be archived: ${failed.map((title) => `"${title}"`).join(", ")}.`,
        });
      }
    }).pipe(
      Effect.mapError((error) =>
        isTrellisError(error)
          ? error
          : new TrellisError({
              message: `its conversations could not be read to archive them (${errorMessage(error)}).`,
            }),
      ),
    );

  // Releases each live runtime in the trashed roots on its own, so one
  // failure does not leave the others running against a stopped workspace.
  // Live runtimes come from the session manager, not thread bindings: a
  // runtime outlives its archived threads until its idle release. Returns the
  // sessions that could not be released.
  const releaseSessionsEndedByTrash = (input: {
    readonly dedicated: boolean;
    readonly roots: ReadonlyArray<string>;
  }) =>
    Effect.gen(function* () {
      const ended = sessionsEndedByTrash({ ...input, live: yield* providerSessions.listLive });
      if (ended.length === 0) return [];
      yield* Effect.logInfo("releasing the provider sessions of a trashed Trellis workspace", {
        roots: input.roots,
        sessions: ended,
      });
      const failed: Array<(typeof ended)[number]> = [];
      for (const providerSessionId of ended) {
        const released = yield* providerSessions
          .release({
            providerSessionId,
            reason: "manual_shutdown",
            detail: "The workspace was moved to the Trellis trash.",
          })
          .pipe(Effect.result);
        if (released._tag === "Failure") {
          yield* Effect.logWarning("could not release a session of a trashed Trellis workspace", {
            providerSessionId,
            detail: errorMessage(released.failure),
          });
          failed.push(providerSessionId);
        }
      }
      return failed;
    });

  const trashProject: TrellisCatalog["Service"]["trashProject"] = Effect.fn(
    "TrellisCatalog.trashProject",
  )(function* (projectId) {
    yield* requireReady;
    const project = Option.getOrUndefined(
      yield* projectStore.get(projectId).pipe(Effect.orElseSucceed(() => Option.none())),
    );
    if (project === undefined) {
      return yield* new TrellisError({ message: "This project no longer exists." });
    }
    const items = yield* trellis.listProjects({ all: false });
    const target = trashTargetOf(items, project.workspaceRoot);
    if (target === null) {
      return { trashed: null, name: project.title } satisfies TrellisTrashProjectResult;
    }
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
          : item.workspaces
              .filter((workspace) => workspace.deleted_at === null)
              .map((workspace) => workspace.path);
    return yield* trashResolved(target, item, scopes);
  });

  /** Trashes a resolved target: see `trashProject`. */
  const trashResolved = Effect.fn("TrellisCatalog.trashResolved")(function* (
    target: NonNullable<ReturnType<typeof trashTargetOf>>,
    item: TrellisProjectView | undefined,
    scopes: ReadonlyArray<string>,
  ) {
    const { unreleased, archived } = yield* Effect.scoped(
      Effect.gen(function* () {
        // New turns there wait from before the busy check until the trash,
        // the session release, the archive and the sync are done, so none
        // starts in between or is shut down by the release.
        if (Option.isSome(restoreGate)) yield* restoreGate.value.hold(scopes);
        // Trashing moves the files away and stops the workspace, so running
        // agents inside it would lose their work.
        // Unverifiable activity refuses the trash rather than risking a running agent.
        const busy = yield* busyThreadTitlesIn(scopes).pipe(
          Effect.mapError(
            (error) =>
              new TrellisError({
                message: `Could not check whether anything is still working in ${target.name}, so it was not moved to the trash: ${errorMessage(error)}`,
              }),
          ),
        );
        if (busy.length > 0) {
          const one = busy.length === 1;
          return yield* new TrellisError({
            message: `${busy.map((title) => `"${title}"`).join(", ")} ${one ? "is" : "are"} still working in ${target.name}. Wait for ${one ? "it" : "them"} to finish or stop ${one ? "it" : "them"}, then try again.`,
          });
        }
        if (target.kind === "project") yield* trellis.trashProject(target.id);
        else yield* trellis.trashWorkspace(target.id);
        const unreleased = yield* releaseSessionsEndedByTrash({
          dedicated: target.kind === "workspace" || (item !== undefined && item.kind !== "idea"),
          roots: scopes,
        });
        // Archive the conversations here rather than through the sync's time
        // heuristic: a session ending as the workspace stops bumps a thread past
        // the deletion time, which would leave it active.
        // Already in the trash: a failure here leaves conversations active
        // against removed files, so it is reported rather than swallowed.
        const archived = yield* archiveThreadsIn(scopes).pipe(Effect.result);
        yield* syncNow;
        return { unreleased, archived };
      }),
    );
    if (archived._tag === "Failure") {
      return yield* new TrellisError({
        message: `${target.name} is in the Trellis trash, but ${archived.failure.message} Archive them by hand, or restore it from Settings → Trellis.`,
      });
    }
    if (unreleased.length > 0) {
      const one = unreleased.length === 1;
      return yield* new TrellisError({
        message: `${target.name} is in the Trellis trash, but ${unreleased.length} agent ${one ? "session" : "sessions"} running in it could not be stopped, so the next turn there may fail until T3 restarts.`,
      });
    }
    return {
      trashed: target.kind,
      name: target.name,
      restore: {
        kind: target.kind === "project" && item?.kind === "idea" ? "idea" : target.kind,
        id: target.id,
      },
    } satisfies TrellisTrashProjectResult;
  });

  const restoreConflicts = Effect.fn("TrellisCatalog.restoreConflicts")(function* (
    input: TrellisRestoreConflictsInput,
  ) {
    const none: TrellisRestoreConflicts = { running: [], later: [] };
    const projection = yield* orchestrator.getThreadProjection(input.threadId);
    // The checkpoint a revert of this turn count restores, as clients pick it.
    const checkpoint =
      input.checkpointId !== undefined
        ? projection.checkpoints.find((candidate) => candidate.id === input.checkpointId)
        : projection.checkpoints.findLast((candidate) =>
            input.turnCount === 0
              ? candidate.ordinalWithinScope === 0 && candidate.appRunOrdinal === null
              : candidate.appRunOrdinal === input.turnCount,
          );
    const requestedScope = projection.checkpointScopes.find(
      (candidate) => candidate.id === checkpoint?.scopeId,
    );
    if (checkpoint === undefined || requestedScope === undefined) return none;
    // Where the files would come back, as the revert resolves it; a turn from
    // before the thread moved restores nothing here (the revert refuses).
    const target = fileRestoreTargetOf({
      thread: projection.thread,
      checkpoint,
      scope: requestedScope,
      checkpoints: projection.checkpoints,
      scopes: projection.checkpointScopes,
    });
    if (target === null) return none;
    const scope = target.scope;
    const restoreScope = yield* restoreScopeOf(trellis, scope.cwd);
    if (restoreScope === null) return none;
    return yield* restoreConflictsIn(
      trellis,
      {
        shell: projectionStore.getShellSnapshot(),
        records: (threadId) => projectionStore.getThreadRecords(threadId, ["runs"]),
        captureOutstanding: captureOutstandingIn(effectOutbox),
        projectRoot: (projectId) =>
          projectStore
            .get(projectId)
            .pipe(Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot)),
      },
      {
        threadId: input.threadId,
        scopePath: restoreScope.path,
        since: target.checkpoint.capturedAt,
      },
    );
  });

  // Restoring also unarchives the conversations archived when the item went
  // to the trash (archived since then), the reverse of retiring it. Trellis
  // forgets the deletion time as soon as it restores, so the restore is
  // recorded in a file first and its unarchives resumed until they finish:
  // on a retried restore and on every poll.
  const pendingRestoresPath = NodePath.join(serverConfig.stateDir, "trellis-pending-restores.json");
  const restoreLock = yield* Semaphore.make(1);
  const decodePendingRestores = Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Array(PendingRestore)),
  );
  const encodePendingRestores = Schema.encodeEffect(
    Schema.fromJsonString(Schema.Array(PendingRestore)),
  );
  const readPendingRestores = Effect.gen(function* () {
    if (!(yield* fileSystem.exists(pendingRestoresPath))) return [];
    return yield* decodePendingRestores(yield* fileSystem.readFileString(pendingRestoresPath));
  });
  const writePendingRestores = (records: ReadonlyArray<PendingRestore>) =>
    Effect.gen(function* () {
      const partial = `${pendingRestoresPath}.partial`;
      yield* fileSystem.writeFileString(partial, yield* encodePendingRestores(records));
      yield* fileSystem.rename(partial, pendingRestoresPath);
    });
  const updatePendingRestores = (
    update: (records: ReadonlyArray<PendingRestore>) => ReadonlyArray<PendingRestore>,
  ) => readPendingRestores.pipe(Effect.flatMap((records) => writePendingRestores(update(records))));

  const liveRoots = (item: TrellisProjectView) =>
    item.kind === "idea" || item.workspaces.length === 0
      ? [item.path]
      : item.workspaces
          .filter((workspace) => workspace.deleted_at === null)
          .map((workspace) => workspace.path);

  /**
   * Unarchives what a recorded restore brings back, then drops the record.
   * Waits while Trellis still has the item in its trash (not restored yet);
   * drops it when the item is gone for good.
   */
  const finishRestore = Effect.fn("TrellisCatalog.finishRestore")(function* (
    record: PendingRestore,
  ) {
    const env = yield* requireReady;
    const items = yield* trellis.listProjects({ all: false });
    let roots: ReadonlyArray<string> | null;
    if (record.kind === "workspace") {
      const live = items.some((item) =>
        item.workspaces.some(
          (workspace) => workspace.id === record.id && workspace.deleted_at === null,
        ),
      );
      const owner = items.find((item) => item.id === record.ownerId);
      roots = !live
        ? null
        : owner !== undefined
          ? liveRoots(owner)
          : [NodePath.posix.join(env.root, "workspaces", record.id, "project")];
    } else {
      const item = items.find((entry) => entry.id === record.id);
      roots = item === undefined ? null : liveRoots(item);
    }
    if (roots === null) {
      const trash = yield* trellis.listTrash;
      const trashed = [...trash.projects, ...trash.workspaces].some(
        (entry) => entry.id === record.id,
      );
      if (!trashed) yield* updatePendingRestores((all) => all.filter((r) => r.id !== record.id));
      return;
    }
    // The record goes only once every restored root has its project and
    // every unarchive succeeded; anything less fails and keeps it.
    const ids = yield* syncStrict;
    const unresolved = roots.filter((entry) => !ids.has(normalizeRoot(entry)));
    if (unresolved.length > 0) {
      return yield* new TrellisError({
        message: `The restored ${unresolved.join(", ")} has no T3 project yet; its conversations will be unarchived on the next sync.`,
      });
    }
    const restoredProjectIds = new Set(roots.map((entry) => ids.get(normalizeRoot(entry))!));
    const archived = (yield* orchestrator.getShellSnapshot({ location: "archive" }))
      .archivedThreads;
    for (const thread of archived) {
      if (
        restoredProjectIds.has(thread.projectId) &&
        thread.archivedAt !== null &&
        DateTime.toEpochMillis(thread.archivedAt) >= record.deletedAt * 1000
      ) {
        yield* orchestrator.dispatch({
          type: "thread.unarchive",
          commandId: yield* commandId("restore-unarchive"),
          threadId: thread.id,
        });
      }
    }
    yield* updatePendingRestores((all) => all.filter((r) => r.id !== record.id));
  });

  /** Resumes the unarchives of restores a crash or failure left unfinished. Never fails. */
  const resumePendingRestores = restoreLock.withPermits(1)(
    Effect.gen(function* () {
      for (const record of yield* readPendingRestores) {
        yield* finishRestore(record).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("could not finish restoring a Trellis item", {
              id: record.id,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not read the pending Trellis restores", {
          cause: Cause.pretty(cause),
        }),
      ),
    ),
  );

  const restore = Effect.fn("TrellisCatalog.restore")(
    function* (input: TrellisRestoreInput) {
      const env = yield* requireReady;
      const trash = yield* trellis.listTrash;
      const entry = [...trash.projects, ...trash.workspaces].find((item) => item.id === input.id);
      // A fork whose project is trashed brings the project back first, and
      // with it the project's other workspaces; a fork of a live project
      // only itself.
      const ownerId =
        input.kind === "workspace" &&
        entry?.project_id != null &&
        trash.projects.some((project) => project.id === entry.project_id)
          ? entry.project_id
          : null;
      const recorded = (yield* readPendingRestores).find((record) => record.id === input.id);
      const record: PendingRestore | undefined =
        entry?.deleted_at != null
          ? { id: input.id, kind: input.kind, deletedAt: entry.deleted_at, ownerId }
          : recorded;
      if (record !== undefined && record !== recorded) {
        yield* updatePendingRestores((all) => [...all.filter((r) => r.id !== record.id), record]);
      }
      let root: string;
      if (input.kind === "workspace") {
        yield* trellis.restoreWorkspace(input.id);
        root = NodePath.posix.join(env.root, "workspaces", input.id, "project");
      } else {
        root = (yield* trellis.restoreProject(input.id)).path;
      }
      if (record !== undefined) yield* finishRestore(record);
      const ids = yield* syncNow;
      return { projectId: ids.get(normalizeRoot(root)) ?? null } satisfies TrellisRestoreResult;
    },
    (effect) => restoreLock.withPermits(1)(effect),
  );

  // Moves an idea that never got a thread back out of the catalog.
  const discardIdea = (trellisId: string) =>
    trellis.trashProject(trellisId).pipe(
      Effect.andThen(syncNow),
      Effect.tap(() => Effect.logInfo("discarded an unused Trellis idea", { trellisId })),
      Effect.catch((error) =>
        Effect.logWarning("could not discard an unused Trellis idea", {
          trellisId,
          detail: error.message,
        }),
      ),
      Effect.asVoid,
    );

  const checkProjectDelete = Effect.fn("TrellisCatalog.checkProjectDelete")(function* (
    projectId: ProjectId,
  ) {
    // Only a project that is really not there passes; a failed read refuses.
    const row = yield* projectStore.get(projectId).pipe(
      Effect.mapError(
        (error) =>
          new TrellisError({
            message: `Could not read the project, so it was not removed: ${error.message}`,
          }),
      ),
    );
    if (Option.isNone(row)) return;
    const root = normalizeRoot(row.value.workspaceRoot);
    const roots = yield* trellis.expectedRoots;
    if (!roots.some((trellisRoot) => isTrellisManagedPath(trellisRoot, root))) return;
    const env = yield* trellis.refresh;
    if (env === null) {
      return yield* new TrellisError({
        message: `"${row.value.title}" is a Trellis project, and Trellis is off or not running. Turn it on or start it (Settings → Trellis), then move the project to the Trellis trash.`,
      });
    }
    if (!isTrellisManagedPath(env.root, root)) {
      return yield* new TrellisError({
        message: `"${row.value.title}" belongs to an earlier Trellis root than the running one (${env.root}), so it cannot go to the Trellis trash; removing only its T3 entry would delete its conversations.`,
      });
    }
    const items = yield* trellis.listProjects({ all: false });
    if (trashTargetOf(items, root) !== null) {
      return yield* new TrellisError({
        message: `"${row.value.title}" is a Trellis project: move it to the Trellis trash instead (project settings → Move to trash), which archives its conversations and can be restored. Removing only its T3 entry would delete them, and the project would come back.`,
      });
    }
  });

  const threadTitles = orchestrator.getShellSnapshot().pipe(
    Effect.map(
      (shell) =>
        new Map(
          [...shell.threads, ...shell.archivedThreads].map((thread) => [thread.id, thread.title]),
        ) as ReadonlyMap<string, string>,
    ),
    Effect.orElseSucceed((): ReadonlyMap<string, string> => new Map()),
  );

  const listWorkspaces = Effect.fn("TrellisCatalog.listWorkspaces")(function* (
    projectId: ProjectId,
  ) {
    yield* requireReady;
    const none: TrellisWorkspaceList = { trellisProjectId: null, items: [] };
    const project = Option.getOrUndefined(yield* projectStore.get(projectId));
    if (project === undefined) return none;
    const resolved = yield* trellis
      .resolve(project.workspaceRoot)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const item = resolved?.project ?? null;
    if (item === null || item.kind === "idea") return none;
    const [workspaces, trash, titles] = yield* Effect.all([
      trellis.listWorkspaces({ all: true }),
      trellis.listTrash,
      threadTitles,
    ]);
    let ids = (yield* Ref.get(lastApplied))?.ids ?? new Map<string, ProjectId>();
    const live = workspaces.filter(
      (workspace) => workspace.project_id === item.id && workspace.deleted_at === null,
    );
    if (live.some((workspace) => !ids.has(normalizeRoot(workspace.path)))) ids = yield* syncNow;
    return {
      trellisProjectId: item.id,
      items: workspaceEntries({
        trellisProjectId: item.id,
        primaryWorkspaceId: item.workspace_id,
        workspaces,
        trash,
        projectIds: ids,
        titles,
      }),
    } satisfies TrellisWorkspaceList;
  });

  const listCheckpoints = Effect.fn("TrellisCatalog.listCheckpoints")(function* (
    workspaceId: string,
  ) {
    yield* requireReady;
    const snapshots = yield* trellis.listSnapshots(workspaceId);
    return snapshots
      .filter((snapshot) => snapshot.kind === "checkpoint")
      .map((snapshot): TrellisCheckpointEntry => ({
        id: snapshot.id,
        label: snapshot.label ?? null,
        createdAt: snapshot.created_at,
      }))
      .toReversed();
  });

  const forkWorkspace = Effect.fn("TrellisCatalog.forkWorkspace")(function* (
    input: TrellisForkWorkspaceInput,
  ) {
    yield* requireReady;
    // No thread: a visible fork whose threads are leads.
    const fork = yield* trellis.fork({
      target: input.workspaceId,
      snapshot: input.snapshot,
      name: input.name,
    });
    const ids = yield* syncNow;
    return {
      workspaceId: fork.id,
      name: fork.name,
      projectId: ids.get(normalizeRoot(fork.path)) ?? null,
      warnings: fork.warnings ?? [],
    } satisfies TrellisForkWorkspaceResult;
  });

  const discardFork = Effect.fn("TrellisCatalog.discardFork")(function* (workspaceId: string) {
    yield* requireReady;
    const items = yield* trellis.listProjects({ all: false });
    const item = items.find((entry) =>
      entry.workspaces.some(
        (workspace) => workspace.id === workspaceId && workspace.deleted_at === null,
      ),
    );
    const workspace = item?.workspaces.find((entry) => entry.id === workspaceId);
    if (item === undefined || workspace === undefined) return false;
    if (workspace.id === item.workspace_id) {
      return yield* new TrellisError({
        message: `${workspace.name} is the project's own workspace, not a fork.`,
      });
    }
    const target = trashTargetOf(items, workspace.path);
    if (target === null) return false;
    yield* trashResolved(target, item, [workspace.path]);
    return true;
  });

  // Base builds in progress, by base name; see `buildBase` in the shape.
  const baseBuilds = new Map<string, Deferred.Deferred<TrellisBuildBaseResult, TrellisError>>();
  // A failed build's error, kept for the settings page (its caller may be
  // gone) until a later build succeeds or Trellis reports the base in another
  // state than when it failed (rebuilt from the CLI). `state` is the base's
  // state as last read, undefined until a details read sees it.
  const baseBuildFailures = new Map<
    string,
    { readonly message: string; state: string | null | undefined }
  >();
  const lastBaseStates = new Map<string, string | null>();
  const buildBase = Effect.fn("TrellisCatalog.buildBase")(function* (name: string) {
    yield* requireReady;
    const fresh = yield* Deferred.make<TrellisBuildBaseResult, TrellisError>();
    // Looked up and registered without yielding in between, and forked
    // uninterruptibly, so concurrent requests start one build.
    const running = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const existing = baseBuilds.get(name);
        if (existing !== undefined) return existing;
        baseBuilds.set(name, fresh);
        baseBuildFailures.delete(name);
        yield* trellis.buildBase(name).pipe(
          Effect.tapError((error) =>
            Effect.sync(
              () =>
                void baseBuildFailures.set(name, {
                  message: error.message,
                  state: lastBaseStates.has(name) ? lastBaseStates.get(name) : undefined,
                }),
            ).pipe(
              Effect.andThen(
                Effect.logWarning("Trellis base build failed", {
                  base: name,
                  detail: error.message,
                }),
              ),
            ),
          ),
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(fresh, exit)),
          Effect.ensuring(Effect.sync(() => void baseBuilds.delete(name))),
          Effect.forkDetach,
        );
        return fresh;
      }),
    );
    return yield* Deferred.await(running);
  });

  return TrellisCatalog.of({
    start,
    checkProjectDelete,
    listWorkspaces: (projectId) =>
      listWorkspaces(projectId).pipe(asTrellisError("Could not list the workspaces")),
    listCheckpoints: (workspaceId) =>
      listCheckpoints(workspaceId).pipe(asTrellisError("Could not list the checkpoints")),
    forkWorkspace: (input) =>
      forkWorkspace(input).pipe(asTrellisError("Could not fork the workspace")),
    purge: (ids) =>
      requireReady.pipe(
        Effect.andThen(trellis.purge(ids)),
        Effect.tap(() => Ref.set(dirty, true)),
      ),
    discardFork: (workspaceId) =>
      discardFork(workspaceId).pipe(asTrellisError("Could not discard the fork")),
    syncNow,
    status: Effect.gen(function* () {
      let connection = yield* trellis.connection;
      if (connection.state === "unavailable") {
        yield* trellis.refresh;
        connection = yield* trellis.connection;
      }
      const applied = yield* Ref.get(lastApplied);
      return {
        state: connection.state,
        ...(connection.root === null ? {} : { root: connection.root }),
        knownRoots: yield* trellis.expectedRoots,
        socketPath: connection.socketPath,
        // Kept while Trellis is off or down, so retired projects stay hidden.
        ...(applied === null
          ? {}
          : {
              retiredRoots: applied.retiredRoots,
              forkRoots: desiredProjects(applied.items)
                .filter((entry) => !entry.primary)
                .map((entry) => entry.workspaceRoot),
              workerRoots: workerRoots(applied.items),
            }),
      } satisfies TrellisStatus;
    }),
    newIdea: (input) =>
      requireReady.pipe(Effect.andThen(trellis.createIdea(input)), Effect.flatMap(projectFor)),
    createIdeaForDraft: requireReady.pipe(
      Effect.andThen(trellis.createIdea({})),
      Effect.flatMap((item) =>
        projectFor(item).pipe(
          Effect.map((result) => ({ ...result, trellisId: item.id })),
          // Without a T3 project the idea is unreachable: take it back.
          Effect.tapError(() => discardIdea(item.id)),
        ),
      ),
    ),
    discardIdea,
    newProject: (input) =>
      requireReady.pipe(Effect.andThen(trellis.createProject(input)), Effect.flatMap(projectFor)),
    prepareIdeaDraft,
    trashProject: (projectId) =>
      trashProject(projectId).pipe(asTrellisError("Could not move the project to the trash")),
    listTrash: requireReady.pipe(
      Effect.andThen(Effect.all([trellis.listTrash, threadTitles])),
      Effect.map(([view, titles]) => trashItems(view, titles)),
    ),
    restore: (input) => restore(input).pipe(asTrellisError("Could not restore it")),
    emptyTrash: requireReady.pipe(Effect.andThen(trellis.emptyTrash)),
    find: (query) => find(query).pipe(asTrellisError("Trellis find failed")),
    restoreConflicts: (input) =>
      restoreConflicts(input).pipe(asTrellisError("Could not check the restore")),
    projectFor,
    listBases: requireReady.pipe(Effect.andThen(trellis.bases)),
    buildBase,
    setPreviewHost: (setting) => requireReady.pipe(Effect.andThen(trellis.setPreviewHost(setting))),
    details: requireReady.pipe(
      Effect.andThen(Effect.all([trellis.details, Ref.get(lastApplied)])),
      Effect.map(([details, applied]) => {
        for (const base of details.bases) {
          const state = details.baseStates?.[base] ?? null;
          lastBaseStates.set(base, state);
          const failure = baseBuildFailures.get(base);
          if (failure === undefined) continue;
          if (failure.state === undefined) failure.state = state;
          // Built since by other means: no longer failed.
          else if (failure.state !== state) baseBuildFailures.delete(base);
        }
        return {
          ...nameDetailsWorkspaces(details, applied?.items ?? []),
          buildingBases: [...baseBuilds.keys()],
          baseBuildFailures: Object.fromEntries(
            [...baseBuildFailures].map(([base, failure]) => [base, failure.message]),
          ),
        };
      }),
    ),
    historySettings: requireReady.pipe(Effect.andThen(trellis.historySettings)),
    updateHistorySettings: (values) =>
      requireReady.pipe(Effect.andThen(trellis.updateHistorySettings(values))),
    runMaintenance: requireReady.pipe(Effect.andThen(trellis.runMaintenance)),
    profile: (target) => requireReady.pipe(Effect.andThen(trellis.profile(target))),
  });
});

export const layer = Layer.effect(TrellisCatalog, make).pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, EffectOutbox.layer)),
);
