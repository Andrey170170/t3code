/**
 * Trellis path rule shared by the server and clients.
 *
 * A path is Trellis-managed when it is a Trellis project directory or inside
 * one: `<root>/workspaces/<ws>/project[/...]`. The same path exists on the
 * host and inside the workspace container.
 */

/** POSIX path segments with `.`/`..` resolved; null for a relative path. */
function absoluteSegments(path: string): ReadonlyArray<string> | null {
  if (!path.startsWith("/")) return null;
  const segments: Array<string> = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments;
}

/** The workspace id `<ws>` when `path` is `<root>/workspaces/<ws>/project` or below it, else null. */
export function trellisWorkspaceIdOf(root: string, path: string): string | null {
  const rootSegments = absoluteSegments(root);
  const pathSegments = absoluteSegments(path);
  if (rootSegments === null || pathSegments === null) return null;
  if (pathSegments.length < rootSegments.length + 3) return null;
  for (const [index, segment] of rootSegments.entries()) {
    if (pathSegments[index] !== segment) return null;
  }
  return pathSegments[rootSegments.length] === "workspaces" &&
    pathSegments[rootSegments.length + 2] === "project"
    ? (pathSegments[rootSegments.length + 1] ?? null)
    : null;
}

/** True when `path` is `<root>/workspaces/<ws>/project` or below it. */
export function isTrellisManagedPath(root: string, path: string): boolean {
  return trellisWorkspaceIdOf(root, path) !== null;
}

/** True when one absolute path is the other or contains it (trailing slashes ignored). */
export function pathsOverlap(left: string, right: string): boolean {
  const trim = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);
  const inside = (path: string, root: string) =>
    path === root || path.startsWith(root === "/" ? root : `${root}/`);
  const [a, b] = [trim(left), trim(right)];
  return inside(a, b) || inside(b, a);
}
