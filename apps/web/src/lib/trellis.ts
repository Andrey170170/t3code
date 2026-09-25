import type { TrellisFindHit } from "@t3tools/contracts";

/**
 * Whether a project directory is a Trellis workspace. Trellis-managed projects
 * are ordinary T3 projects whose workspace root lies inside `<root>/workspaces/`,
 * where `root` comes from the environment's Trellis status.
 */
export function isTrellisWorkspaceRoot(
  workspaceRoot: string,
  trellisRoot: string | null | undefined,
): boolean {
  if (!trellisRoot) return false;
  const prefix = `${trellisRoot.replace(/\/+$/, "")}/workspaces/`;
  return workspaceRoot.startsWith(prefix) && workspaceRoot.length > prefix.length;
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
