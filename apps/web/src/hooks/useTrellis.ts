import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
  TrellisFindHit,
  OrchestrationV2AcknowledgedWork,
  TrellisGraduateInput,
  TrellisNewProjectInput,
  TrellisRestoreConflictsInput,
  TrellisState,
} from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { threadEnvironment } from "~/state/threads";
import { useComposerDraftStore } from "~/composerDraftStore";
import { pickTrellisEnvironment } from "~/lib/trellis";
import { waitForProject } from "~/state/entities";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useDebouncedValue } from "~/state/queries";
import { useEnvironmentQuery } from "~/state/query";
import {
  loadTrellisStatus,
  readTrellisStatus,
  refreshTrellisStatus,
  trellisEnvironment,
} from "~/state/trellis";
import { trellisTrashedKey, useTrellisTrashedStore } from "~/state/trellisTrashed";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useAtomCommand } from "~/state/use-atom-command";
import { resolveThreadRouteTarget } from "~/threadRoutes";
import { useNewThreadHandler } from "./useHandleNewThread";

const TRELLIS_FIND_DEBOUNCE_MS = 250;
const EMPTY_HITS: ReadonlyArray<TrellisFindHit> = [];

interface TrellisEnvironment {
  readonly environmentId: EnvironmentId;
  readonly state: TrellisState;
  readonly root: string | null;
  /** Every root its Trellis projects may live under, including earlier ones. */
  readonly knownRoots: ReadonlyArray<string>;
  /** Roots of trashed or graduated items, hidden once they have no active thread. */
  readonly retiredRoots: ReadonlyArray<string>;
  readonly forkRoots: ReadonlyArray<string>;
}

const NO_ROOTS: ReadonlyArray<string> = [];

/** Trellis status of one environment; null while unknown or without an environment. */
export function useTrellisStatusFor(
  environmentId: EnvironmentId | null,
): TrellisEnvironment | null {
  const status = useEnvironmentQuery(
    environmentId === null ? null : trellisEnvironment.status({ environmentId, input: {} }),
  ).data;
  // Servers without Trellis fail the query, which reads as unavailable.
  const state = status?.state ?? "unavailable";
  const root = status?.root ?? null;
  const knownRoots = status?.knownRoots ?? NO_ROOTS;
  const retiredRoots = status?.retiredRoots ?? NO_ROOTS;
  const forkRoots = status?.forkRoots ?? NO_ROOTS;
  return useMemo(
    () =>
      environmentId === null
        ? null
        : { environmentId, state, root, knownRoots, retiredRoots, forkRoots },
    [environmentId, forkRoots, knownRoots, retiredRoots, root, state],
  );
}

/**
 * Where an environment's Trellis project paths live, also while its
 * integration is off or Trellis is down: those projects stay Trellis
 * workspaces. Null marks nothing as Trellis-managed.
 */
export function useTrellisRoot(environmentId: EnvironmentId | null): string | null {
  return useTrellisStatusFor(environmentId)?.root ?? null;
}

/**
 * Every root an environment's Trellis project paths may live under, the
 * current one and earlier ones, so projects of an earlier root still count.
 */
export function useTrellisKnownRoots(environmentId: EnvironmentId | null): ReadonlyArray<string> {
  const status = useTrellisStatusFor(environmentId);
  const root = status?.root ?? null;
  const knownRoots = status?.knownRoots ?? NO_ROOTS;
  return useMemo(
    () => [...new Set([...(root === null ? [] : [root]), ...knownRoots])],
    [root, knownRoots],
  );
}

/** Environment of the routed thread or draft, if any. */
function useActiveEnvironmentId(): EnvironmentId | null {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const draftEnvironmentId = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft"
      ? (store.getDraftSession(routeTarget.draftId)?.environmentId ?? null)
      : null,
  );
  return routeTarget?.kind === "server" ? routeTarget.threadRef.environmentId : draftEnvironmentId;
}

/**
 * The environment Trellis entry points (new idea, new project, find) target:
 * the active thread's environment when Trellis is ready there, otherwise the
 * primary one when it is. `label` names it when several environments are
 * connected, so entry points can say where they create. Null hides every
 * Trellis entry point.
 */
export function useTrellisEnvironment(): {
  readonly environmentId: EnvironmentId;
  readonly root: string | null;
  readonly label: string | null;
} | null {
  const active = useTrellisStatusFor(useActiveEnvironmentId());
  const primary = useTrellisStatusFor(usePrimaryEnvironmentId());
  const picked = pickTrellisEnvironment(active, primary);
  const environmentId = picked?.environmentId ?? null;
  const root = picked?.root ?? null;
  const several = useEnvironments().environments.length > 1;
  const environmentLabel = useEnvironment(environmentId)?.label ?? null;
  const label = several ? environmentLabel : null;
  return useMemo(
    () => (environmentId === null ? null : { environmentId, root, label }),
    [environmentId, label, root],
  );
}

