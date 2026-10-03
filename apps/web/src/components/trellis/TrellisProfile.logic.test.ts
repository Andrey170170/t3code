import type { TrellisProfileItem, TrellisProfileProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  skillDescription,
  trellisProfileBadges,
  trellisProfileErrorText,
  trellisProfileFreshness,
  trellisProfileGroups,
  trellisProfileLooseErrors,
} from "./TrellisProfile.logic";

const NO_DETAIL = { type: null, url: null, command: null, args: [], path: null, head: null };

const item = (overrides: Partial<TrellisProfileItem> & { name: string }): TrellisProfileItem => ({
  source: { layer: "global", path: null, scope: null },
  enabled: true,
  disabledBy: null,
  status: null,
  error: null,
  approvedBy: null,
  detail: NO_DETAIL,
  ...overrides,
});

const provider = (overrides: Partial<TrellisProfileProvider> = {}): TrellisProfileProvider => ({
  mcp: [],
  skills: [],
  plugins: [],
  instructions: [],
  repository: { mcp: [], skills: [], instructions: [], settings: [] },
  strictMcp: null,
  ...overrides,
});

describe("trellisProfileBadges", () => {
  it("names each special state, and who switched an item off", () => {
    const labels = (input: Partial<TrellisProfileItem>) =>
      trellisProfileBadges({ ...item({ name: "x" }), ...input }).map((badge) => [
        badge.label,
        badge.tone,
      ]);
    expect(labels({})).toEqual([]);
    expect(labels({ enabled: false, status: "needs approval" })).toEqual([
      ["Needs approval", "warning"],
    ]);
    expect(labels({ enabled: false, status: "needs trust" })).toEqual([["Needs trust", "warning"]]);
    expect(labels({ enabled: false, status: "not loaded" })).toEqual([["Not loaded", "info"]]);
    expect(labels({ enabled: false, status: "error" })).toEqual([["Error", "error"]]);
    // Switched off where Trellis cannot enforce it: still active, says both.
    expect(labels({ enabled: false, disabledBy: "project", status: "not enforced" })).toEqual([
      ["Not enforced", "warning"],
      ["Off in project", "outline"],
    ]);
    expect(labels({ enabled: false, disabledBy: "workspace" })).toEqual([
      ["Off in workspace", "outline"],
    ]);
    // A newer Trellis's state shows as it is.
    expect(labels({ status: "quarantined" })).toEqual([["quarantined", "outline"]]);
  });

  it("says who approved an item", () => {
    const [badge] = trellisProfileBadges({
      ...item({ name: "x" }),
      status: "approved",
      approvedBy: "agent ws-1",
    });
    expect(badge?.hint).toContain("By agent ws-1.");
  });
});

describe("skillDescription", () => {
  it("reads the front matter's description, unquoted", () => {
    expect(skillDescription('---\nname: a\ndescription: "Does a thing."\n---')).toBe(
      "Does a thing.",
    );
    expect(skillDescription("---\nname: a\n---")).toBeNull();
    expect(skillDescription("")).toBeNull();
  });
});

