import { describe, expect, it } from "vite-plus/test";

import {
  EnvironmentId,
  ProjectId,
  TRELLIS_LANDING_PAD_PROJECT_ID,
  ThreadId,
  type TrellisFindHit,
  type TrellisState,
  type TrellisWorkspaceEntry,
} from "@t3tools/contracts";
import {
  filterTrellisWorkspaces,
  isHiddenRetiredProject,
  isHiddenWorkerProject,
  isLoopbackPreviewUrl,
  isTrellisIdeaPath,
  isTrellisWorkspaceRoot,
  isUnderTrellisRoots,
  pickTrellisEnvironment,
  threadMoveBlocker,
  trellisFindHitSummary,
  trellisItemDetail,
  trellisItemKind,
  trellisKeepSeparate,
  trellisMoveMenu,
  trellisMoveTargets,
  trellisRemovalOf,
  trellisTrashConfirmation,
  trellisWorkspaceDetail,
} from "./trellis";

describe("isTrellisWorkspaceRoot", () => {
  it("matches project directories inside <root>/workspaces/<ws>/", () => {
    expect(isTrellisWorkspaceRoot("/srv/trellis/workspaces/w1/project", "/srv/trellis")).toBe(true);
    expect(isTrellisWorkspaceRoot("/srv/trellis/workspaces/w1/project/sub", "/srv/trellis/")).toBe(
      true,
    );
  });

  it("rejects workspace directories that are not the project, and lookalike prefixes", () => {
    expect(isTrellisWorkspaceRoot("/srv/trellis/workspaces/w1", "/srv/trellis")).toBe(false);
    expect(isTrellisWorkspaceRoot("/srv/trellis/workspaces/w1/state", "/srv/trellis")).toBe(false);
    expect(isTrellisWorkspaceRoot("/srv/trellis-old/workspaces/w1/project", "/srv/trellis")).toBe(
      false,
    );
  });

  it("is false without a root, so an unavailable Trellis marks nothing", () => {
    expect(isTrellisWorkspaceRoot("/srv/trellis/workspaces/w1/project", undefined)).toBe(false);
    expect(isTrellisWorkspaceRoot("/srv/trellis/workspaces/w1/project", null)).toBe(false);
    expect(isTrellisWorkspaceRoot("/srv/trellis/workspaces/w1/project", "")).toBe(false);
  });
});

describe("isUnderTrellisRoots", () => {
  it("recognizes project paths under an earlier root too", () => {
    const roots = ["/trellis", "/old-trellis"];
    expect(isUnderTrellisRoots("/old-trellis/workspaces/ws-1/project/idea-a", roots)).toBe(true);
    expect(isUnderTrellisRoots("/trellis/workspaces/ws-2/project", roots)).toBe(true);
    expect(isUnderTrellisRoots("/home/me/code", roots)).toBe(false);
  });
});

describe("trellisRemovalOf", () => {
  const idea = "/srv/trellis/workspaces/w1/project/idea-1";

  it("trashes Trellis projects while Trellis is ready", () => {
    expect(trellisRemovalOf(idea, { state: "ready", root: "/srv/trellis" })).toBe("trash");
  });

  it("keeps recognizing Trellis projects while Trellis is off or down", () => {
    expect(trellisRemovalOf(idea, { state: "unavailable", root: "/srv/trellis" })).toBe("offline");
    expect(
      trellisRemovalOf(idea, {
        state: "unavailable",
        root: "/srv/trellis-dev",
        knownRoots: ["/srv/trellis", "/srv/trellis-dev"],
      }),
    ).toBe("offline");
  });

  it("does not take a project of an earlier root for an ordinary one once Trellis moved", () => {
    expect(
      trellisRemovalOf(idea, {
        state: "ready",
        root: "/srv/trellis-dev",
        knownRoots: ["/srv/trellis", "/srv/trellis-dev"],
      }),
    ).toBe("offline");
  });

  it("leaves ordinary projects and unknown statuses alone", () => {
    expect(trellisRemovalOf("/home/me/code", { state: "ready", root: "/srv/trellis" })).toBe(
      "none",
    );
    expect(trellisRemovalOf(idea, null)).toBe("none");
  });
});