export type TrellisNewProjectResult =
  | { readonly _tag: "Created" }
  | { readonly _tag: "Failed"; readonly message: string }
  | { readonly _tag: "Interrupted" };

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

/**
 * Starts Trellis ideas and creates Trellis projects. `newIdea` opens a draft
 * in the environment's landing pad; nothing exists in Trellis until its
 * first message is sent, which creates the idea. It reports failures as a
 * toast. `newProject` creates the project right away and returns its outcome
 * so a dialog can show errors inline.
 */
/** Opens a new thread draft in a Trellis project (never in a git worktree). */
function useOpenTrellisDraft() {
  const handleNewThread = useNewThreadHandler();
  return useCallback(
    async (environmentId: EnvironmentId, projectId: ProjectId, errorTitle: string) => {
      const projectRef = scopeProjectRef(environmentId, projectId);
      // The server answers once the project is in its read model; the shell
      // stream may deliver it a moment later.
      await waitForProject(projectRef, 5_000).catch(() => null);
      // Trellis projects (and the landing pad) run in their project folder,
      // never in a git worktree.
      await handleNewThread(projectRef, { envMode: "local" }).catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: errorTitle,
            description: failureMessage(error, "An error occurred."),
          }),
        );
      });
    },
    [handleNewThread],
  );
}

export function useTrellisCreate() {
  const openDraftIn = useOpenTrellisDraft();
  const runPrepareIdeaDraft = useAtomCommand(trellisEnvironment.prepareIdeaDraft, {
    reportFailure: false,
  });
  const runNewProject = useAtomCommand(trellisEnvironment.newProject, { reportFailure: false });

  const newIdea = useCallback(
    async (environmentId: EnvironmentId): Promise<void> => {
      const result = await runPrepareIdeaDraft({ environmentId, input: {} });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start a new idea",
              description: failureMessage(
                squashAtomCommandFailure(result),
                "Trellis did not respond.",
              ),
            }),
          );
        }
        return;
      }
      await openDraftIn(environmentId, result.value.projectId, "Could not open the new idea");
    },
    [openDraftIn, runPrepareIdeaDraft],
  );

  /**
   * The landing pad project once it is in this client's store, for
   * retargeting an open draft to a new idea in place. Null after a failure,
   * which it reports as a toast.
   */
  const openIdeaProject = useCallback(
    async (environmentId: EnvironmentId): Promise<EnvironmentProject | null> => {
      const report = (error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start a new idea",
            description: failureMessage(error, "Trellis did not respond."),
          }),
        );
        return null;
      };
      const result = await runPrepareIdeaDraft({ environmentId, input: {} });
      if (result._tag === "Failure") {
        return isAtomCommandInterrupted(result) ? null : report(squashAtomCommandFailure(result));
      }
      return waitForProject(scopeProjectRef(environmentId, result.value.projectId)).catch(report);
    },
    [runPrepareIdeaDraft],
  );

  const newProject = useCallback(
    async (
      environmentId: EnvironmentId,
      input: TrellisNewProjectInput,
    ): Promise<TrellisNewProjectResult> => {
      const result = await runNewProject({ environmentId, input });
      if (result._tag === "Failure") {
        return isAtomCommandInterrupted(result)
          ? { _tag: "Interrupted" }
          : {
              _tag: "Failed",
              message: failureMessage(
                squashAtomCommandFailure(result),
                "Could not create the project.",
              ),
            };
      }
      await openDraftIn(
        environmentId,
        result.value.projectId,
        `Created ${result.value.name}, but could not open it`,
      );
      return { _tag: "Created" };
    },
    [openDraftIn, runNewProject],
  );

  return { newIdea, openIdeaProject, newProject };
}

/**
 * "Fork workspace": forks a Trellis workspace from one of its checkpoints as
 * a visible workspace (no `spawned_by`), shows Trellis's resource warnings,
 * and opens a new thread there, which is a lead. Resolves to the failure
 * message, or null once forked.
 */
