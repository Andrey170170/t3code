import {
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { Trellis, type TrellisProjectView, type TrellisWorkspaceView } from "./Trellis.ts";
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

describe("TrellisCatalog service", () => {
  const emptyShell: OrchestrationShellSnapshot = {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  function makeHarness() {
    const items: Array<TrellisProjectView> = [];
    const dispatched: Array<OrchestrationCommand> = [];
    const env = { root: ROOT, bin: "trellis", shimDir: "/shims" };
    const unused = () => Effect.die(new Error("unused"));
    const layer = TrellisCatalog.layer.pipe(
      Layer.provide(
        Layer.succeed(Trellis, {
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
          describe: unused,
          find: unused,
          resolve: unused,
          listSnapshots: unused,
          createSnapshot: unused,
          rollback: unused,
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
          getShellSnapshot: () => Effect.succeed(emptyShell),
          getArchivedShellSnapshot: () => Effect.succeed(emptyShell),
        }),
      ),
      Layer.provide(NodeServices.layer),
    );
    return { layer, items, dispatched };
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
});