describe("isHiddenRetiredProject", () => {
  const retired = new Set(["/srv/trellis/workspaces/w1/project"]);
  const project = { workspaceRoot: "/srv/trellis/workspaces/w1/project/" };

  it("hides a trashed project once nothing in it is active", () => {
    expect(isHiddenRetiredProject(project, retired, false, false)).toBe(true);
  });

  it("keeps it while a thread is active or a draft exists, and keeps live projects", () => {
    expect(isHiddenRetiredProject(project, retired, true, false)).toBe(false);
    expect(isHiddenRetiredProject(project, retired, false, true)).toBe(false);
    expect(isHiddenRetiredProject({ workspaceRoot: "/home/me/code" }, retired, false, false)).toBe(
      false,
    );
    expect(isHiddenRetiredProject(project, undefined, false, false)).toBe(false);
  });
});

describe("trellisItemKind and the trash confirmation", () => {
  const status = {
    root: "/srv/trellis",
    forkRoots: ["/srv/trellis/workspaces/w2/project"],
  };

  it("tells ideas, forks and projects apart", () => {
    expect(trellisItemKind("/srv/trellis/workspaces/w1/project/idea-1", status)).toBe("idea");
    expect(trellisItemKind("/srv/trellis/workspaces/w2/project", status)).toBe("fork");
    expect(trellisItemKind("/srv/trellis/workspaces/w1/project", status)).toBe("project");
  });

  it("mentions forks only when a whole project goes to the trash", () => {
    const text = (kind: "idea" | "fork" | "project") =>
      trellisTrashConfirmation({ label: "App", kind, count: 1 }).join("\n");
    expect(text("project")).toContain("forks");
    expect(text("fork")).not.toContain("forks");
    expect(text("fork")).toContain('Move fork "App"');
  });
});

describe("isTrellisIdeaPath", () => {
  it("tells idea folders from workspace roots", () => {
    expect(isTrellisIdeaPath("/srv/trellis/workspaces/w1/project/idea-1", "/srv/trellis/")).toBe(
      true,
    );
    expect(isTrellisIdeaPath("/srv/trellis/workspaces/w1/project", "/srv/trellis")).toBe(false);
  });
});

describe("pickTrellisEnvironment", () => {
  const active: { id: string; state: TrellisState } = { id: "active", state: "ready" };
  const primary: { id: string; state: TrellisState } = { id: "primary", state: "ready" };

  it("prefers the active environment when it runs Trellis", () => {
    expect(pickTrellisEnvironment(active, primary)).toBe(active);
  });

  it("falls back to the primary environment, then to none", () => {
    expect(pickTrellisEnvironment({ ...active, state: "disabled" }, primary)).toBe(primary);
    expect(pickTrellisEnvironment(null, primary)).toBe(primary);
    expect(pickTrellisEnvironment(null, { ...primary, state: "unavailable" })).toBeNull();
  });
});

describe("trellisFindHitSummary", () => {
  const hit = (overrides: Partial<TrellisFindHit>): TrellisFindHit => ({
    projectId: ProjectId.make("p1"),
    kind: "idea",
    name: "idea",
    description: "A  loose\nthought",
    path: "/srv/trellis/workspaces/scratch/idea",
    matches: [],
    ...overrides,
  });

  it("joins the first snippets with collapsed whitespace", () => {
    expect(
      trellisFindHitSummary(
        hit({
          matches: [
            { path: "a.md", snippet: "first\n  match" },
            { path: "b.md", snippet: "second" },
            { path: "c.md", snippet: "third" },
          ],
        }),
      ),
    ).toBe("first match · second");
  });

  it("falls back to the description when nothing matched inside files", () => {
    expect(trellisFindHitSummary(hit({}))).toBe("A loose thought");
  });
});

describe("trellisMoveTargets", () => {
  const env = EnvironmentId.make("env-1");
  const project = (id: string, title: string, workspaceRoot: string, environmentId = env) => ({
    environmentId,
    id: ProjectId.make(id),
    title,
    workspaceRoot,
  });
  const projects = [
    project("current", "Current", "/srv/trellis/workspaces/w1/project"),
    project("b", "Beta", "/srv/trellis/workspaces/w2/project"),
    project("a", "Alpha", "/srv/trellis/workspaces/w3/project/idea-1"),
    project("retired", "Retired", "/srv/trellis/workspaces/w4/project"),
    project("plain", "Plain", "/home/me/code"),
    project(
      "other-env",
      "Elsewhere",
      "/srv/trellis/workspaces/w5/project",
      EnvironmentId.make("env-2"),
    ),
    project(TRELLIS_LANDING_PAD_PROJECT_ID, "Landing", "/srv/trellis/workspaces/w6/project"),
  ];

  it("lists live Trellis projects of the thread's environment except its own, by title", () => {
    const targets = trellisMoveTargets(projects, {
      environmentId: env,
      currentProjectId: ProjectId.make("current"),
      root: "/srv/trellis",
      retiredRoots: ["/srv/trellis/workspaces/w4/project"],
    });
    expect(targets.map((target) => target.id)).toEqual(["a", "b"]);
  });

  it("lists nothing without a Trellis root", () => {
    expect(
      trellisMoveTargets(projects, {
        environmentId: env,
        currentProjectId: ProjectId.make("current"),
        root: null,
      }),
    ).toEqual([]);
  });
});

