import {
  type EnvironmentId,
  isTrellisLandingPad,
  type ProjectId,
  type TrellisFindHit,
  type TrellisState,
  type TrellisWorkspaceEntry,
} from "@t3tools/contracts";
import { isLoopbackHostname, normalizePreviewUrl } from "@t3tools/shared/preview";
import { isTrellisManagedPath, trellisWorkspaceIdOf } from "@t3tools/shared/trellis";

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

/** Whether `path` is a Trellis project path under any of `roots`. */
export function isUnderTrellisRoots(path: string, roots: ReadonlyArray<string>): boolean {
  return roots.some((root) => isTrellisManagedPath(root, path));
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

/**
 * A second line telling same-named Trellis items apart: the kind and the
 * idea folder or the workspace id, e.g. "Idea · idea-x4jh" or "Fork ·
 * ws-q3bn". Null outside the Trellis root.
 */
export function trellisItemDetail(
  workspaceRoot: string,
  status: { readonly root?: string | null | undefined; readonly forkRoots?: ReadonlyArray<string> },
): string | null {
  const workspace = status.root ? trellisWorkspaceIdOf(status.root, workspaceRoot) : null;
  if (workspace === null) return null;
  const kind = trellisItemKind(workspaceRoot, status);
  const label = kind === "idea" ? "Idea" : kind === "fork" ? "Fork" : "Project";
  const where =
    kind === "idea"
      ? (trimTrailingSlashes(workspaceRoot).split("/").at(-1) ?? workspace)
      : workspace;
  return `${label} · ${where}`;
}

/**
 * Keeps a project out of repository grouping when it lives in a Trellis
 * workspace of its environment: each is its own environment, so two clones of
 * one repository there are two projects.
 */
export function trellisKeepSeparate(
  rootsByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyArray<string>>,
): (project: { readonly environmentId: EnvironmentId; readonly workspaceRoot: string }) => boolean {
  return (project) =>
    (rootsByEnvironment.get(project.environmentId) ?? []).some((root) =>
      isTrellisManagedPath(root, project.workspaceRoot),
    );
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
    readonly forkRoots?: ReadonlyArray<string> | undefined;
  } | null,
): {
  readonly blockedReason: string | null;
  readonly targets: ReadonlyArray<{
    readonly projectId: ProjectId;
    readonly label: string;
    /** Kind and idea folder or workspace, telling same-named projects apart. */
    readonly detail: string | null;
  }>;
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
    targets: targets.map((project) => ({
      projectId: project.id,
      label: project.title,
      detail: trellisItemDetail(project.workspaceRoot, {
        root: status.root ?? null,
        ...(status.forkRoots === undefined ? {} : { forkRoots: status.forkRoots }),
      }),
    })),
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

/**
 * Whether the sidebar hides a project as a worker fork: Trellis reports its
 * root as a fork a thread spawned (`workerRoots`), or it is a Trellis project
 * whose only active threads are delegated workers (a fork spawned before the
 * status caught up). A lead or a draft there shows it again. Worker forks are
 * listed with their project's workspaces in its settings instead.
 */
export function isHiddenWorkerProject(
  project: { readonly workspaceRoot: string },
  status: {
    readonly root?: string | null | undefined;
    readonly workerRoots?: ReadonlyArray<string> | undefined;
  } | null,
  threads: { readonly leads: number; readonly workers: number },
  hasDraft: boolean,
): boolean {
  if (status === null || threads.leads > 0 || hasDraft) return false;
  const root = trimTrailingSlashes(project.workspaceRoot);
  if (status.workerRoots?.includes(root)) return true;
  return (
    threads.workers > 0 &&
    isTrellisWorkspaceRoot(root, status.root) &&
    !isTrellisIdeaPath(root, status.root ?? "")
  );
}

export type TrellisWorkspaceFilter = "all" | "leads" | "workers" | "discarded";

/**
 * The workspace list's filters: `leads` are live workspaces nobody spawned
 * (the primary one and forks the user made), `workers` live forks a thread
 * spawned, `discarded` forks in the trash.
 */
export function filterTrellisWorkspaces<
  T extends {
    readonly state: TrellisWorkspaceEntry["state"];
    readonly spawnedBy: TrellisWorkspaceEntry["spawnedBy"];
  },
>(entries: ReadonlyArray<T>, filter: TrellisWorkspaceFilter): ReadonlyArray<T> {
  switch (filter) {
    case "all":
      return entries;
    case "discarded":
      return entries.filter((entry) => entry.state === "discarded");
    case "leads":
      return entries.filter((entry) => entry.state !== "discarded" && entry.spawnedBy === null);
    case "workers":
      return entries.filter((entry) => entry.state !== "discarded" && entry.spawnedBy !== null);
  }
}

const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * One line about a workspace for its list: its state, who spawned it, and for
 * a discarded fork whether it holds unmerged work, when it expires and any
 * purge request.
 */
export function trellisWorkspaceDetail(entry: TrellisWorkspaceEntry): string {
  const state =
    entry.state === "discarded"
      ? "Discarded"
      : entry.state === "checkpointing"
        ? "Checkpointing"
        : entry.state === "running"
          ? "Running"
          : "Stopped";
  const parts = [entry.kind === "primary" ? `${state} · project workspace` : state];
  if (entry.spawnedBy !== null) {
    parts.push(
      `worker fork of "${entry.spawnedBy.title ?? entry.spawnedBy.threadId}"${entry.state === "discarded" ? "" : ", hidden from the sidebar"}`,
    );
  }
  if (entry.state === "discarded") {
    parts.push(
      entry.unmerged === true
        ? `unmerged work${entry.unmergedReason ? ` (${entry.unmergedReason})` : ""}`
        : entry.unmerged === false
          ? "nothing unmerged"
          : "unmerged state unknown",
    );
    parts.push(
      entry.expiresAt === null
        ? "kept until purged"
        : `removed for good on ${dayFormat.format(new Date(entry.expiresAt * 1000))}`,
    );
    if (entry.purgeRequested !== null) {
      parts.push(
        `purge requested${entry.purgeRequested.by ? ` by "${entry.purgeRequested.by}"` : ""}${entry.purgeRequested.reason ? `: ${entry.purgeRequested.reason}` : ""}`,
      );
    }
  }
  return parts.join(" · ");
}
