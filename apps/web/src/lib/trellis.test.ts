import { describe, expect, it } from "vite-plus/test";

import { ProjectId, type TrellisFindHit } from "@t3tools/contracts";
import { isTrellisWorkspaceRoot, trellisFindHitSummary } from "./trellis";

describe("isTrellisWorkspaceRoot", () => {
  it("matches directories inside <root>/workspaces/", () => {
    expect(isTrellisWorkspaceRoot("/srv/trellis/workspaces/scratch/idea", "/srv/trellis")).toBe(
      true,
    );
    expect(isTrellisWorkspaceRoot("/srv/trellis/workspaces/p1", "/srv/trellis/")).toBe(true);
  });

  it("rejects the workspaces directory itself, siblings and lookalike prefixes", () => {
    expect(isTrellisWorkspaceRoot("/srv/trellis/workspaces/", "/srv/trellis")).toBe(false);
    expect(isTrellisWorkspaceRoot("/srv/trellis/workspaces", "/srv/trellis")).toBe(false);
    expect(isTrellisWorkspaceRoot("/srv/trellis/state/x", "/srv/trellis")).toBe(false);
    expect(isTrellisWorkspaceRoot("/srv/trellis-old/workspaces/x", "/srv/trellis")).toBe(false);
  });

  it("is false without a root, so an unavailable Trellis marks nothing", () => {
    expect(isTrellisWorkspaceRoot("/srv/trellis/workspaces/x", undefined)).toBe(false);
    expect(isTrellisWorkspaceRoot("/srv/trellis/workspaces/x", "")).toBe(false);
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