describe("threadMoveBlocker", () => {
  const idle = { status: "idle", activeRunId: null };

  it("lets only threads that never ran move", () => {
    expect(threadMoveBlocker({ latestRun: null, runtime: null, forkedFrom: null })).toBeNull();
    expect(threadMoveBlocker({ latestRun: {}, runtime: idle, forkedFrom: null })).toContain(
      "history",
    );
  });

  it("blocks busy threads and forks that have not run", () => {
    expect(
      threadMoveBlocker({
        latestRun: {},
        runtime: { status: "running", activeRunId: "run-1" },
        forkedFrom: null,
      }),
    ).toContain("working");
    expect(
      threadMoveBlocker({
        latestRun: {},
        runtime: { status: "queued", activeRunId: null },
        forkedFrom: null,
      }),
    ).toContain("working");
    expect(threadMoveBlocker({ latestRun: null, runtime: idle, forkedFrom: {} })).toContain("fork");
  });
});

describe("isLoopbackPreviewUrl", () => {
  it("recognizes loopback preview URLs only", () => {
    expect(isLoopbackPreviewUrl("localhost:5173")).toBe(true);
    expect(isLoopbackPreviewUrl("http://127.0.0.1:3000/x")).toBe(true);
    expect(isLoopbackPreviewUrl("http://[::1]:8080")).toBe(true);
    expect(isLoopbackPreviewUrl("http://0.0.0.0:4000")).toBe(true);
    expect(isLoopbackPreviewUrl("http://127.0.0.2:8000/")).toBe(true);
    expect(isLoopbackPreviewUrl("http://localhost.:8000/")).toBe(true);
    expect(isLoopbackPreviewUrl("http://[::ffff:127.0.0.1]:8000/")).toBe(true);
    expect(isLoopbackPreviewUrl("https://example.com")).toBe(false);
    expect(isLoopbackPreviewUrl("http://node.ts.net:21001/")).toBe(false);
  });
});

describe("same-named Trellis items", () => {
  const env = EnvironmentId.make("env-1");
  const status = {
    state: "ready" as TrellisState,
    root: "/srv/trellis",
    forkRoots: ["/srv/trellis/workspaces/w3/project"],
  };
  const project = (id: string, title: string, workspaceRoot: string) => ({
    environmentId: env,
    id: ProjectId.make(id),
    title,
    workspaceRoot,
  });

  it("moves list each target with its kind and idea folder or workspace", () => {
    const menu = trellisMoveMenu(
      {
        environmentId: env,
        projectId: ProjectId.make("here"),
        latestRun: null,
        runtime: null,
        forkedFrom: null,
      },
      [
        project("here", "Here", "/srv/trellis/workspaces/w0/project"),
        project("c1", "click", "/srv/trellis/workspaces/w1/project"),
        project("c2", "click", "/srv/trellis/workspaces/w2/project/"),
        project("f", "click", "/srv/trellis/workspaces/w3/project"),
        project("i", "Idea", "/srv/trellis/workspaces/ws/project/idea-x4jh"),
      ],
      status,
    );
    expect(menu?.targets.map((target) => [target.label, target.detail])).toEqual([
      ["click", "Project · w1"],
      ["click", "Project · w2"],
      ["click", "Fork · w3"],
      ["Idea", "Idea · idea-x4jh"],
    ]);
  });

  it("has no detail outside the Trellis root", () => {
    expect(trellisItemDetail("/home/me/click", status)).toBeNull();
    expect(trellisItemDetail("/srv/trellis/workspaces/w1/project", { root: null })).toBeNull();
  });

  it("keeps a project apart only in a Trellis workspace of its own environment", () => {
    const keepSeparate = trellisKeepSeparate(new Map([[env, ["/srv/trellis", "/old/trellis"]]]));
    expect(
      keepSeparate({ environmentId: env, workspaceRoot: "/srv/trellis/workspaces/w1/project" }),
    ).toBe(true);
    expect(
      keepSeparate({ environmentId: env, workspaceRoot: "/old/trellis/workspaces/w9/project" }),
    ).toBe(true);
    expect(keepSeparate({ environmentId: env, workspaceRoot: "/home/me/click" })).toBe(false);
    expect(
      keepSeparate({
        environmentId: EnvironmentId.make("env-2"),
        workspaceRoot: "/srv/trellis/workspaces/w1/project",
      }),
    ).toBe(false);
  });
});