describe("trellisProfileGroups", () => {
  const claude = provider({
    mcp: [
      item({
        name: "context7",
        source: { layer: "home", path: "/h/.claude.json", scope: "user" },
        enabled: false,
        disabledBy: "global",
        status: "not enforced",
        detail: { ...NO_DETAIL, type: "stdio", command: "npx", args: ["-y", "ctx7"] },
      }),
      item({
        name: "github",
        source: { layer: "project", path: null, scope: null },
        enabled: false,
        status: "needs approval",
        detail: { ...NO_DETAIL, type: "http", url: "https://gh.example/mcp" },
      }),
    ],
    skills: [
      item({
        name: "grilling",
        source: { layer: "home", path: "/h/skills/grilling", scope: null },
        detail: { ...NO_DETAIL, path: "/h/skills/grilling", head: "---\ndescription: Grill.\n---" },
      }),
    ],
    instructions: [
      {
        layer: "home",
        path: "/h/CLAUDE.md",
        text: null,
        enabled: true,
        status: "not enforced",
        error: null,
        approvedBy: null,
      },
      {
        layer: "global",
        path: null,
        text: "Use jj.\nNever git.",
        enabled: true,
        status: null,
        error: null,
        approvedBy: null,
      },
    ],
    repository: {
      mcp: [
        item({
          name: ".mcp.json:db",
          source: { layer: "project", path: "/p/.mcp.json", scope: "repository" },
          enabled: false,
          status: "needs approval",
        }),
      ],
      skills: [],
      instructions: [],
      settings: [
        item({
          name: ".claude/settings.json",
          source: { layer: "project", path: "/p/.claude/settings.json", scope: "repository" },
          enabled: false,
          status: "needs trust",
        }),
      ],
    },
  });

  it("lists layer items then the repository's, with sources and details", () => {
    const groups = trellisProfileGroups(claude, { withT3Server: false });
    expect(groups.map((group) => group.title)).toEqual([
      "MCP servers",
      "Skills",
      "Instructions",
      "Repository settings",
    ]);
    const [mcp, skills, instructions] = groups;
    expect(mcp?.rows.map((row) => [row.name, row.source, row.detail, row.off])).toEqual([
      // Not enforced: switched off in a layer, yet active, so not dimmed.
      ["context7", "Home · user", "stdio npx -y ctx7", false],
      ["github", "Project", "http https://gh.example/mcp", true],
      [".mcp.json:db", "Project · repository", null, true],
    ]);
    expect(skills?.rows[0]?.detail).toBe("Grill.");
    expect(instructions?.rows.map((row) => [row.name, row.source, row.detail])).toEqual([
      ["CLAUDE.md", "Home", "/h/CLAUDE.md"],
      ["Global instructions", "Global", "Use jj."],
    ]);
  });

  it("puts T3's own server first in a workspace's view", () => {
    const [mcp] = trellisProfileGroups(claude, { withT3Server: true });
    expect(mcp?.rows[0]).toMatchObject({ name: "t3-code", source: "T3", off: false, badges: [] });
    expect(mcp?.rows).toHaveLength(4);
  });

  it("keeps the three main groups when empty, and leaves out empty plugins and settings", () => {
    expect(trellisProfileGroups(provider(), { withT3Server: false }).map((g) => g.key)).toEqual([
      "mcp",
      "skills",
      "instructions",
    ]);
  });
});

describe("trellisProfileErrorText", () => {
  it("names the layer and the item", () => {
    expect(
      trellisProfileErrorText({ layer: "project", item: "mcp.github", error: "no token" }),
    ).toBe("Project · mcp.github: no token");
    expect(trellisProfileErrorText({ layer: "home", item: null, error: "bad toml" })).toBe(
      "Home: bad toml",
    );
  });
});

describe("trellisProfileFreshness", () => {
  const format = (seconds: number) => `t=${seconds}`;

  it("is null without a target, and warns when the profile changed since it was generated", () => {
    expect(
      trellisProfileFreshness({ target: null, generatedAt: null, stale: false }, format),
    ).toBeNull();
    expect(
      trellisProfileFreshness({ target: "ws-1", generatedAt: null, stale: false }, format)?.warning,
    ).toBe(false);
    const current = trellisProfileFreshness(
      { target: "ws-1", generatedAt: 5, stale: false },
      format,
    );
    expect(current).toEqual({ text: expect.stringContaining("Generated t=5."), warning: false });
    const stale = trellisProfileFreshness({ target: "ws-1", generatedAt: 5, stale: true }, format);
    expect(stale?.warning).toBe(true);
    expect(stale?.text).toContain("(t=5)");
  });
});

describe("trellisProfileLooseErrors", () => {
  it("keeps only errors no item of either provider shows", () => {
    const profile = {
      providers: {
        claude: provider({
          skills: [item({ name: "broken", enabled: false, status: "error", error: "no SKILL.md" })],
        }),
        codex: null,
      },
      errors: [
        { layer: "home", item: "skills.broken", error: "no SKILL.md" },
        { layer: "global", item: null, error: 'unknown key "mpc"' },
      ],
    };
    expect(trellisProfileLooseErrors(profile)).toEqual([profile.errors[1]]);
  });
});
