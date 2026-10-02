import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it as effectIt } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ThreadId,
  TrellisError,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { layer as mcpSessionRegistryTestLayer } from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { layer as idAllocatorLayer } from "../orchestration-v2/IdAllocator.ts";
import { OrchestratorProjectionError, OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { EffectOutboxV2 } from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { TurnAdmission } from "../orchestration-v2/TurnAdmission.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import {
  ProviderSessionManagerV2,
  ProviderSessionReleaseError,
} from "../orchestration-v2/ProviderSessionManager.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2LayerLive,
} from "../orchestration-v2/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  makeTestTrellis,
  Trellis,
  type TrellisProjectView,
  type TrellisTrashView,
  type TrellisWorkspaceView,
} from "./Trellis.ts";
import * as TrellisCatalog from "./TrellisCatalog.ts";
import * as TrellisRestore from "./TrellisRestore.ts";

interface CatalogState {
  items: Array<TrellisProjectView>;
  trashed: Array<string>;
  readonly trashStarted?: Deferred.Deferred<void>;
  readonly trashRelease?: Deferred.Deferred<void>;
  /** Base builds Trellis was asked for; each waits for `buildRelease` when set. */
  builds?: number;
  readonly buildRelease?: Deferred.Deferred<void>;
  baseStates?: Record<string, string>;
}

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
const EARLY_MS = 10_000;

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

  it("keeps empty projects of trashed items and forks for a restore, without no-op actions", () => {
    const actions = TrellisCatalog.planCatalogSync({
      root: ROOT,
      items: [
        idea("idea-trashed", "Trashed", { deleted_at: 100 }),
        dedicated("prj-live", "Live", [workspace("ws-live"), workspace("ws-fork", "fork")]),
      ],
      projects: [
        project("p-trashed", `${SCRATCH}/idea-trashed`),
        project("p-live", `${ROOT}/workspaces/ws-live/project`, "Live"),
        project("p-fork", `${ROOT}/workspaces/ws-fork/project`, "Live · fork"),
      ],
      threads: [],
      deletedWorkspaces: new Map([["ws-fork", 100]]),
    });
    expect(actions).toEqual([]);
  });

  it("archives the threads of trashed or graduated items and deletes empty graduated ones", () => {
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
          updatedAtMs: EARLY_MS,
        },
        {
          id: ThreadId.make("t-2"),
          projectId: ProjectId.make("p-trashed"),
          archived: true,
          updatedAtMs: EARLY_MS,
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

  it("follows an idea graduated elsewhere: its active threads move, then it retires", () => {
    const input = {
      root: ROOT,
      items: [
        idea("idea-g", "Graduated", { graduated_to: "prj-g", updated_at: 100 }),
        dedicated("prj-g", "Graduated", [workspace("ws-g")]),
      ],
      deletedWorkspaces: noDeletedWorkspaces,
    };
    const thread = (id: string, archived: boolean) => ({
      id: ThreadId.make(id),
      projectId: ProjectId.make("p-idea"),
      archived,
      updatedAtMs: EARLY_MS,
    });
    // The project is created in the same pass, before the threads move.
    expect(
      TrellisCatalog.planCatalogSync({
        ...input,
        projects: [project("p-idea", `${SCRATCH}/idea-g`)],
        threads: [thread("t-active", false), thread("t-archived", true)],
      }),
    ).toEqual([
      { type: "create", workspaceRoot: `${ROOT}/workspaces/ws-g/project`, title: "Graduated" },
      {
        type: "repoint",
        projectId: ProjectId.make("p-idea"),
        toRoot: `${ROOT}/workspaces/ws-g/project`,
        threadIds: [ThreadId.make("t-active")],
      },
    ]);
    // Once only archived threads are left, the idea retires and keeps them.
    expect(
      TrellisCatalog.planCatalogSync({
        ...input,
        projects: [
          project("p-idea", `${SCRATCH}/idea-g`),
          project("p-g", `${ROOT}/workspaces/ws-g/project`, "Graduated"),
        ],
        threads: [thread("t-archived", true)],
      }),
    ).toEqual([]);
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
            updatedAtMs: EARLY_MS,
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
            updatedAtMs: EARLY_MS,
          },
        ],
      }),
    ).toEqual([]);
  });

  it("retires a fork the listing reports as trashed, with threads from its deletion second", () => {
    const actions = TrellisCatalog.planCatalogSync({
      root: ROOT,
      items: [
        dedicated("prj-b", "Engine", [
          workspace("ws-b"),
          { ...workspace("ws-fork", "fork"), deleted_at: 100 },
        ]),
      ],
      projects: [
        project("p-b", `${ROOT}/workspaces/ws-b/project`, "Engine"),
        project("p-fork", `${ROOT}/workspaces/ws-fork/project`, "Engine · fork"),
      ],
      threads: [
        {
          id: ThreadId.make("t-same-second"),
          projectId: ProjectId.make("p-fork"),
          archived: false,
          // Updated during second 100, before the fork was trashed in it.
          updatedAtMs: 100_500,
        },
      ],
      deletedWorkspaces: noDeletedWorkspaces,
    });
    expect(actions).toEqual([
      {
        type: "retire",
        projectId: ProjectId.make("p-fork"),
        archiveThreadIds: [ThreadId.make("t-same-second")],
        deleteProject: false,
      },
    ]);
    expect(
      TrellisCatalog.unlistedWorkspaceIds({
        root: ROOT,
        items: [
          dedicated("prj-b", "Engine", [
            workspace("ws-b"),
            { ...workspace("ws-fork", "fork"), deleted_at: 100 },
          ]),
        ],
        projects: [project("p-fork", `${ROOT}/workspaces/ws-fork/project`)],
      }),
    ).toEqual(["ws-fork"]);
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
          updatedAtMs: EARLY_MS,
        },
        {
          id: ThreadId.make("t-unarchived"),
          projectId: ProjectId.make("p-trashed"),
          archived: false,
          updatedAtMs: 300_000,
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
            updatedAtMs: EARLY_MS,
          },
          {
            id: ThreadId.make("t-unarchived"),
            projectId: ProjectId.make("p-trashed"),
            archived: false,
            updatedAtMs: 300_000,
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

describe("openMissingRootsRecord", () => {
  const withDir = <A, E>(
    use: (dir: string) => Effect.Effect<A, E, FileSystem.FileSystem>,
  ): Effect.Effect<A, E | PlatformError, FileSystem.FileSystem> =>
    Effect.scoped(
      Effect.flatMap(
        FileSystem.FileSystem.use((fileSystem) =>
          fileSystem.makeTempDirectoryScoped({ prefix: "t3-missing-roots-" }),
        ),
        use,
      ),
    );

  effectIt.effect("keeps the times across a restart, the server's next start reads them", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const path = `${dir}/record.json`;
        const first = yield* TrellisCatalog.openMissingRootsRecord(path);
        assert.equal(first.initial.size, 0);
        yield* first.write(new Map([["/trellis/workspaces/ws-a/project", 1_700_000_000]]));
        const restarted = yield* TrellisCatalog.openMissingRootsRecord(path);
        assert.deepEqual(
          [...restarted.initial],
          [["/trellis/workspaces/ws-a/project", 1_700_000_000]],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  effectIt.effect("sets an unreadable record aside instead of overwriting it", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = `${dir}/record.json`;
        yield* fileSystem.writeFileString(path, "{not json");
        const record = yield* TrellisCatalog.openMissingRootsRecord(path);
        assert.equal(record.initial.size, 0);
        assert.equal(yield* fileSystem.readFileString(`${path}.unreadable`), "{not json");
        // It cannot be set aside (a directory is in the way): never overwritten.
        yield* fileSystem.writeFileString(path, "{still not json");
        yield* fileSystem.remove(`${path}.unreadable`);
        yield* fileSystem.makeDirectory(`${path}.unreadable/blocker`, { recursive: true });
        const stuck = yield* TrellisCatalog.openMissingRootsRecord(path);
        yield* stuck.write(new Map([["/r", 1]]));
        assert.equal(yield* fileSystem.readFileString(path), "{still not json");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
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

describe("nameDetailsWorkspaces", () => {
  it("names primary workspaces, forks and the scratch workspace; leaves unknown ones unnamed", () => {
    const details = TrellisCatalog.nameDetailsWorkspaces(
      {
        root: ROOT,
        version: null,
        commit: null,
        uptimeSecs: null,
        bases: [],
        baseStates: null,
        buildingBases: [],
        baseBuildFailures: {},
        defaultBase: null,
        missingProviders: [],
        agentHomes: null,
        runningWorkspaces: [
          { id: "ws-scratch", name: null },
          { id: "ws-app", name: null },
          { id: "ws-gone", name: null },
        ],
        restartNeeded: [{ id: "ws-fork", name: null, reason: "older binary" }],
        pendingOperations: [],
        disk: null,
      },
      [
        idea("idea-1", "Sketch"),
        dedicated("prj-app", "App", [workspace("ws-app"), workspace("ws-fork", "try-sqlite")]),
      ],
    );
    expect(details.runningWorkspaces).toEqual([
      { id: "ws-scratch", name: "Ideas" },
      { id: "ws-app", name: "App" },
      { id: "ws-gone", name: null },
    ]);
    expect(details.restartNeeded).toEqual([
      { id: "ws-fork", name: "App · try-sqlite", reason: "older binary" },
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

// The catalog against the V2 orchestrator and project store, with a fake
// Trellis whose listing the test edits. Project commands go straight into the
// project store, as ProjectService would commit them.
describe("TrellisCatalog service", () => {
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  } satisfies ModelSelection;
  const driver = ProviderDriverKind.make("codex");
  const providerInstance = {
    instanceId: modelSelection.instanceId,
    driverKind: driver,
    continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
    displayName: "Codex test",
    enabled: true,
    snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
    orchestrationAdapter: {
      instanceId: modelSelection.instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("sessions are not opened by dispatch"),
    } as ProviderAdapterV2Shape,
    textGeneration: {} as ProviderInstance["textGeneration"],
  } satisfies ProviderInstance;

  const PlatformTestLayer = Layer.merge(
    NodeServices.layer,
    Layer.mock(SourceControlProviderRegistry)({ resolveLink: () => Effect.die("unused") }),
  );
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-trellis-catalog-",
  });

  const setWorkspaceDeletedAt = (
    state: { items: Array<TrellisProjectView> },
    id: string,
    deletedAt: number | null,
  ) => {
    state.items = state.items.map((item) => ({
      ...item,
      workspaces: item.workspaces.map((entry) =>
        entry.id === id ? { ...entry, deleted_at: deletedAt } : entry,
      ),
    }));
  };

  /** Failures the service tests inject. */
  const faults = {
    restoreAnswerLost: false,
    projectListFails: false,
    projectGetFails: false,
    trellisDown: false,
    /** Active-thread reads that succeed before the next one fails; null never fails. */
    activeReadsBeforeFailure: null as number | null,
  };

  /** The catalog's orchestrator, with active-thread reads failing per `faults`. */
  const flakyOrchestrator = Layer.effect(
    OrchestratorV2,
    Effect.map(OrchestratorV2, (orchestrator) =>
      OrchestratorV2.of({
        ...orchestrator,
        getShellSnapshot: (options) =>
          Effect.suspend(() => {
            if (options?.location === "active" && faults.activeReadsBeforeFailure !== null) {
              if (faults.activeReadsBeforeFailure === 0) {
                faults.activeReadsBeforeFailure = null;
                return Effect.fail(
                  new OrchestratorProjectionError({ threadId: ThreadId.make("shell") }),
                );
              }
              faults.activeReadsBeforeFailure -= 1;
            }
            return orchestrator.getShellSnapshot(options);
          }),
      }),
    ),
  );

  /** The catalog's project store, with `list` failing while `faults.projectListFails` is set. */
  const flakyProjectStore = Layer.effect(
    ProjectStore.ProjectStoreV2,
    Effect.map(ProjectStore.ProjectStoreV2, (store) =>
      ProjectStore.ProjectStoreV2.of({
        ...store,
        get: (projectId, options) =>
          Effect.suspend(() =>
            faults.projectGetFails
              ? Effect.fail(new ProjectStore.ProjectStoreV2Error({ operation: "get", cause: null }))
              : store.get(projectId, options),
          ),
        list: (options) =>
          Effect.suspend(() =>
            faults.projectListFails
              ? Effect.fail(
                  new ProjectStore.ProjectStoreV2Error({ operation: "list", cause: null }),
                )
              : store.list(options),
          ),
      }),
    ),
  );

  /**
   * A Trellis whose catalog is `state`; trash and restore edit it. A trash
   * reports `trashStarted` and waits for `trashRelease` when they are given.
   */
  const fakeTrellis = (state: CatalogState) =>
    makeTestTrellis({
      env: { root: ROOT, bin: "trellis", shimDir: "/shims" },
      // Trellis stopped: unreachable while `faults.trellisDown` is set.
      refresh: Effect.sync(() =>
        faults.trellisDown ? null : { root: ROOT, bin: "trellis", shimDir: "/shims" },
      ),
      connection: Effect.sync(() => ({
        state: faults.trellisDown ? ("unavailable" as const) : ("ready" as const),
        root: ROOT,
        socketPath: "/trellis/state/api.sock",
      })),
      listProjects: ({ all }) =>
        Effect.sync(() =>
          all
            ? [...state.items]
            : state.items.filter((item) => item.deleted_at === null && item.graduated_to === null),
        ),
      listWorkspaces: () => Effect.succeed([]),
      buildBase: (name) =>
        Effect.gen(function* () {
          state.builds = (state.builds ?? 0) + 1;
          if (state.buildRelease !== undefined) yield* Deferred.await(state.buildRelease);
          if (name === "broken") {
            return yield* new TrellisError({ message: "definition for broken failed" });
          }
          return { name, state: "current" };
        }),
      details: Effect.sync(() => ({
        root: ROOT,
        version: null,
        commit: null,
        uptimeSecs: null,
        bases: ["dev", "broken"],
        baseStates: state.baseStates ?? null,
        buildingBases: [],
        baseBuildFailures: {},
        defaultBase: "dev",
        missingProviders: [],
        agentHomes: null,
        runningWorkspaces: null,
        restartNeeded: null,
        pendingOperations: [],
        disk: null,
      })),
      trashProject: (id) =>
        Effect.gen(function* () {
          if (state.trashStarted !== undefined)
            yield* Deferred.succeed(state.trashStarted, undefined);
          if (state.trashRelease !== undefined) yield* Deferred.await(state.trashRelease);
          state.trashed.push(id);
          state.items = state.items.map((item) =>
            item.id === id ? { ...item, deleted_at: 0 } : item,
          );
        }),
      restoreProject: (id) =>
        Effect.suspend(() => {
          state.items = state.items.map((item) =>
            item.id === id ? { ...item, deleted_at: null } : item,
          );
          // Trellis restored it, but the answer was lost.
          if (faults.restoreAnswerLost) {
            faults.restoreAnswerLost = false;
            return Effect.fail(new TrellisError({ message: "connection reset" }));
          }
          return Effect.succeed(state.items.find((item) => item.id === id)!);
        }),
      trashWorkspace: (id) => Effect.sync(() => setWorkspaceDeletedAt(state, id, 0)),
      restoreWorkspace: (id) => Effect.sync(() => setWorkspaceDeletedAt(state, id, null)),
      listTrash: Effect.sync((): TrellisTrashView => ({
        projects: state.items
          .filter((item) => item.deleted_at !== null)
          .map((item) => ({
            id: item.id,
            kind: item.kind,
            name: item.name,
            deleted_at: item.deleted_at,
          })),
        workspaces: state.items.flatMap((item) =>
          item.workspaces
            .filter((entry) => entry.deleted_at !== null)
            .map((entry) => ({
              id: entry.id,
              kind: entry.kind,
              name: entry.name,
              project_id: item.id,
              deleted_at: entry.deleted_at,
            })),
        ),
      })),
    });

  const projectCommandsLayer = Layer.effect(
    ProjectService.ProjectService,
    Effect.gen(function* () {
      const store = yield* ProjectStore.ProjectStoreV2;
      let sequence = 0;
      const at = "1970-01-01T00:00:00.000Z";
      const base = (projectId: ProjectId) => ({
        sequence: ++sequence,
        eventId: EventId.make(`catalog-test:${sequence}`),
        aggregateKind: "project" as const,
        aggregateId: projectId,
        occurredAt: at,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
      });
      const unused = () => Effect.die("unused ProjectService operation");
      return ProjectService.ProjectService.of({
        create: (input) =>
          store
            .apply({
              ...base(input.projectId),
              type: "project.created",
              payload: {
                projectId: input.projectId,
                title: input.title,
                workspaceRoot: input.workspaceRoot,
                defaultModelSelection: null,
                scripts: [],
                createdAt: at,
                updatedAt: at,
              },
            })
            .pipe(Effect.orDie, Effect.as({} as never)),
        update: (input) =>
          store
            .apply({
              ...base(input.projectId),
              type: "project.meta-updated",
              payload: {
                projectId: input.projectId,
                ...(input.title === undefined ? {} : { title: input.title }),
                updatedAt: at,
              },
            })
            .pipe(Effect.orDie, Effect.as({} as never)),
        delete: (input) =>
          store
            .apply({
              ...base(input.projectId),
              type: "project.deleted",
              payload: { projectId: input.projectId, deletedAt: at },
            })
            .pipe(Effect.orDie, Effect.as({} as never)),
        bootstrap: unused,
        getById: unused,
        getByWorkspaceRoot: unused,
        snapshot: Effect.die("unused"),
        getShell: unused,
        listShells: unused,
      });
    }),
  );

  const catalogLayer = (state: CatalogState, sessions?: Layer.Layer<ProviderSessionManagerV2>) =>
    TrellisCatalog.layer.pipe(
      // A fake session manager, when given, stands in for the live one.
      sessions === undefined ? (layer) => layer : Layer.provide(sessions),
      Layer.provide(Layer.merge(flakyProjectStore, flakyOrchestrator)),
      Layer.provideMerge(
        Layer.mergeAll(
          OrchestrationV2LayerLive,
          OrchestrationV2EventSinkLayerLive,
          idAllocatorLayer,
        ),
      ),
      Layer.provideMerge(projectCommandsLayer),
      Layer.provideMerge(ProjectStore.layer),
      Layer.provideMerge(TrellisRestore.gateLayer),
      Layer.provideMerge(Layer.succeed(Trellis, fakeTrellis(state))),
      Layer.provide(Layer.mock(OrchestrationEventStore)({})),
      Layer.provide(mcpSessionRegistryTestLayer),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provide(
        CheckpointStore.layer.pipe(
          Layer.provide(
            VcsDriverRegistry.layer.pipe(
              Layer.provide(VcsProcess.layer),
              Layer.provide(ServerConfigLayer),
              Layer.provide(PlatformTestLayer),
            ),
          ),
        ),
      ),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provide(ServerSettingsService.layerTest()),
      Layer.provide(
        Layer.succeed(ProviderInstanceRegistry, {
          getInstance: (instanceId) =>
            Effect.succeed(
              instanceId === providerInstance.instanceId ? providerInstance : undefined,
            ),
          listInstances: Effect.succeed([providerInstance]),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.never,
        }),
      ),
      Layer.provide(
        Layer.mock(GitWorkflow.GitWorkflowService)({
          pruneWorktrees: () => Effect.void,
          createWorktree: () => Effect.succeed({} as never),
        }),
      ),
      Layer.provide(PlatformTestLayer),
    );

  const projectIdAt = (workspaceRoot: string) =>
    Effect.flatMap(ProjectStore.ProjectStoreV2, (store) =>
      store.findActiveByWorkspaceRoot(workspaceRoot),
    ).pipe(Effect.map((row) => Option.getOrUndefined(row)));

  const createThread = (name: string, projectId: ProjectId) =>
    Effect.flatMap(OrchestratorV2, (orchestrator) =>
      orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${name}:create`),
        threadId: ThreadId.make(name),
        projectId,
        title: name,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      }),
    ).pipe(Effect.as(ThreadId.make(name)));

  const archivedAt = (threadId: ThreadId) =>
    Effect.flatMap(OrchestratorV2, (orchestrator) => orchestrator.getThreadShell(threadId)).pipe(
      Effect.map((shell) => shell?.archivedAt ?? null),
    );

  const state = {
    items: [
      idea("idea-a", "Sketch"),
      idea("idea-c", "Doomed"),
      idea("idea-d", "Empty"),
      dedicated("prj-b", "Engine", [workspace("ws-b")]),
    ],
    trashed: [] as Array<string>,
  };

  effectIt.layer(catalogLayer(state))("against V2", (it) => {
    it.effect("moves the threads of an idea graduated from the CLI into its project", () =>
      Effect.gen(function* () {
        const catalog = yield* TrellisCatalog.TrellisCatalog;
        const orchestrator = yield* OrchestratorV2;
        state.items = [...state.items, idea("idea-cli", "Spike")];
        yield* catalog.syncNow;
        const ideaProject = (yield* projectIdAt(`${SCRATCH}/idea-cli`))!;
        const threadId = yield* createThread("catalog-cli-graduated", ideaProject.projectId);

        // `trellis graduate` on the host: the idea points at its new project.
        state.items = [
          ...state.items.map((item) =>
            item.id === "idea-cli" ? { ...item, graduated_to: "prj-cli", updated_at: 100 } : item,
          ),
          dedicated("prj-cli", "Spike", [workspace("ws-cli")]),
        ];
        yield* catalog.syncNow;
        const graduated = (yield* projectIdAt(`${ROOT}/workspaces/ws-cli/project`))!;
        const shell = yield* orchestrator.getThreadShell(threadId);
        assert.equal(shell?.projectId, graduated.projectId);
        assert.isNull(shell?.archivedAt);
        // No continuation: the thread continues when the user writes next.
        assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).messages, []);
        // Left without threads, the idea's project goes.
        yield* catalog.syncNow;
        assert.isUndefined(yield* projectIdAt(`${SCRATCH}/idea-cli`));
      }),
    );

    it.effect("creates, renames and retires projects, and trash and restore round-trip", () =>
      Effect.gen(function* () {
        const catalog = yield* TrellisCatalog.TrellisCatalog;

        // The poll creates one project per idea and workspace.
        yield* catalog.syncNow;
        const a = yield* projectIdAt(`${SCRATCH}/idea-a`);
        const b = yield* projectIdAt(`${ROOT}/workspaces/ws-b/project`);
        assert.equal(a?.title, "Sketch");
        assert.equal(b?.title, "Engine");

        // Trellis is the source of truth for names.
        state.items = state.items.map((item) =>
          item.id === "prj-b" ? { ...item, name: "Engine v2" } : item,
        );
        yield* catalog.syncNow;
        assert.equal((yield* projectIdAt(`${ROOT}/workspaces/ws-b/project`))?.title, "Engine v2");

        // An item trashed in Trellis retires: its threads are archived; an
        // empty project stays (hidden by clients) so a restore keeps its id.
        const c = (yield* projectIdAt(`${SCRATCH}/idea-c`))!;
        const doomed = yield* createThread("catalog-doomed", c.projectId);
        state.items = state.items.map((item) =>
          item.id === "idea-c" || item.id === "idea-d" ? { ...item, deleted_at: 100 } : item,
        );
        yield* catalog.syncNow;
        assert.isNotNull(yield* archivedAt(doomed));
        assert.isDefined(yield* projectIdAt(`${SCRATCH}/idea-c`));
        const d = yield* projectIdAt(`${SCRATCH}/idea-d`);
        assert.isDefined(d);
        // Purged from the trash, the empty project goes.
        state.items = state.items.filter((item) => item.id !== "idea-d");
        yield* catalog.syncNow;
        assert.isUndefined(yield* projectIdAt(`${SCRATCH}/idea-d`));

        // Trash from T3 archives the conversations; restore brings them back.
        const kept = yield* createThread("catalog-kept", a!.projectId);
        const trashed = yield* catalog.trashProject(a!.projectId);
        // The result says how to undo it: an idea restores as an idea.
        assert.deepEqual(trashed, {
          trashed: "project",
          name: "Sketch",
          restore: { kind: "idea", id: "idea-a" },
        });
        assert.deepEqual(state.trashed, ["idea-a"]);
        assert.isNotNull(yield* archivedAt(kept));
        const status = yield* catalog.status;
        assert.include(status.retiredRoots ?? [], `${SCRATCH}/idea-a`);

        // Trellis restores it but the answer is lost: the conversations stay
        // archived until a retry finishes the restore.
        faults.restoreAnswerLost = true;
        yield* catalog.restore({ kind: "idea", id: "idea-a" }).pipe(Effect.flip);
        assert.isNotNull(yield* archivedAt(kept));
        // A retry whose sync cannot read T3's projects fails and keeps the
        // record rather than dropping it unfinished.
        faults.projectListFails = true;
        yield* catalog
          .restore({ kind: "idea", id: "idea-a" })
          .pipe(
            Effect.flip,
            Effect.ensuring(Effect.sync(() => void (faults.projectListFails = false))),
          );
        assert.isNotNull(yield* archivedAt(kept));
        const restored = yield* catalog.restore({ kind: "idea", id: "idea-a" });
        assert.equal(restored.projectId, a!.projectId);
        assert.isNull(yield* archivedAt(kept));

        // Trashing refuses while it cannot tell whether anything is running.
        faults.projectListFails = true;
        const unverified = yield* catalog
          .trashProject(a!.projectId)
          .pipe(
            Effect.flip,
            Effect.ensuring(Effect.sync(() => void (faults.projectListFails = false))),
          );
        assert.include(unverified.message, "Could not check");
        assert.deepEqual(state.trashed, ["idea-a"]);

        // Trashed, but its conversations could not be archived: reported.
        faults.activeReadsBeforeFailure = 1;
        const partial = yield* catalog.trashProject(a!.projectId).pipe(Effect.flip);
        assert.include(partial.message, "is in the Trellis trash, but");
        assert.deepEqual(state.trashed, ["idea-a", "idea-a"]);
        yield* catalog.restore({ kind: "idea", id: "idea-a" });

        // Once the trash is purged, a project kept for its conversations
        // stays retired.
        state.items = state.items.filter((item) => item.id !== "idea-c");
        yield* catalog.syncNow;
        assert.include((yield* catalog.status).retiredRoots ?? [], `${SCRATCH}/idea-c`);

        // Only T3's entry of a live Trellis project cannot be deleted; that of
        // a project whose item is gone can.
        const refused = yield* catalog.checkProjectDelete(b!.projectId).pipe(Effect.flip);
        assert.include(refused.message, "move it to the Trellis trash");
        yield* catalog.checkProjectDelete(c.projectId);
        // A failed project read refuses rather than letting the delete through.
        faults.projectGetFails = true;
        const unreadable = yield* catalog
          .checkProjectDelete(c.projectId)
          .pipe(
            Effect.flip,
            Effect.ensuring(Effect.sync(() => void (faults.projectGetFails = false))),
          );
        assert.include(unreadable.message, "Could not read the project");
      }),
    );

    it.effect("archives the conversations of an item purged before T3 saw it trashed", () =>
      Effect.gen(function* () {
        const catalog = yield* TrellisCatalog.TrellisCatalog;
        state.items = [...state.items, idea("idea-e", "Expired")];
        yield* catalog.syncNow;
        const e = (yield* projectIdAt(`${SCRATCH}/idea-e`))!;
        const thread = yield* createThread("catalog-expired", e.projectId);
        // Expired from the trash while T3 was not looking: gone from the listing.
        state.items = state.items.filter((item) => item.id !== "idea-e");
        yield* catalog.syncNow;
        assert.isNotNull(yield* archivedAt(thread));
        assert.include((yield* catalog.status).retiredRoots ?? [], `${SCRATCH}/idea-e`);
        // When it went missing survives a restart, so a conversation the user
        // unarchives later is not archived again by the next server.
        const { stateDir } = yield* ServerConfig;
        const persisted = yield* FileSystem.FileSystem.use((fileSystem) =>
          fileSystem.readFileString(`${stateDir}/trellis-missing-roots.json`),
        ).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Record(Schema.String, Schema.Finite)),
            ),
          ),
          Effect.provide(NodeServices.layer),
        );
        assert.isNumber(persisted[`${SCRATCH}/idea-e`]);
      }),
    );

    it.effect("keeps retired roots while Trellis is stopped", () =>
      Effect.gen(function* () {
        const catalog = yield* TrellisCatalog.TrellisCatalog;
        yield* catalog.syncNow;
        faults.trellisDown = true;
        const status = yield* catalog.syncNow.pipe(
          Effect.andThen(catalog.status),
          Effect.ensuring(Effect.sync(() => void (faults.trellisDown = false))),
        );
        assert.equal(status.state, "unavailable");
        assert.include(status.retiredRoots ?? [], `${SCRATCH}/idea-c`);
      }),
    );

    it.effect("restoring a fork of a live project unarchives only the fork's conversations", () =>
      Effect.gen(function* () {
        const catalog = yield* TrellisCatalog.TrellisCatalog;
        const orchestrator = yield* OrchestratorV2;
        state.items = state.items.map((item) =>
          item.id === "prj-b"
            ? { ...item, workspaces: [workspace("ws-b"), workspace("ws-f", "fork")] }
            : item,
        );
        yield* catalog.syncNow;
        const primary = (yield* projectIdAt(`${ROOT}/workspaces/ws-b/project`))!;
        const fork = (yield* projectIdAt(`${ROOT}/workspaces/ws-f/project`))!;
        const inPrimary = yield* createThread("catalog-primary", primary.projectId);
        const inFork = yield* createThread("catalog-fork", fork.projectId);

        assert.deepEqual(yield* catalog.trashProject(fork.projectId), {
          trashed: "workspace",
          name: "Engine v2 · fork",
          restore: { kind: "workspace", id: "ws-f" },
        });
        assert.isNotNull(yield* archivedAt(inFork));
        // Archived by hand after the fork went to the trash.
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("catalog-primary:archive"),
          threadId: inPrimary,
        });

        yield* catalog.restore({ kind: "workspace", id: "ws-f" });
        assert.isNull(yield* archivedAt(inFork));
        assert.isNotNull(yield* archivedAt(inPrimary));
      }),
    );
  });
  const buildState: CatalogState = {
    items: [],
    trashed: [],
    buildRelease: Deferred.makeUnsafe<void>(),
  };

  effectIt.layer(catalogLayer(buildState))("base builds", (it) => {
    it.effect("outlive their caller and join a repeated request instead of queueing", () =>
      Effect.gen(function* () {
        const catalog = yield* TrellisCatalog.TrellisCatalog;
        const first = yield* Effect.forkChild(catalog.buildBase("dev"));
        yield* Effect.yieldNow;
        // The page that asked went away: the build goes on, still reported.
        yield* Fiber.interrupt(first);
        assert.deepEqual((yield* catalog.details).buildingBases, ["dev"]);
        const second = yield* Effect.forkChild(catalog.buildBase("dev"));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(buildState.buildRelease!, undefined);
        assert.deepEqual(yield* Fiber.join(second), { name: "dev", state: "current" });
        assert.equal(buildState.builds, 1);
        assert.deepEqual((yield* catalog.details).buildingBases, []);
        // Two first requests at once still start one build.
        const before = buildState.builds ?? 0;
        const [a, b] = yield* Effect.all([catalog.buildBase("py"), catalog.buildBase("py")], {
          concurrency: "unbounded",
        });
        assert.deepEqual(a, b);
        assert.equal(buildState.builds, before + 1);
        // A failure stays reported until the base is current again (rebuilt from the CLI).
        yield* catalog.buildBase("broken").pipe(Effect.flip);
        assert.deepEqual((yield* catalog.details).baseBuildFailures, {
          broken: "definition for broken failed",
        });
        buildState.baseStates = { broken: "current" };
        assert.deepEqual((yield* catalog.details).baseBuildFailures, {});
      }),
    );
  });

  const raceState: CatalogState = {
    items: [dedicated("prj-race", "Race", [workspace("ws-race")])],
    trashed: [],
    trashStarted: Deferred.makeUnsafe<void>(),
    trashRelease: Deferred.makeUnsafe<void>(),
  };

  effectIt.layer(catalogLayer(raceState))("trash against turn admission", (it) => {
    it.effect("a turn starting during a trash waits until the trash is done", () =>
      Effect.gen(function* () {
        const catalog = yield* TrellisCatalog.TrellisCatalog;
        yield* catalog.syncNow;
        const project = (yield* projectIdAt(`${ROOT}/workspaces/ws-race/project`))!;
        const trashing = yield* Effect.forkChild(catalog.trashProject(project.projectId));
        // Past the busy check, before Trellis finished the trash.
        yield* Deferred.await(raceState.trashStarted!);
        const turn = yield* Effect.forkChild(
          Effect.flatMap(TurnAdmission, (admission) =>
            admission.start({
              threadId: ThreadId.make("race-thread"),
              runId: RunId.make("race-run"),
              cwd: `${ROOT}/workspaces/ws-race/project/src`,
            }),
          ).pipe(
            Effect.provide(
              TrellisRestore.layer.pipe(
                Layer.provide(Layer.mock(EffectOutboxV2)({})),
                Layer.provide(
                  Layer.mock(ProjectionStore.ProjectionStoreV2)({
                    getThread: () => Effect.succeed({} as never),
                  }),
                ),
              ),
            ),
          ),
        );
        yield* Effect.yieldNow;
        assert.isUndefined(turn.pollUnsafe());
        yield* Deferred.succeed(raceState.trashRelease!, undefined);
        yield* Fiber.join(trashing);
        assert.isTrue(yield* Fiber.join(turn));
        assert.deepEqual(raceState.trashed, ["prj-race"]);
      }),
    );
  });

  // The release, archive and sync after the Trellis trash run under the same
  // gate: a turn admitted meanwhile could be shut down by the release.
  const releaseReached = Deferred.makeUnsafe<void>();
  const releaseGo = Deferred.makeUnsafe<void>();
  const lateState: CatalogState = {
    items: [dedicated("prj-late", "Late", [workspace("ws-late")])],
    trashed: [],
  };
  const slowSessions = Layer.mock(ProviderSessionManagerV2)({
    listLive: Deferred.succeed(releaseReached, undefined).pipe(
      Effect.andThen(Deferred.await(releaseGo)),
      Effect.as([]),
    ),
  });

  effectIt.layer(catalogLayer(lateState, slowSessions))(
    "trash cleanup against turn admission",
    (it) => {
      it.effect("a turn waits until the trash has released sessions, archived and synced", () =>
        Effect.gen(function* () {
          const catalog = yield* TrellisCatalog.TrellisCatalog;
          yield* catalog.syncNow;
          const project = (yield* projectIdAt(`${ROOT}/workspaces/ws-late/project`))!;
          const trashing = yield* Effect.forkChild(catalog.trashProject(project.projectId));
          // Trellis has trashed it; the session release is under way.
          yield* Deferred.await(releaseReached);
          assert.deepEqual(lateState.trashed, ["prj-late"]);
          const turn = yield* Effect.forkChild(
            Effect.flatMap(TurnAdmission, (admission) =>
              admission.start({
                threadId: ThreadId.make("late-thread"),
                runId: RunId.make("late-run"),
                cwd: `${ROOT}/workspaces/ws-late/project`,
              }),
            ).pipe(
              Effect.provide(
                TrellisRestore.layer.pipe(
                  Layer.provide(Layer.mock(EffectOutboxV2)({})),
                  Layer.provide(
                    Layer.mock(ProjectionStore.ProjectionStoreV2)({
                      getThread: () => Effect.succeed({} as never),
                    }),
                  ),
                ),
              ),
            ),
          );
          yield* Effect.yieldNow;
          assert.isUndefined(turn.pollUnsafe());
          yield* Deferred.succeed(releaseGo, undefined);
          yield* Fiber.join(trashing);
          assert.isTrue(yield* Fiber.join(turn));
        }),
      );
    },
  );

  // Runtimes stay live after their threads are archived, until idle release.
  const live = [
    { providerSessionId: "codex-ws-trash", cwd: `${ROOT}/workspaces/ws-trash/project` },
    { providerSessionId: "claude-ws-trash", cwd: `${ROOT}/workspaces/ws-trash/project/src` },
    { providerSessionId: "codex-ws-keep", cwd: `${ROOT}/workspaces/ws-keep/project` },
    { providerSessionId: "codex-scratch", cwd: `${SCRATCH}/idea-t` },
  ].map((session) => ({
    ...session,
    providerSessionId: ProviderSessionId.make(session.providerSessionId),
  }));
  const released: Array<string> = [];
  const sessionsLayer = Layer.mock(ProviderSessionManagerV2)({
    listLive: Effect.succeed(live),
    release: ({ providerSessionId }) =>
      Effect.sync(() => void released.push(providerSessionId)).pipe(
        Effect.andThen(
          providerSessionId === "codex-ws-trash"
            ? Effect.fail(
                new ProviderSessionReleaseError({
                  providerSessionId,
                  reason: "manual_shutdown",
                  cause: "process gone",
                }),
              )
            : Effect.void,
        ),
      ),
  });
  const sessionState: CatalogState = {
    items: [
      dedicated("prj-trash", "Doomed", [workspace("ws-trash")]),
      dedicated("prj-keep", "Kept", [workspace("ws-keep")]),
      idea("idea-t", "Scratch idea"),
    ],
    trashed: [],
  };

  effectIt.layer(catalogLayer(sessionState, sessionsLayer))("trash and live sessions", (it) => {
    it.effect(
      "releases every live runtime in a trashed workspace and reports the ones that fail",
      () =>
        Effect.gen(function* () {
          const catalog = yield* TrellisCatalog.TrellisCatalog;
          yield* catalog.syncNow;
          const doomed = (yield* projectIdAt(`${ROOT}/workspaces/ws-trash/project`))!;
          const failure = yield* catalog.trashProject(doomed.projectId).pipe(Effect.flip);
          // One failure does not stop the other release, nor touch other workspaces.
          assert.deepEqual(released, ["codex-ws-trash", "claude-ws-trash"]);
          assert.include(failure.message, "1 agent session running in it could not be stopped");
          assert.deepEqual(sessionState.trashed, ["prj-trash"]);

          // An idea lives in the scratch workspace, which keeps running.
          released.length = 0;
          const idea = (yield* projectIdAt(`${SCRATCH}/idea-t`))!;
          yield* catalog.trashProject(idea.projectId);
          assert.deepEqual(released, []);
        }),
    );
  });
});

describe("sessionsEndedByTrash", () => {
  const live = [
    { providerSessionId: "codex-ws-b", cwd: "/trellis/workspaces/ws-b/project" },
    { providerSessionId: "claude-ws-b-sub", cwd: "/trellis/workspaces/ws-b/project/src" },
    { providerSessionId: "codex-ws-bb", cwd: "/trellis/workspaces/ws-bb/project" },
    { providerSessionId: "scratch", cwd: "/trellis/workspaces/ws-s/project/idea-a" },
  ];

  it("picks the live runtimes in a trashed workspace, and only those", () => {
    expect(
      TrellisCatalog.sessionsEndedByTrash({
        dedicated: true,
        roots: ["/trellis/workspaces/ws-b/project/"],
        live: [...live, live[0]!],
      }),
    ).toEqual(["codex-ws-b", "claude-ws-b-sub"]);
  });

  it("picks none for an idea, whose scratch workspace keeps running", () => {
    expect(
      TrellisCatalog.sessionsEndedByTrash({
        dedicated: false,
        roots: ["/trellis/workspaces/ws-s/project/idea-a"],
        live,
      }),
    ).toEqual([]);
  });
});
