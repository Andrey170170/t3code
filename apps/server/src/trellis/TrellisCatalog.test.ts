import {
  ProjectId,
  ThreadId,
  TRELLIS_LANDING_PAD_PROJECT_ID,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
  type ProviderSession,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  isTrellisManagedPath,
  makeTestTrellis,
  Trellis,
  type TrellisProjectView,
  type TrellisWorkspaceView,
} from "./Trellis.ts";
import * as TrellisCatalog from "./TrellisCatalog.ts";

const ROOT = "/trellis";
const SCRATCH = `${ROOT}/workspaces/ws-scratch/project`;

const workspace = (id: string, name = "main"): TrellisWorkspaceView => ({
  id,
  kind: id === "ws-scratch" ? "scratch" : "dedicated",
  name,
  path: `${ROOT}/workspaces/${id}/project`,
  deleted_at: null,
});
const noDeletedWorkspaces: ReadonlyMap<string, number> = new Map();
// Before the retirement times (100 s) used below.
const EARLY = "1970-01-01T00:00:10.000Z";

const idea = (
  id: string,
  name: string,
  overrides: Partial<TrellisProjectView> = {},
): TrellisProjectView => ({
  id,
  kind: "idea",
  name,
  description: "",
  workspace_id: "ws-scratch",
  path: `${SCRATCH}/${id}`,
  updated_at: 0,
  deleted_at: null,
  graduated_to: null,
  workspaces: [workspace("ws-scratch", "scratch")],
  ...overrides,
});

const dedicated = (
  id: string,
  name: string,
  workspaces: ReadonlyArray<TrellisWorkspaceView>,
  overrides: Partial<TrellisProjectView> = {},
): TrellisProjectView => ({
  id,
  kind: "project",
  name,
  description: "",
  workspace_id: workspaces[0]?.id ?? "ws-gone",
  path: workspaces[0]?.path ?? `${ROOT}/workspaces/ws-gone/project`,
  updated_at: 0,
  deleted_at: null,
  graduated_to: null,
  workspaces,
  ...overrides,
});

const project = (id: string, workspaceRoot: string, title = id) => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot,
});

