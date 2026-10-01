import {
  type EnvironmentId,
  isTrellisLandingPad,
  type ProjectId,
  type TrellisFindHit,
  type TrellisState,
} from "@t3tools/contracts";
import { isLoopbackHostname, normalizePreviewUrl } from "@t3tools/shared/preview";
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
  status: {
    readonly state: TrellisState;
    readonly root?: string | null | undefined;
    readonly knownRoots?: ReadonlyArray<string> | undefined;
  } | null,
): "trash" | "offline" | "none" {
  if (status?.state === "ready" && isTrellisWorkspaceRoot(workspaceRoot, status.root)) {
    return "trash";
  }
  // Any root this environment has used counts: the project may belong to an
  // earlier root than the one reported, which the live Trellis cannot trash.
  const roots = [status?.root, ...(status?.knownRoots ?? [])];
  return roots.some((root) => isTrellisWorkspaceRoot(workspaceRoot, root)) ? "offline" : "none";
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

const trimTrailingSlashes = (path: string) => path.replace(/(.)\/+$/, "$1");

/**
 * Whether the sidebar hides a project: its Trellis item is in the trash or
 * graduated (its root is retired), and nothing in it is still active.
 * Restoring the item makes it live again, so it reappears.
 */
export function isHiddenRetiredProject(
  project: { readonly workspaceRoot: string },
  retiredRoots: ReadonlySet<string> | undefined,
  hasActiveThread: boolean,
  hasDraft: boolean,
): boolean {
  if (retiredRoots === undefined || hasActiveThread || hasDraft) return false;
  return retiredRoots.has(trimTrailingSlashes(project.workspaceRoot));
}

/** What kind of Trellis item a T3 project stands for, from its root and the status. */
export function trellisItemKind(
  workspaceRoot: string,
  status: { readonly root?: string | null | undefined; readonly forkRoots?: ReadonlyArray<string> },
): "idea" | "fork" | "project" {
  if (status.root && isTrellisIdeaPath(workspaceRoot, status.root)) return "idea";
  return status.forkRoots?.includes(trimTrailingSlashes(workspaceRoot)) ? "fork" : "project";
}

/** Confirmation lines for moving Trellis-managed projects to the trash. */
export function trellisTrashConfirmation(input: {
  readonly label: string;
  readonly kind: "idea" | "fork" | "project";
  readonly count: number;
}): ReadonlyArray<string> {
  return [
    input.count === 1
      ? `Move ${input.kind} "${input.label}" to the Trellis trash?`
      : `Move ${input.count} Trellis projects to the Trellis trash?`,
    input.kind === "project"
      ? "Its files and history go to the trash, together with its forks; its conversations are archived, not deleted."
      : "Its files and history go to the trash; its conversations are archived, not deleted.",
    "Restore it from Settings → Trellis, which also shows when it is removed for good.",
  ];
}

/**
 * The environment Trellis entry points target: the active thread's or
 * project's environment when Trellis is ready there, otherwise the primary
 * one when it is. Null hides the entry points.
 */
export function pickTrellisEnvironment<T extends { readonly state: TrellisState }>(
  active: T | null,
  primary: T | null,
): T | null {
  if (active?.state === "ready") return active;
  if (primary?.state === "ready") return primary;
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

/**
 * Why a thread cannot move to another project, or null when it may. Only a
 * thread that never ran moves for now: a run's checkpoints belong to the old
 * folder (graduation will move threads with history). A fork moves once it
 * has run, which is too late, so not-yet-run forks are refused as well. The
 * server checks the same rules.
 */
export function threadMoveBlocker(thread: {
  readonly latestRun: object | null;
  readonly runtime: { readonly status: string; readonly activeRunId: string | null } | null;
  readonly forkedFrom: object | null;
}): string | null {
  const status = thread.runtime?.status ?? "idle";
  if (
    (thread.runtime !== null && thread.runtime.activeRunId !== null) ||
    status === "preparing" ||
    status === "queued" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting"
  ) {
    return "This thread is working; wait for it to finish, then move it.";
  }
  if (thread.latestRun !== null) {
    return "This thread has history; graduation will move such threads.";
  }
  if (thread.forkedFrom !== null) {
    return "This fork has not run yet, so it cannot move to another project.";
  }
  return null;
}

/**
 * Trellis projects a thread can move to: projects of the thread's environment
 * under the Trellis root, minus the landing pad, retired items and the
 * thread's current project. Sorted by title.
 */
export function trellisMoveTargets<
  P extends {
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
  },
>(
  projects: ReadonlyArray<P>,
  input: {
    readonly environmentId: EnvironmentId;
    readonly currentProjectId: ProjectId;
    readonly root: string | null;
    readonly retiredRoots?: ReadonlyArray<string> | undefined;
  },
): ReadonlyArray<P> {
  const retired = new Set(input.retiredRoots ?? []);
  return projects
    .filter(
      (project) =>
        project.environmentId === input.environmentId &&
        project.id !== input.currentProjectId &&
        !isTrellisLandingPad(project.id) &&
        isTrellisWorkspaceRoot(project.workspaceRoot, input.root) &&
        !retired.has(trimTrailingSlashes(project.workspaceRoot)),
    )
    .toSorted((left, right) => left.title.localeCompare(right.title));
}

/**
 * The "Move to project" menu of a thread: null when Trellis is not ready in
 * its environment or no Trellis project is there to move to.
 */
export function trellisMoveMenu<
  P extends {
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
  },
>(
  thread: Parameters<typeof threadMoveBlocker>[0] & {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  },
  projects: ReadonlyArray<P>,
  status: {
    readonly state: TrellisState;
    readonly root?: string | null | undefined;
    readonly retiredRoots?: ReadonlyArray<string> | undefined;
  } | null,
): {
  readonly blockedReason: string | null;
  readonly targets: ReadonlyArray<{ readonly projectId: ProjectId; readonly label: string }>;
} | null {
  if (status?.state !== "ready") return null;
  const targets = trellisMoveTargets(projects, {
    environmentId: thread.environmentId,
    currentProjectId: thread.projectId,
    root: status.root ?? null,
    retiredRoots: status.retiredRoots,
  });
  if (targets.length === 0) return null;
  return {
    blockedReason: threadMoveBlocker(thread),
    targets: targets.map((project) => ({ projectId: project.id, label: project.title })),
  };
}

/** Whether a preview URL points at this machine, in any loopback spelling. */
export function isLoopbackPreviewUrl(url: string): boolean {
  try {
    return isLoopbackHostname(new URL(normalizePreviewUrl(url)).hostname);
  } catch {
    return false;
  }
}
