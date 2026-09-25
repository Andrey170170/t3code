import { describe, expect, it } from "vite-plus/test";

import { ProjectId, type TrellisFindHit } from "@t3tools/contracts";
import {
  isLoopbackPreviewUrl,
  isTrellisWorkspaceRoot,
  pickTrellisEnvironment,
  trellisFindHitSummary,
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