describe("planCatalogSync", () => {
  it("creates one project per idea, primary workspace and fork", () => {
    const actions = TrellisCatalog.planCatalogSync({
      root: ROOT,
      items: [
        idea("idea-a", "Sketch"),
        dedicated("prj-b", "Engine", [workspace("ws-b"), workspace("ws-b2", "experiment")]),
      ],
      projects: [],
      threads: [],
      deletedWorkspaces: noDeletedWorkspaces,
    });
    expect(actions).toEqual([
      { type: "create", workspaceRoot: `${SCRATCH}/idea-a`, title: "Sketch" },
      { type: "create", workspaceRoot: `${ROOT}/workspaces/ws-b/project`, title: "Engine" },
      {
        type: "create",
        workspaceRoot: `${ROOT}/workspaces/ws-b2/project`,
        title: "Engine · experiment",
      },
    ]);
  });

  it("matches existing projects by workspace root and only renames them", () => {
    const actions = TrellisCatalog.planCatalogSync({
      root: ROOT,
      items: [
        idea("idea-a", "Sketch"),
        dedicated("prj-b", "Engine", [workspace("ws-b"), workspace("ws-b2", "experiment")]),
      ],
      projects: [
        project("p-a", `${SCRATCH}/idea-a/`, "Sketch"),
        project("p-b", `${ROOT}/workspaces/ws-b/project`, "Old name"),
        project("p-b2", `${ROOT}/workspaces/ws-b2/project`, "Engine · experiment"),
      ],
      threads: [],
      deletedWorkspaces: noDeletedWorkspaces,
    });
    expect(actions).toEqual([
      { type: "rename", projectId: ProjectId.make("p-b"), title: "Engine" },
    ]);
  });

  it("archives the threads of trashed or graduated items and deletes empty projects", () => {
    const actions = TrellisCatalog.planCatalogSync({
      root: ROOT,
      items: [
        idea("idea-trashed", "Trashed", { deleted_at: 100 }),
        idea("idea-graduated", "Graduated", { graduated_to: "prj-new", updated_at: 100 }),
        dedicated("prj-new", "Graduated", [workspace("ws-new")]),
      ],
      projects: [
        project("p-trashed", `${SCRATCH}/idea-trashed`),
        project("p-graduated", `${SCRATCH}/idea-graduated`),
        project("p-new", `${ROOT}/workspaces/ws-new/project`, "Graduated"),
      ],
      threads: [
        {
          id: ThreadId.make("t-1"),
          projectId: ProjectId.make("p-trashed"),
          archived: false,
          updatedAt: EARLY,
        },
        {
          id: ThreadId.make("t-2"),
          projectId: ProjectId.make("p-trashed"),
          archived: true,
          updatedAt: EARLY,
        },
      ],
      deletedWorkspaces: noDeletedWorkspaces,
    });
    expect(actions).toEqual([
      {
        type: "retire",
        projectId: ProjectId.make("p-trashed"),
        archiveThreadIds: [ThreadId.make("t-1")],
        deleteProject: false,
      },
      {
        type: "retire",
        projectId: ProjectId.make("p-graduated"),
        archiveThreadIds: [],
        deleteProject: true,
      },
    ]);
  });

  it("retires a trashed fork by archiving its threads, then leaves it alone", () => {
    const input = {
      root: ROOT,
      items: [dedicated("prj-b", "Engine", [workspace("ws-b")])],
      projects: [
        project("p-b", `${ROOT}/workspaces/ws-b/project`, "Engine"),
        project("p-fork", `${ROOT}/workspaces/ws-fork/project`, "Engine · fork"),
      ],
      deletedWorkspaces: new Map([["ws-fork", 100]]),
    };
    expect(
      TrellisCatalog.planCatalogSync({
        ...input,
        threads: [
          {
            id: ThreadId.make("t-1"),
            projectId: ProjectId.make("p-fork"),
            archived: false,
            updatedAt: EARLY,
          },
        ],
      }),
    ).toEqual([
      {
        type: "retire",
        projectId: ProjectId.make("p-fork"),
        archiveThreadIds: [ThreadId.make("t-1")],
        deleteProject: false,
      },
    ]);
    // After archiving there is nothing left to do; the threads are kept.
    expect(
      TrellisCatalog.planCatalogSync({
        ...input,
        threads: [
          {
            id: ThreadId.make("t-1"),
            projectId: ProjectId.make("p-fork"),
            archived: true,
            updatedAt: EARLY,
          },
        ],
      }),
    ).toEqual([]);
  });

  it("does not re-archive a thread unarchived or used after the item was trashed", () => {
    const actions = TrellisCatalog.planCatalogSync({
      root: ROOT,
      items: [idea("idea-trashed", "Trashed", { deleted_at: 100 })],
      projects: [project("p-trashed", `${SCRATCH}/idea-trashed`)],
      threads: [
        {
          id: ThreadId.make("t-old"),
          projectId: ProjectId.make("p-trashed"),
          archived: false,
          updatedAt: EARLY,
        },
        {
          id: ThreadId.make("t-unarchived"),
          projectId: ProjectId.make("p-trashed"),
          archived: false,
          updatedAt: "1970-01-01T00:05:00.000Z",
        },
      ],
      deletedWorkspaces: noDeletedWorkspaces,
    });
    expect(actions).toEqual([
      {
        type: "retire",
        projectId: ProjectId.make("p-trashed"),
        archiveThreadIds: [ThreadId.make("t-old")],
        deleteProject: false,
      },
    ]);
    // Once the old thread is archived, the unarchived one is left alone.
    expect(
      TrellisCatalog.planCatalogSync({
        root: ROOT,
        items: [idea("idea-trashed", "Trashed", { deleted_at: 100 })],
        projects: [project("p-trashed", `${SCRATCH}/idea-trashed`)],
        threads: [
          {
            id: ThreadId.make("t-old"),
            projectId: ProjectId.make("p-trashed"),
            archived: true,
            updatedAt: EARLY,
          },
          {
            id: ThreadId.make("t-unarchived"),
            projectId: ProjectId.make("p-trashed"),
            archived: false,
            updatedAt: "1970-01-01T00:05:00.000Z",
          },
        ],
        deletedWorkspaces: noDeletedWorkspaces,
      }),
    ).toEqual([]);
  });

  it("does not retire a workspace root only because the listing omits it", () => {
    const input = {
      root: ROOT,
      items: [],
      projects: [project("p-b", `${ROOT}/workspaces/ws-b/project`, "Engine")],
    };
    expect(TrellisCatalog.unlistedWorkspaceIds(input)).toEqual(["ws-b"]);
    expect(
      TrellisCatalog.planCatalogSync({
        ...input,
        threads: [],
        deletedWorkspaces: noDeletedWorkspaces,
      }),
    ).toEqual([]);
  });

  it("never retires the shared scratch root when an idea is trashed", () => {
    expect(
      TrellisCatalog.planCatalogSync({
        root: ROOT,
        items: [idea("idea-trashed", "Trashed", { deleted_at: 100 })],
        projects: [project("p-scratch", SCRATCH)],
        threads: [],
        deletedWorkspaces: noDeletedWorkspaces,
      }),
    ).toEqual([]);
  });

  it("never touches projects outside Trellis project paths or unknown idea folders", () => {
    const actions = TrellisCatalog.planCatalogSync({
      root: ROOT,
      items: [],
      projects: [
        project("p-host", "/home/me/code"),
        project("p-subfolder", `${SCRATCH}/some-folder`),
        project("p-rootfs", `${ROOT}/workspaces/ws-x/rootfs`),
      ],
      threads: [],
      deletedWorkspaces: noDeletedWorkspaces,
    });
    expect(actions).toEqual([]);
  });
});

