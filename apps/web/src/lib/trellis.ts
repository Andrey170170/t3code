import type { TrellisFindHit } from "@t3tools/contracts";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";
import { isTrellisManagedPath } from "@t3tools/shared/trellis";

/**
 * Whether a project directory is a Trellis workspace: a project directory
 * `<root>/workspaces/<ws>/project` or below it, where `root` comes from the
 * environment's Trellis status. False without a root.
 */
export function isTrellisWorkspaceRoot(
  workspaceRoot: string,
  trellisRoot: string | null | undefined,
): boolean {
  return trellisRoot ? isTrellisManagedPath(trellisRoot, workspaceRoot) : false;
}

/**
 * What deleting a T3 project does to its Trellis item: `trash` moves it to
 * the Trellis trash (the project is Trellis-managed and Trellis is ready),
 * `offline` means it is Trellis-managed but Trellis cannot be reached, so
 * only T3's entry could be removed, and `none` is an ordinary project.
 */
export function trellisRemovalOf(
  workspaceRoot: string,
  status: { readonly available: boolean; readonly root?: string | null | undefined } | null,
): "trash" | "offline" | "none" {
  if (!isTrellisWorkspaceRoot(workspaceRoot, status?.root)) return "none";
  return status?.available === true ? "trash" : "offline";
}

/** Whether a Trellis project path is an idea folder in scratch rather than a workspace root. */
export function isTrellisIdeaPath(workspaceRoot: string, trellisRoot: string): boolean {
  const relative = workspaceRoot
    .slice(trellisRoot.replace(/\/+$/, "").length)
    .split("/")
    .filter((segment) => segment.length > 0);
  // workspaces/<ws>/project/<idea>
  return relative.length > 3;
}

/** Confirmation lines for moving Trellis-managed projects to the trash. */
export function trellisTrashConfirmation(input: {
  readonly label: string;
  readonly kind: "idea" | "project";
  readonly count: number;
}): ReadonlyArray<string> {
  return [
    input.count === 1
      ? `Move ${input.kind} "${input.label}" to the Trellis trash?`
      : `Move ${input.count} Trellis projects to the Trellis trash?`,
    "Its files and history go to the trash; its conversations are archived, not deleted.",
    "Restore it from Settings → Trellis. Ideas are removed for good after 30 days; projects stay until you empty the trash.",
  ];
}

/**
 * The environment Trellis entry points target: the active thread's or
 * project's environment when it runs Trellis, otherwise the primary one when
 * it does. Null hides the entry points.
 */
export function pickTrellisEnvironment<T extends { readonly available: boolean }>(
  active: T | null,
  primary: T | null,
): T | null {
  if (active?.available === true) return active;
  if (primary?.available === true) return primary;
  return null;
}

/**
 * One-line description for a find hit: its first snippets, or the item's own
 * description when the match was on its name.
 */
export function trellisFindHitSummary(hit: TrellisFindHit, maxSnippets = 2): string {
  const snippets = hit.matches
    .slice(0, maxSnippets)
    .map((match) => match.snippet.replace(/\s+/g, " ").trim())
    .filter((snippet) => snippet.length > 0);
  if (snippets.length > 0) return snippets.join(" · ");
  return hit.description.replace(/\s+/g, " ").trim();
}

/** Whether a preview URL points at loopback (`localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0`). */
export function isLoopbackPreviewUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(normalizePreviewUrl(url)).hostname);
  } catch {
    return false;
  }
}
