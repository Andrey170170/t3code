import {
  ProjectId,
  ThreadId,
  TRELLIS_LANDING_PAD_PROJECT_ID,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
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
  it("lists ideas with their expiry, keeps projects until emptied and folds forks of trashed projects", () => {
    const items = TrellisCatalog.trashItems({
      projects: [
        { id: "idea-a", kind: "idea", name: "Sketch", deleted_at: 1_000 },
        { id: "prj-a", kind: "project", name: "App", deleted_at: 2_000 },
      ],
      workspaces: [
        { id: "ws-a", kind: "dedicated", name: "main", project_id: "prj-a", deleted_at: 2_000 },
        { id: "ws-c", kind: "dedicated", name: "try", project_id: "prj-live", deleted_at: 3_000 },
      ],
      purge_after_days: 30,
    });
    expect(items).toEqual([
      { kind: "workspace", id: "ws-c", name: "try", deletedAt: 3_000, expiresAt: null },
      { kind: "project", id: "prj-a", name: "App", deletedAt: 2_000, expiresAt: null },
      {
        kind: "idea",
        id: "idea-a",
        name: "Sketch",
        deletedAt: 1_000,
        expiresAt: 1_000 + 30 * 86_400,
      },
    ]);
  });
});

describe("TrellisCatalog service", () => {
  const emptyShell: OrchestrationShellSnapshot = {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  function makeHarness(options: { readonly shell?: OrchestrationShellSnapshot } = {}) {
    const items: Array<TrellisProjectView> = [];
    const dispatched: Array<OrchestrationCommand> = [];
    const trashed: Array<string> = [];
    const env = { root: ROOT, bin: "trellis", shimDir: "/shims" };
    const unused = () => Effect.die(new Error("unused"));
    const layer = TrellisCatalog.layer.pipe(
      Layer.provide(
        Layer.succeed(Trellis, {
          ...makeTestTrellis({ env }),
          current: Effect.succeed(env),
          refresh: Effect.succeed(env),
          expectedRoot: Effect.succeed(ROOT),
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
        }),
      ),
      Layer.provide(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: dispatched.length };
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery)({
          getShellSnapshot: () => Effect.succeed(options.shell ?? emptyShell),
          getArchivedShellSnapshot: () => Effect.succeed(emptyShell),
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
});
