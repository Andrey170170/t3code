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