describe("worker forks", () => {
  const root = "/trellis";
  const fork = `${root}/workspaces/ws-w/project`;
  const status = { root, workerRoots: [fork] };

  it("hides a worker fork from the sidebar unless a lead or a draft is there", () => {
    const project = { workspaceRoot: fork };
    const workers = { leads: 0, forkWorkers: 1 };
    expect(isHiddenWorkerProject(project, status, workers, false)).toBe(true);
    expect(isHiddenWorkerProject(project, status, { leads: 0, forkWorkers: 0 }, false)).toBe(true);
    expect(isHiddenWorkerProject(project, status, { leads: 1, forkWorkers: 1 }, false)).toBe(false);
    expect(isHiddenWorkerProject(project, status, workers, true)).toBe(false);
    expect(isHiddenWorkerProject(project, null, workers, false)).toBe(false);
  });

  it("hides a fork whose workers' leads work elsewhere before the status lists it", () => {
    const fresh = { workspaceRoot: `${root}/workspaces/ws-new/project` };
    expect(isHiddenWorkerProject(fresh, { root }, { leads: 0, forkWorkers: 1 }, false)).toBe(true);
    // A workspace whose only threads are its own lead's workers (an archived lead) stays,
    // as do an empty fork the user made and host folders.
    expect(isHiddenWorkerProject(fresh, { root }, { leads: 0, forkWorkers: 0 }, false)).toBe(false);
    const host = { workspaceRoot: "/home/me/code" };
    expect(isHiddenWorkerProject(host, { root }, { leads: 0, forkWorkers: 1 }, false)).toBe(false);
  });

  const entry = (
    id: string,
    patch: Partial<TrellisWorkspaceEntry> = {},
  ): TrellisWorkspaceEntry => ({
    id,
    name: id,
    kind: "fork",
    state: "running",
    projectId: null,
    spawnedBy: null,
    createdAt: 1,
    deletedAt: null,
    unmerged: null,
    unmergedReason: null,
    expiresAt: null,
    purgeRequested: null,
    ...patch,
  });
  const lead = ThreadId.make("lead");
  const entries = [
    entry("ws-a", { kind: "primary" }),
    entry("ws-mine"),
    entry("ws-w", { spawnedBy: { threadId: lead, title: "Lead" }, state: "stopped" }),
    entry("ws-d", {
      spawnedBy: { threadId: lead, title: "Lead" },
      state: "discarded",
      deletedAt: 5,
      unmerged: true,
      unmergedReason: "uncommitted changes",
      purgeRequested: { at: 6, reason: "dead end", by: "Lead" },
    }),
  ];

  it("filters the workspace list into leads, workers and discarded forks", () => {
    const ids = (filter: Parameters<typeof filterTrellisWorkspaces>[1]) =>
      filterTrellisWorkspaces(entries, filter).map((item) => item.id);
    expect(ids("all")).toEqual(["ws-a", "ws-mine", "ws-w", "ws-d"]);
    expect(ids("leads")).toEqual(["ws-a", "ws-mine"]);
    expect(ids("workers")).toEqual(["ws-w"]);
    expect(ids("discarded")).toEqual(["ws-d"]);
  });

  it("describes a worker fork and a discarded fork's trash state", () => {
    expect(trellisWorkspaceDetail(entries[2]!)).toBe(
      'Stopped · worker fork of "Lead", hidden from the sidebar',
    );
    expect(trellisWorkspaceDetail(entries[3]!)).toBe(
      'Discarded · worker fork of "Lead" · unmerged work (uncommitted changes) · kept until purged · purge requested by "Lead": dead end',
    );
    expect(trellisWorkspaceDetail(entries[0]!)).toBe("Running · project workspace");
  });
});
