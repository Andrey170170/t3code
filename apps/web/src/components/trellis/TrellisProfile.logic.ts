import type {
  TrellisProfile,
  TrellisProfileInstructions,
  TrellisProfileItem,
  TrellisProfileProvider,
  TrellisProfileSource,
} from "@t3tools/contracts";

/** How a profile row's badge reads: `warning` for states the user may need to act on. */
export type TrellisProfileBadgeTone = "warning" | "error" | "success" | "info" | "outline";

export interface TrellisProfileBadge {
  readonly label: string;
  readonly tone: TrellisProfileBadgeTone;
  /** What the state means, for a tooltip. */
  readonly hint: string | null;
}

/** One MCP server, skill, plugin, instructions entry or repository file, ready to show. */
export interface TrellisProfileRow {
  readonly key: string;
  readonly name: string;
  /** `Home · ~/.agents`, `Project · repository`, `T3`. */
  readonly source: string;
  /** A server's transport and endpoint, a skill's description, an instruction's text. */
  readonly detail: string | null;
  readonly error: string | null;
  /** Off for the provider (dimmed). */
  readonly off: boolean;
  readonly badges: ReadonlyArray<TrellisProfileBadge>;
}

export interface TrellisProfileGroup {
  readonly key: "mcp" | "skills" | "plugins" | "instructions" | "settings";
  readonly title: string;
  readonly rows: ReadonlyArray<TrellisProfileRow>;
}

/**
 * T3's own MCP server, which T3 passes at every provider launch in a
 * workspace; Trellis never sees it, so the workspace view adds it.
 */
const T3_CODE_MCP_ITEM: TrellisProfileItem = {
  name: "t3-code",
  source: { layer: "t3", path: null, scope: null },
  enabled: true,
  disabledBy: null,
  status: null,
  error: null,
  approvedBy: null,
  detail: { type: "http", url: null, command: null, args: [], path: null, head: null },
};

const LAYER_LABELS: Readonly<Record<string, string>> = {
  home: "Home",
  global: "Global",
  project: "Project",
  workspace: "Workspace",
  t3: "T3",
};

const layerLabel = (layer: string) => LAYER_LABELS[layer] ?? layer;

/** The layer an item comes from, with its scope within the layer. */
function trellisProfileSourceLabel(source: Pick<TrellisProfileSource, "layer" | "scope">) {
  const layer = layerLabel(source.layer);
  return source.scope === null ? layer : `${layer} · ${source.scope}`;
}

const STATUS_BADGES: Readonly<
  Record<
    string,
    { readonly label: string; readonly tone: TrellisProfileBadgeTone; readonly hint: string }
  >
> = {
  "needs approval": {
    label: "Needs approval",
    tone: "warning",
    hint: "Off until its current definition is approved, since the project is not trusted.",
  },
  "needs trust": {
    label: "Needs trust",
    tone: "warning",
    hint: "Read only in a trusted project.",
  },
  "not enforced": {
    label: "Not enforced",
    tone: "warning",
    hint: "Trellis cannot switch it off: the provider reads it anyway.",
  },
  "not loaded": {
    label: "Not loaded",
    tone: "info",
    hint: "Declared where the provider does not read it.",
  },
  approved: { label: "Approved", tone: "success", hint: "Approved for this project." },
  error: { label: "Error", tone: "error", hint: "Left out of the profile." },
};

/** The state badges of an item: its status, or "Off" with the layer that switched it off. */
export function trellisProfileBadges(
  item: Pick<TrellisProfileItem, "enabled" | "disabledBy" | "status" | "approvedBy">,
): ReadonlyArray<TrellisProfileBadge> {
  const badges: Array<TrellisProfileBadge> = [];
  if (item.status !== null) {
    const known = STATUS_BADGES[item.status];
    const approvedBy = item.approvedBy === null ? "" : ` By ${item.approvedBy}.`;
    badges.push(
      known === undefined
        ? { label: item.status, tone: "outline", hint: null }
        : { ...known, hint: `${known.hint}${approvedBy}` },
    );
  }
  // A layer's switch always shows (also on an approved item), and an
  // approved item that is off says so; an item off for its status alone
  // (approval, trust, error) has that badge only.
  if (
    !item.enabled &&
    (item.disabledBy !== null ||
      item.status === null ||
      item.status === "not enforced" ||
      // Approval and enablement are separate: an approved item can still be off.
      item.status === "approved")
  ) {
    badges.push({
      label:
        item.disabledBy === null ? "Off" : `Off in ${layerLabel(item.disabledBy).toLowerCase()}`,
      tone: "outline",
      hint: item.disabledBy === null ? null : `Switched off by the ${item.disabledBy} layer.`,
    });
  }
  return badges;
}

