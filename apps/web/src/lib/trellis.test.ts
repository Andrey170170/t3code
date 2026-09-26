import { describe, expect, it } from "vite-plus/test";

import { ProjectId, type TrellisFindHit } from "@t3tools/contracts";
import {
  isLoopbackPreviewUrl,
  isHiddenRetiredProject,
  isTrellisIdeaPath,
  isTrellisWorkspaceRoot,
  pickTrellisEnvironment,
  trellisFindHitSummary,
  trellisItemKind,
  trellisRemovalOf,
  trellisTrashConfirmation,
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

describe("trellisRemovalOf", () => {
  const idea = "/srv/trellis/workspaces/w1/project/idea-1";

  it("trashes Trellis projects while Trellis is ready", () => {
    expect(trellisRemovalOf(idea, { available: true, root: "/srv/trellis" })).toBe("trash");
  });

  it("keeps recognizing Trellis projects while Trellis is off or down", () => {
    expect(trellisRemovalOf(idea, { available: false, root: "/srv/trellis" })).toBe("offline");
  });

  it("leaves ordinary projects and unknown statuses alone", () => {
    expect(trellisRemovalOf("/home/me/code", { available: true, root: "/srv/trellis" })).toBe(
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
  const active = { id: "active", available: true };
  const primary = { id: "primary", available: true };

  it("prefers the active environment when it runs Trellis", () => {
    expect(pickTrellisEnvironment(active, primary)).toBe(active);
  });

  it("falls back to the primary environment, then to none", () => {
    expect(pickTrellisEnvironment({ ...active, available: false }, primary)).toBe(primary);
    expect(pickTrellisEnvironment(null, primary)).toBe(primary);
    expect(pickTrellisEnvironment(null, { ...primary, available: false })).toBeNull();
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

describe("isLoopbackPreviewUrl", () => {
  it("recognizes loopback preview URLs only", () => {
    expect(isLoopbackPreviewUrl("localhost:5173")).toBe(true);
    expect(isLoopbackPreviewUrl("http://127.0.0.1:3000/x")).toBe(true);
    expect(isLoopbackPreviewUrl("http://[::1]:8080")).toBe(true);
    expect(isLoopbackPreviewUrl("http://0.0.0.0:4000")).toBe(true);
    expect(isLoopbackPreviewUrl("https://example.com")).toBe(false);
    expect(isLoopbackPreviewUrl("http://node.ts.net:21001/")).toBe(false);
  });
});