describe("trashTargetOf", () => {
  const forked = dedicated("prj-a", "App", [workspace("ws-a"), workspace("ws-b", "experiment")]);

  it("trashes the whole item from an idea or primary workspace, one fork from a fork", () => {
    expect(TrellisCatalog.trashTargetOf([idea("idea-a", "Sketch")], `${SCRATCH}/idea-a/`)).toEqual({
      kind: "project",
      id: "idea-a",
      name: "Sketch",
    });
    expect(TrellisCatalog.trashTargetOf([forked], `${ROOT}/workspaces/ws-a/project`)).toEqual({
      kind: "project",
      id: "prj-a",
      name: "App",
    });
    expect(TrellisCatalog.trashTargetOf([forked], `${ROOT}/workspaces/ws-b/project`)).toEqual({
      kind: "workspace",
      id: "ws-b",
      name: "App · experiment",
    });
  });

  it("finds nothing for host folders or items already in the trash", () => {
    expect(TrellisCatalog.trashTargetOf([forked], "/home/me/code")).toBeNull();
    expect(
      TrellisCatalog.trashTargetOf(
        [idea("idea-a", "Sketch", { deleted_at: 100 })],
        `${SCRATCH}/idea-a`,
      ),
    ).toBeNull();
  });
});

describe("splitFindHits", () => {
  it("opens the workspace that matched rather than the project's primary one", () => {
    const item = dedicated("prj-a", "App", [workspace("ws-a"), workspace("ws-b", "experiment")]);
    const entries = TrellisCatalog.splitFindHits(ROOT, [
      {
        project: item,
        matches: [
          { path: `${ROOT}/workspaces/ws-b/project/src/unique.ts`, snippet: "only in the fork" },
        ],
      },
    ]);
    expect(entries.map((entry) => [entry.workspaceRoot, entry.title])).toEqual([
      [`${ROOT}/workspaces/ws-b/project`, "App · experiment"],
    ]);
  });

  it("keeps one entry per matching workspace and uses the primary for name matches", () => {
    const item = dedicated("prj-a", "App", [workspace("ws-a"), workspace("ws-b", "experiment")]);
    const both = TrellisCatalog.splitFindHits(ROOT, [
      {
        project: item,
        matches: [
          { path: `${ROOT}/workspaces/ws-a/project/a.md`, snippet: "a" },
          { path: `${ROOT}/workspaces/ws-b/project/b.md`, snippet: "b" },
        ],
      },
      { project: idea("idea-a", "Sketch"), matches: [] },
    ]);
    expect(both.map((entry) => entry.workspaceRoot)).toEqual([
      `${ROOT}/workspaces/ws-a/project`,
      `${ROOT}/workspaces/ws-b/project`,
      `${SCRATCH}/idea-a`,
    ]);
    const nameOnly = TrellisCatalog.splitFindHits(ROOT, [{ project: item, matches: [] }]);
    expect(nameOnly.map((entry) => entry.workspaceRoot)).toEqual([
      `${ROOT}/workspaces/ws-a/project`,
    ]);
  });
});