/** The `description:` of a SKILL.md front matter, unquoted; null without one. */
export function skillDescription(head: string): string | null {
  for (const line of head.split("\n")) {
    const match = /^description:\s*(.*)$/.exec(line);
    if (match?.[1] === undefined) continue;
    const value = match[1].trim().replace(/^(["'])(.*)\1$/, "$2");
    return value.length > 0 ? value : null;
  }
  return null;
}

/** A server's `http https://…` or `stdio npx -y pkg`, or a skill's description. */
function itemDetail(item: TrellisProfileItem): string | null {
  const { detail } = item;
  if (detail.url !== null) return `${detail.type ?? "http"} ${detail.url}`;
  if (detail.command !== null) {
    return `${detail.type ?? "stdio"} ${[detail.command, ...detail.args].join(" ")}`;
  }
  if (detail.head !== null) return skillDescription(detail.head);
  return detail.type;
}

const itemRow =
  (group: string) =>
  (item: TrellisProfileItem, index: number): TrellisProfileRow => ({
    key: `${group}:${item.source.layer}:${item.name}:${index}`,
    name: item.name,
    source: trellisProfileSourceLabel(item.source),
    detail: itemDetail(item),
    error: item.error,
    off: !item.enabled && item.status !== "not enforced",
    badges: trellisProfileBadges(item),
  });

/** The last path segment: `CLAUDE.md` for `/home/me/.claude/CLAUDE.md`. */
const baseName = (path: string) => path.split("/").findLast((part) => part.length > 0) ?? path;

/** The first line of a text, cut to `max` characters. */
function firstLine(text: string, max = 120): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const instructionsRow = (entry: TrellisProfileInstructions, index: number): TrellisProfileRow => ({
  key: `instructions:${entry.layer}:${index}`,
  name: entry.path === null ? `${layerLabel(entry.layer)} instructions` : baseName(entry.path),
  source: layerLabel(entry.layer),
  detail: entry.text === null ? entry.path : firstLine(entry.text),
  error: entry.error,
  off: !entry.enabled && entry.status !== "not enforced",
  badges: trellisProfileBadges({ ...entry, disabledBy: null }),
});

/**
 * A provider's effective profile as display groups: MCP servers, skills and
 * instructions (each with the repository's own after the layers'), then
 * Claude's plugins and the repository's settings files when there are any.
 * `withT3Server` puts T3's own server first, for a workspace's view.
 */
export function trellisProfileGroups(
  provider: TrellisProfileProvider,
  options: { readonly withT3Server: boolean },
): ReadonlyArray<TrellisProfileGroup> {
  const mcp = [
    ...(options.withT3Server ? [T3_CODE_MCP_ITEM] : []),
    ...provider.mcp,
    ...provider.repository.mcp,
  ];
  const groups: Array<TrellisProfileGroup> = [
    { key: "mcp", title: "MCP servers", rows: mcp.map(itemRow("mcp")) },
    {
      key: "skills",
      title: "Skills",
      rows: [...provider.skills, ...provider.repository.skills].map(itemRow("skills")),
    },
    {
      key: "instructions",
      title: "Instructions",
      rows: [
        ...provider.instructions.map(instructionsRow),
        ...provider.repository.instructions.map(itemRow("instructions")),
      ],
    },
  ];
  if (provider.plugins.length > 0) {
    groups.push({
      key: "plugins",
      title: "Plugins",
      rows: provider.plugins.map(itemRow("plugins")),
    });
  }
  if (provider.repository.settings.length > 0) {
    groups.push({
      key: "settings",
      title: "Repository settings",
      rows: provider.repository.settings.map(itemRow("settings")),
    });
  }
  return groups;
}

/**
 * The profile's errors not already shown inline on an item of the shown
 * provider (a malformed layer file, a server Codex merges, or an item of the
 * other provider). An error is shown inline when an item of the same layer
 * and name carries the same message; Trellis names items `mcp.NAME`,
 * `skills.NAME`, `.claude/skills/NAME` or `instructions`.
 */
export function trellisProfileLooseErrors(
  errors: TrellisProfile["errors"],
  provider: TrellisProfileProvider | null,
): TrellisProfile["errors"] {
  if (provider === null) return errors;
  const { repository } = provider;
  const inline = [
    ...[
      ...provider.mcp,
      ...provider.skills,
      ...provider.plugins,
      ...repository.mcp,
      ...repository.skills,
      ...repository.instructions,
      ...repository.settings,
    ].map((item) => ({ layer: item.source.layer, name: item.name, error: item.error })),
    ...provider.instructions.map((entry) => ({
      layer: entry.layer,
      name: "instructions",
      error: entry.error,
    })),
  ].filter((entry) => entry.error !== null);
  const namesItem = (item: string | null, name: string) =>
    item === name || item?.endsWith(`.${name}`) === true || item?.endsWith(`/${name}`) === true;
  return errors.filter(
    (entry) =>
      !inline.some(
        (shown) =>
          shown.layer === entry.layer &&
          shown.error === entry.error &&
          namesItem(entry.item, shown.name),
      ),
  );
}

/** A profile error as one line: `project · mcp.github: GITHUB_TOKEN is not set`. */
export const trellisProfileErrorText = (entry: TrellisProfile["errors"][number]) =>
  `${layerLabel(entry.layer)}${entry.item === null ? "" : ` · ${entry.item}`}: ${entry.error}`;

/**
 * When a workspace's profile files were written and whether they are behind,
 * in words; null for a view without a target (nothing is generated for it).
 * Providers read the files when they start, so sessions opened before
 * `generatedAt` run with the earlier profile.
 */
export function trellisProfileFreshness(
  profile: Pick<TrellisProfile, "target" | "generatedAt" | "stale">,
  formatTime: (unixSeconds: number) => string,
): { readonly text: string; readonly warning: boolean } | null {
  if (profile.target === null) return null;
  if (profile.generatedAt === null) {
    return {
      text: "Not generated yet: Trellis writes it when the workspace starts.",
      warning: false,
    };
  }
  const generated = formatTime(profile.generatedAt);
  return profile.stale
    ? {
        text: `Changed since it was generated (${generated}). Trellis applies it at the next turn or start; sessions opened before then keep the earlier profile.`,
        warning: true,
      }
    : {
        text: `Generated ${generated}. Sessions opened before then run with the earlier profile.`,
        warning: false,
      };
}