export function useTrellisForkWorkspace() {
  const openDraftIn = useOpenTrellisDraft();
  const run = useAtomCommand(trellisEnvironment.forkWorkspace, { reportFailure: false });
  return useCallback(
    async (
      environmentId: EnvironmentId,
      input: { readonly workspaceId: string; readonly snapshot: string; readonly name?: string },
    ): Promise<string | null> => {
      const result = await run({ environmentId, input });
      if (result._tag === "Failure") {
        return isAtomCommandInterrupted(result)
          ? "Interrupted."
          : failureMessage(squashAtomCommandFailure(result), "Trellis did not respond.");
      }
      await loadTrellisStatus(appAtomRegistry, environmentId);
      const { name, projectId, warnings } = result.value;
      toastManager.add(
        stackedThreadToast({
          type: warnings.length > 0 ? "warning" : "success",
          title: `Forked workspace "${name}"`,
          description:
            warnings.length > 0 ? warnings.join(" ") : "A new thread there is a lead of its own.",
        }),
      );
      if (projectId !== null) {
        await openDraftIn(environmentId, projectId, `Forked "${name}", but could not open it`);
      }
      return null;
    },
    [openDraftIn, run],
  );
}

/**
 * Moves the Trellis item behind a T3 project to the Trellis trash and reports
 * the outcome as a toast with an Undo. The project stays listed as trashed
 * (see `state/trellisTrashed`) and its conversations are archived; Undo
 * restores both. `gone` means no live Trellis item is behind the project (it
 * is already in the trash), so only T3's own entry can be removed.
 */
export function useTrellisTrash() {
  const run = useAtomCommand(trellisEnvironment.trashProject, { reportFailure: false });
  const undo = useTrellisUndoTrash();
  return useCallback(
    async (
      environmentId: EnvironmentId,
      projectId: ProjectId,
      title: string,
      workspaceRoot: string,
    ): Promise<"trashed" | "gone" | "failed"> => {
      const result = await run({ environmentId, input: { projectId } });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Could not move "${title}" to the Trellis trash`,
              description: failureMessage(
                squashAtomCommandFailure(result),
                "Trellis did not respond.",
              ),
            }),
          );
        }
        return "failed";
      }
      if (result.value.trashed === null) return "gone";
      const { name, restore } = result.value;
      if (restore !== undefined) {
        useTrellisTrashedStore.getState().add(trellisTrashedKey(environmentId, projectId), {
          name,
          environmentId,
          workspaceRoot,
          restore,
          phase: "trashing",
          staleStatus: readTrellisStatus(appAtomRegistry, environmentId),
        });
      }
      // Its retired root marks the emptied project trashed. Awaited, so a
      // caller that navigates next never lands on a new draft in it.
      await loadTrellisStatus(appAtomRegistry, environmentId);
      const toastId = toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `Moved "${name}" to the Trellis trash`,
          description: "Its conversations are archived. Restore it later from Settings → Trellis.",
          ...(restore === undefined
            ? {}
            : {
                actionProps: {
                  children: "Undo",
                  onClick: () => {
                    toastManager.close(toastId);
                    void undo(environmentId, projectId);
                  },
                },
              }),
        }),
      );
      return "trashed";
    },
    [run, undo],
  );
}

/**
 * Restores a project this client moved to the Trellis trash, with its
 * conversations. The entry stays (`restoring`) until a status shows the
 * project live (see `state/trellisTrashed`), so the sidebar never hides it in
 * between. A failed restore drops the entry: the trash in Settings → Trellis
 * is then the way back.
 */
export function useTrellisUndoTrash() {
  const run = useAtomCommand(trellisEnvironment.restore, { reportFailure: false });
  return useCallback(
    async (environmentId: EnvironmentId, projectId: ProjectId): Promise<boolean> => {
      const key = trellisTrashedKey(environmentId, projectId);
      const trashed = useTrellisTrashedStore.getState().projects[key];
      if (trashed === undefined || trashed.phase === "restoring") return false;
      useTrellisTrashedStore.getState().setPhase(key, "restoring");
      const result = await run({ environmentId, input: trashed.restore });
      if (result._tag === "Failure") {
        // Interrupted (a disconnect): it may or may not have happened, so the
        // Undo comes back; a status showing the restore still settles it.
        if (isAtomCommandInterrupted(result)) {
          useTrellisTrashedStore.getState().setPhase(key, "trashed");
        } else {
          useTrellisTrashedStore.getState().remove(key);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Could not restore "${trashed.name}"`,
              description: `${failureMessage(
                squashAtomCommandFailure(result),
                "Trellis did not respond.",
              )} Look for it in Settings → Trellis.`,
            }),
          );
        }
        return false;
      }
      refreshTrellisStatus(appAtomRegistry, environmentId);
      toastManager.add(
        stackedThreadToast({ type: "success", title: `Restored "${trashed.name}"` }),
      );
      return true;
    },
    [run],
  );
}

/**
 * Checks a file restore in a Trellis project before it is sent: fails with
 * the reason while another thread works in the same idea or workspace, and
 * asks the user to confirm undoing other threads' later work there. Resolves
 * to the threads to acknowledge in the rollback, or null when the user
 * declined. Outside Trellis it resolves to none; when the check itself
 * fails, the server checks again and refuses with its reason.
 */