describe("trashItems", () => {
  it("folds forks trashed with their project and lists earlier-trashed forks", () => {
    const items = TrellisCatalog.trashItems({
      projects: [
        { id: "idea-a", kind: "idea", name: "Sketch", deleted_at: 1_000 },
        { id: "prj-a", kind: "project", name: "App", deleted_at: 2_000 },
      ],
      workspaces: [
        { id: "ws-a", kind: "dedicated", name: "main", project_id: "prj-a", deleted_at: 2_000 },
        { id: "ws-old", kind: "dedicated", name: "old", project_id: "prj-a", deleted_at: 1_500 },
        { id: "ws-c", kind: "dedicated", name: "try", project_id: "prj-live", deleted_at: 3_000 },
      ],
      idea_expiry_days: 30,
    });
    expect(items).toEqual([
      { kind: "workspace", id: "ws-c", name: "try", deletedAt: 3_000, expiresAt: null },
      { kind: "project", id: "prj-a", name: "App", deletedAt: 2_000, expiresAt: null },
      { kind: "workspace", id: "ws-old", name: "old", deletedAt: 1_500, expiresAt: null },
      {
        kind: "idea",
        id: "idea-a",
        name: "Sketch",
        deletedAt: 1_000,
        expiresAt: 1_000 + 30 * 86_400,
      },
    ]);
  });

  it("expires every kind after the purge period on Trellis versions without per-item expiry", () => {
    const items = TrellisCatalog.trashItems({
      projects: [{ id: "prj-a", kind: "project", name: "App", deleted_at: 2_000 }],
      workspaces: [],
      purge_after_days: 30,
    });
    expect(items.map((item) => item.expiresAt)).toEqual([2_000 + 30 * 86_400]);
  });
});

describe("trashItems with per-item expiry", () => {
  it("uses the expiry Trellis reports for each item", () => {
    expect(
      TrellisCatalog.trashItems({
        projects: [
          { id: "idea-a", kind: "idea", name: "Sketch", deleted_at: 1_000, expires_at: 5_000 },
          { id: "prj-a", kind: "project", name: "App", deleted_at: 2_000, expires_at: null },
        ],
        workspaces: [],
        idea_expiry_days: 30,
      }).map((item) => [item.id, item.expiresAt]),
    ).toEqual([
      ["prj-a", null],
      ["idea-a", 5_000],
    ]);
  });
});

describe("retiredRoots", () => {
  it("lists roots of trashed items and forks, never the scratch or live roots", () => {
    const roots = TrellisCatalog.retiredRoots(
      [
        idea("idea-gone", "Old", { deleted_at: 100 }),
        idea("idea-live", "Live"),
        dedicated("prj-gone", "Gone", [workspace("ws-g")], { deleted_at: 100 }),
        dedicated("prj-live", "App", [
          workspace("ws-a"),
          { ...workspace("ws-b", "try"), deleted_at: 100 },
        ]),
      ],
      [`${ROOT}/workspaces/ws-old/project`],
    );
    expect(roots).toEqual(
      [
        `${SCRATCH}/idea-gone`,
        `${ROOT}/workspaces/ws-g/project`,
        `${ROOT}/workspaces/ws-b/project`,
        `${ROOT}/workspaces/ws-old/project`,
      ].toSorted(),
    );
  });
});

