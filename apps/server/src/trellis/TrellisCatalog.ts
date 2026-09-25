// @effect-diagnostics nodeBuiltinImport:off
/**
 * TrellisCatalog - keeps one T3 project per Trellis workspace path and serves
 * the client-facing Trellis operations.
 *
 * Trellis is the source of truth for names. The sync polls the Trellis
 * catalog, creates missing T3 projects (matched by `workspaceRoot`, so it never
 * duplicates), renames them to the Trellis name, and retires projects whose
 * Trellis item was trashed or graduated. A user rename in T3 is pushed to
 * Trellis (which pins the name) instead of being overwritten.
 *
 * @module trellis/TrellisCatalog
 */
import * as NodePath from "node:path";

import {
  CommandId,
  ProjectId,
  type ThreadId,
  TrellisError,
  type TrellisCreateResult,
  type TrellisFindResult,
  type TrellisStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { isTrellisManagedPath, Trellis, TrellisProjectView } from "./Trellis.ts";

const POLL_INTERVAL = "3 seconds";
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

  // Paths of trashed or graduated items, and workspace roots of workspaces
  // that no longer exist (trashed forks disappear from the listing).
  const retiredRoots = new Set<string>();
  const liveWorkspaceIds = new Set<string>();
  for (const item of input.items) {
    if (isLive(item)) {
      liveWorkspaceIds.add(item.workspace_id);
      for (const workspace of item.workspaces) liveWorkspaceIds.add(workspace.id);
    } else {
      retiredRoots.add(normalizeRoot(item.path));
      for (const workspace of item.workspaces) retiredRoots.add(normalizeRoot(workspace.path));
    }
  }
  const workspacesDir = NodePath.posix.join(input.root, "workspaces");
  for (const [root, project] of projectsByRoot) {
    if (desiredRoots.has(root) || !isTrellisManagedPath(input.root, root)) continue;
    const relative = NodePath.posix.relative(workspacesDir, root).split("/");
    const goneWorkspace =
      relative.length === 2 && relative[1] === "project" && !liveWorkspaceIds.has(relative[0]!);
    if (!retiredRoots.has(root) && !goneWorkspace) continue;
    const threads = input.threads.filter((thread) => thread.projectId === project.id);
    const archiveThreadIds = threads
      .filter((thread) => !thread.archived)
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

export class TrellisCatalog extends Context.Service<
  TrellisCatalog,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Runs one sync pass and returns the T3 project id for each synced workspace root. */
    readonly syncNow: Effect.Effect<ReadonlyMap<string, ProjectId>>;
    readonly status: Effect.Effect<TrellisStatus>;
    readonly newIdea: (input: {
      readonly name?: string | undefined;
    }) => Effect.Effect<TrellisCreateResult, TrellisError>;
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
      })),
      ...archived.threads.map((thread) => ({
        id: thread.id,
        projectId: thread.projectId,
        archived: true,
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
    yield* Ref.set(dirty, false);
    const t3 = yield* readT3;
    const ids = new Map<string, ProjectId>();
    for (const project of t3.projects) ids.set(normalizeRoot(project.workspaceRoot), project.id);
    const actions = planCatalogSync({
      root: env.root,
      items,
      projects: t3.projects,
      threads: t3.threads,
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
                        Effect.catch((error) =>
                          Effect.logWarning("failed to push project rename to Trellis", {
                            projectId: event.payload.projectId,
                            detail: error.message,
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
      const hits = yield* trellis.find(query);
      const idFor = (ids: ReadonlyMap<string, ProjectId>, path: string) =>
        ids.get(normalizeRoot(path)) ?? null;
      let ids = (yield* Ref.get(lastApplied))?.ids ?? new Map<string, ProjectId>();
      if (hits.some((hit) => isLive(hit.project) && idFor(ids, hit.project.path) === null)) {
        ids = yield* syncNow;
      }
      return {
        hits: hits.map((hit) => ({
          projectId: isLive(hit.project) ? idFor(ids, hit.project.path) : null,
          kind: hit.project.kind === "idea" ? ("idea" as const) : ("project" as const),
          name: hit.project.name,
          description: hit.project.description,
          path: hit.project.path,
          matches: hit.matches,
        })),
      };
    },
  );

  return TrellisCatalog.of({
    start,
    syncNow,
    status: trellis.current.pipe(
      Effect.map((env) =>
        env === null ? { available: false } : { available: true, root: env.root },
      ),
    ),
    newIdea: (input) => trellis.createIdea(input).pipe(Effect.flatMap(created)),
    newProject: (input) => trellis.createProject(input).pipe(Effect.flatMap(created)),
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
    status: Effect.succeed({ available: false }),
    newIdea: unavailable,
    newProject: unavailable,
    find: unavailable,
  }),
);