export function useTrellisRestoreCheck() {
  const run = useAtomCommand(trellisEnvironment.restoreConflicts, { reportFailure: false });
  return useCallback(
    async (
      environmentId: EnvironmentId,
      input: TrellisRestoreConflictsInput,
      confirm: (message: string) => Promise<boolean>,
    ): Promise<ReadonlyArray<OrchestrationV2AcknowledgedWork> | null> => {
      const result = await run({ environmentId, input });
      if (result._tag === "Failure") return [];
      const { running, later } = result.value;
      const names = (threads: ReadonlyArray<{ readonly title: string }>) =>
        threads.map((thread) => `"${thread.title}"`).join(", ");
      if (running.length > 0) {
        const one = running.length === 1;
        throw new Error(
          `${names(running)} ${one ? "is" : "are"} still working in this Trellis workspace, and restoring its files would undo that work. Wait for ${one ? "it" : "them"} to finish or stop ${one ? "it" : "them"}, then try again.`,
        );
      }
      if (later.length === 0) return [];
      const confirmed = await confirm(
        `Restoring the files also undoes the later work of ${names(later)} in the same Trellis workspace.\nRestore anyway?`,
      );
      return confirmed
        ? later.map((thread) => ({ threadId: thread.threadId, runId: thread.runId }))
        : null;
    },
    [run],
  );
}

/**
 * Graduates the idea behind a T3 project into its own Trellis project. Its
 * threads move there (the sidebar follows the shell stream); returns the
 * failure message for a dialog to show, or null once it graduated.
 */
export function useTrellisGraduate() {
  const run = useAtomCommand(trellisEnvironment.graduate, { reportFailure: false });
  return useCallback(
    async (environmentId: EnvironmentId, input: TrellisGraduateInput): Promise<string | null> => {
      const result = await run({ environmentId, input });
      if (result._tag === "Failure") {
        return isAtomCommandInterrupted(result)
          ? "The graduation was interrupted; check the sidebar before trying again."
          : failureMessage(squashAtomCommandFailure(result), "Trellis did not respond.");
      }
      // The idea's retired root hides its emptied project.
      await loadTrellisStatus(appAtomRegistry, environmentId);
      const { name, notMoved } = result.value;
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `Graduated into "${name}"`,
          description:
            notMoved.length === 0
              ? "Its threads moved into the new project."
              : `${notMoved.map((title) => `"${title}"`).join(", ")} ${notMoved.length === 1 ? "moves" : "move"} once ${notMoved.length === 1 ? "its turn ends" : "their turns end"}.`,
        }),
      );
      return null;
    },
    [run],
  );
}

/** Confirmation for removing a T3 project whose Trellis item is already gone. */
export const TRELLIS_GONE_CONFIRMATION =
  "This project is no longer live in Trellis (it may already be in the Trellis trash). Remove it from T3 and delete its conversations? This cannot be undone.";

/**
 * Debounced Trellis search. Each query is its own cached atom, so a slow
 * response for an earlier query can never replace the current results.
 */
export function useTrellisFind(environmentId: EnvironmentId | null, query: string) {
  const trimmed = query.trim();
  const debounced = useDebouncedValue(trimmed, TRELLIS_FIND_DEBOUNCE_MS);
  const result = useEnvironmentQuery(
    environmentId !== null && debounced.length > 0
      ? trellisEnvironment.find({ environmentId, input: { query: debounced } })
      : null,
  );
  return {
    hits: result.data?.hits ?? EMPTY_HITS,
    error: result.error,
    isPending: trimmed !== debounced || result.isPending,
    searchedQuery: debounced,
  };
}

/**
 * Moves a thread without history to another project of its environment, and
 * reports the outcome as a toast, including the server's refusal (a thread
 * with history, a busy thread or a fork that has not run yet). The shell
 * stream then moves the thread in the sidebar.
 */
export function useMoveThreadToProject() {
  const run = useAtomCommand(threadEnvironment.moveToProject, { reportFailure: false });
  return useCallback(
    async (
      threadRef: ScopedThreadRef,
      input: {
        readonly fromProjectId: ProjectId;
        readonly toProjectId: ProjectId;
        readonly toProjectTitle: string;
      },
    ): Promise<boolean> => {
      const result = await run({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          projectId: input.toProjectId,
          expectedProjectId: input.fromProjectId,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Could not move the thread to "${input.toProjectTitle}"`,
              description: failureMessage(
                squashAtomCommandFailure(result),
                "The environment did not respond.",
              ),
            }),
          );
        }
        return false;
      }
      toastManager.add(
        stackedThreadToast({ type: "success", title: `Moved to "${input.toProjectTitle}"` }),
      );
      return true;
    },
    [run],
  );
}