describe("TrellisCatalog service", () => {
  const emptyShell: OrchestrationShellSnapshot = {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  function makeHarness(
    options: {
      readonly shell?: OrchestrationShellSnapshot;
      readonly archived?: OrchestrationShellSnapshot;
      readonly sessions?: ReadonlyArray<ProviderSession>;
      readonly trellis?: Partial<Trellis["Service"]>;
      /** Rejects repeated creates of a project id, like the decider. */
      readonly strictCreates?: boolean;
      /** Fails every project create, as a broken read model would. */
      readonly rejectProjectCreates?: boolean;
    } = {},
  ) {
    const items: Array<TrellisProjectView> = [];
    const dispatched: Array<OrchestrationCommand> = [];
    const trashed: Array<string> = [];
    const createdIds = new Set<string>();
    const env = { root: ROOT, bin: "trellis", shimDir: "/shims" };
    const unused = () => Effect.die(new Error("unused"));
    const layer = TrellisCatalog.layer.pipe(
      Layer.provide(
        Layer.succeed(Trellis, {
          ...makeTestTrellis({ env }),
          current: Effect.succeed(env),
          refresh: Effect.succeed(env),
          expectedRoots: Effect.succeed([ROOT]),
          bin: "trellis",
          listWorkspaces: unused,
          listProjects: () => Effect.sync(() => [...items]),
          createIdea: ({ name }) =>
            Effect.sync(() => {
              const created = idea(`idea-${items.length + 1}`, name ?? "Idea");
              items.push(created);
              return created;
            }),
          createProject: unused,
          trashProject: (id) => Effect.sync(() => void trashed.push(`project:${id}`)),
          trashWorkspace: (id) => Effect.sync(() => void trashed.push(`workspace:${id}`)),
          describe: unused,
          find: unused,
          resolve: unused,
          listSnapshots: unused,
          createSnapshot: unused,
          rollback: unused,
          preview: unused,
          primer: unused,
          ...options.trellis,
        }),
      ),
      Layer.provide(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.suspend(() => {
              if (command.type === "project.create" && options.rejectProjectCreates) {
                return Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "rejected",
                  }),
                );
              }
              if (command.type === "project.create" && options.strictCreates) {
                if (createdIds.has(command.projectId)) {
                  return Effect.fail(
                    new OrchestrationCommandInvariantError({
                      commandType: command.type,
                      detail: `Project '${command.projectId}' already exists and cannot be created twice.`,
                    }),
                  );
                }
                createdIds.add(command.projectId);
              }
              dispatched.push(command);
              return Effect.succeed({ sequence: dispatched.length });
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderService)({
          listSessions: () => Effect.succeed(options.sessions ?? []),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery)({
          getShellSnapshot: () => Effect.succeed(options.shell ?? emptyShell),
          getArchivedShellSnapshot: () => Effect.succeed(options.archived ?? emptyShell),
          getProjectShellById: (id) =>
            Effect.succeed(
              Option.fromNullishOr(
                (options.shell ?? emptyShell).projects.find((entry) => entry.id === id),
              ),
            ),
        }),
      ),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-trellis-catalog-" })),
      Layer.provide(NodeServices.layer),
    );
    return { layer, items, dispatched, trashed };
  }

  effectIt.effect("creates a new idea's T3 project and returns its id", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const result = yield* Effect.gen(function* () {
        const catalog = yield* TrellisCatalog.TrellisCatalog;
        return yield* catalog.newIdea({ name: "Plot weather" });
      }).pipe(Effect.provide(harness.layer));
      const create = harness.dispatched.find((command) => command.type === "project.create");
      expect(create).toMatchObject({
        type: "project.create",
        title: "Plot weather",
        workspaceRoot: `${SCRATCH}/idea-1`,
      });
      expect(result).toEqual({
        projectId: create?.type === "project.create" ? create.projectId : undefined,
        workspaceRoot: `${SCRATCH}/idea-1`,
        name: "Plot weather",
      });
    }),
  );

  effectIt.effect("skips the T3 read when the Trellis listing has not changed", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.items.push(idea("idea-a", "Sketch"));
      yield* Effect.gen(function* () {
        const catalog = yield* TrellisCatalog.TrellisCatalog;
        yield* catalog.syncNow;
        yield* catalog.syncNow;
      }).pipe(Effect.provide(harness.layer));
      // The shell snapshot mock never shows the created project, so a second
      // full pass would dispatch a second create.
      expect(
        harness.dispatched.filter((command) => command.type === "project.create"),
      ).toHaveLength(1);
    }),
  );

  effectIt.effect("prepares a new-idea draft without creating an idea", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const target = yield* Effect.gen(function* () {
        const catalog = yield* TrellisCatalog.TrellisCatalog;
        return yield* catalog.prepareIdeaDraft;
      }).pipe(Effect.provide(harness.layer));
      expect(target.projectId).toBe(TRELLIS_LANDING_PAD_PROJECT_ID);
      expect(harness.items).toEqual([]);
      expect(harness.dispatched).toEqual([
        expect.objectContaining({
          type: "project.create",
          projectId: TRELLIS_LANDING_PAD_PROJECT_ID,
          workspaceRoot: target.workspaceRoot,
        }),
      ]);
      // Outside every Trellis path, so the catalog sync never touches it.
      expect(isTrellisManagedPath(ROOT, target.workspaceRoot)).toBe(false);
    }),
  );

  effectIt.effect("moves a deleted project's Trellis fork to the trash", () =>
    Effect.gen(function* () {
      const forkRoot = `${ROOT}/workspaces/ws-b/project`;
      const harness = makeHarness({
        shell: {
          ...emptyShell,
          projects: [
            {
              id: ProjectId.make("p-fork"),
              title: "App · experiment",
              workspaceRoot: forkRoot,
            } as unknown as OrchestrationShellSnapshot["projects"][number],
          ],
        },
      });
      harness.items.push(
        dedicated("prj-a", "App", [workspace("ws-a"), workspace("ws-b", "experiment")]),
      );
      const result = yield* Effect.gen(function* () {
        const catalog = yield* TrellisCatalog.TrellisCatalog;
        return yield* catalog.trashProject(ProjectId.make("p-fork"));
      }).pipe(Effect.provide(harness.layer));
      expect(result).toEqual({ trashed: "workspace", name: "App · experiment" });
      expect(harness.trashed).toEqual(["workspace:ws-b"]);
    }),
  );

  const shellProject = (id: string, workspaceRoot: string) =>
    ({
      id: ProjectId.make(id),
      title: id,
      workspaceRoot,
    }) as unknown as OrchestrationShellSnapshot["projects"][number];
  const shellThread = (
    id: string,
    projectId: string,
    overrides: {
      archivedAt?: string | null;
      updatedAt?: string;
      session?: { status: string } | null;
    } = {},
  ) =>
    ({
      id: ThreadId.make(id),
      projectId: ProjectId.make(projectId),
      title: id,
      session: overrides.session ?? null,
      archivedAt: overrides.archivedAt ?? null,
      updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    }) as unknown as OrchestrationShellSnapshot["threads"][number];
  const session = (threadId: string, cwd: string, status: ProviderSession["status"]) =>
    ({
      provider: "codex",
      status,
      runtimeMode: "full-access",
      threadId: ThreadId.make(threadId),
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }) as unknown as ProviderSession;
  const run = <A, E>(
    harness: ReturnType<typeof makeHarness>,
    body: (catalog: TrellisCatalog.TrellisCatalog["Service"]) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      return yield* body(yield* TrellisCatalog.TrellisCatalog);
    }).pipe(Effect.provide(harness.layer));

  effectIt.effect("refuses to trash an item while an agent is working in it", () =>
    Effect.gen(function* () {
      const root = `${SCRATCH}/idea-a`;
      const harness = makeHarness({
        shell: {
          ...emptyShell,
          projects: [shellProject("p-idea", root)],
          threads: [shellThread("t-busy", "p-idea")],
        },
        sessions: [session("t-busy", `${root}/src`, "running")],
      });
      harness.items.push(idea("idea-a", "Sketch"));
      const error = yield* run(harness, (catalog) =>
        catalog.trashProject(ProjectId.make("p-idea")),
      ).pipe(Effect.flip);
      expect(error.message).toContain('"t-busy" is still working in Sketch');
      expect(harness.trashed).toEqual([]);
    }),
  );

  effectIt.effect("archives every conversation of the trashed item and stops its session", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        shell: {
          ...emptyShell,
          projects: [
            shellProject("p-main", `${ROOT}/workspaces/ws-a/project`),
            shellProject("p-fork", `${ROOT}/workspaces/ws-b/project`),
            shellProject("p-other", "/home/me/code"),
          ],
          threads: [
            // An idle session ending as the workspace stops bumps this one
            // past the deletion time, which the sync's heuristic would skip.
            shellThread("t-main", "p-main", {
              updatedAt: "2099-01-01T00:00:00.000Z",
              session: { status: "ready" },
            }),
            shellThread("t-fork", "p-fork"),
            shellThread("t-done", "p-main", { archivedAt: "2026-01-01T00:00:00.000Z" }),
            shellThread("t-other", "p-other"),
          ],
        },
        // Idle sessions do not block.
        sessions: [session("t-main", `${ROOT}/workspaces/ws-a/project`, "ready")],
      });
      harness.items.push(
        dedicated("prj-a", "App", [workspace("ws-a"), workspace("ws-b", "experiment")]),
      );
      const result = yield* run(harness, (catalog) =>
        catalog.trashProject(ProjectId.make("p-main")),
      );
      expect(result).toEqual({ trashed: "project", name: "App" });
      expect(harness.trashed).toEqual(["project:prj-a"]);
      expect(
        harness.dispatched.flatMap((command) =>
          command.type === "thread.archive" ? [command.threadId] : [],
        ),
      ).toEqual(["t-main", "t-fork"]);
      // Its idle session is stopped with it; threads without one are left alone.
      expect(
        harness.dispatched.flatMap((command) =>
          command.type === "thread.session.stop" ? [command.threadId] : [],
        ),
      ).toEqual(["t-main"]);
    }),
  );

  effectIt.effect("restore unarchives the conversations archived since the deletion", () =>
    Effect.gen(function* () {
      const mainRoot = `${ROOT}/workspaces/ws-a/project`;
      const restored = dedicated("prj-a", "App", [workspace("ws-a")]);
      const harness = makeHarness({
        shell: { ...emptyShell, projects: [shellProject("p-main", mainRoot)] },
        archived: {
          ...emptyShell,
          threads: [
            shellThread("t-trashed", "p-main", { archivedAt: "2026-01-02T00:00:10.000Z" }),
            shellThread("t-earlier", "p-main", { archivedAt: "2026-01-01T00:00:00.000Z" }),
          ],
        },
        trellis: {
          listTrash: Effect.succeed({
            projects: [
              {
                id: "prj-a",
                kind: "project",
                name: "App",
                deleted_at: Date.parse("2026-01-02T00:00:00Z") / 1000,
              },
            ],
            workspaces: [],
          }),
          restoreProject: () =>
            Effect.sync(() => {
              harness.items.push(restored);
              return restored;
            }),
        },
      });
      const result = yield* run(harness, (catalog) =>
        catalog.restore({ kind: "project", id: "prj-a" }),
      );
      expect(result.projectId).toBe(ProjectId.make("p-main"));
      expect(
        harness.dispatched.flatMap((command) =>
          command.type === "thread.unarchive" ? [command.threadId] : [],
        ),
      ).toEqual(["t-trashed"]);
    }),
  );

  effectIt.effect("prepares the landing pad idempotently, also while the projection lags", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ strictCreates: true });
      const targets = yield* run(harness, (catalog) =>
        Effect.all([catalog.prepareIdeaDraft, catalog.prepareIdeaDraft], {
          concurrency: "unbounded",
        }),
      );
      expect(targets[0]).toEqual(targets[1]);
      expect(
        harness.dispatched.filter((command) => command.type === "project.create"),
      ).toHaveLength(1);
      expect(harness.items).toEqual([]);
    }),
  );

  effectIt.effect("discards a draft's idea whose T3 project never appears", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ rejectProjectCreates: true });
      const error = yield* run(harness, (catalog) => catalog.createIdeaForDraft).pipe(Effect.flip);
      expect(error.message).toContain("not available yet");
      expect(harness.trashed).toEqual(["project:idea-1"]);
    }),
  );
});
