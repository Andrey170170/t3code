import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  TrellisCreateResult,
  TrellisFindHit,
  TrellisNewProjectInput,
} from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useComposerDraftStore } from "~/composerDraftStore";
import { pickTrellisEnvironment } from "~/lib/trellis";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { waitForProject } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useDebouncedValue } from "~/state/queries";
import { useEnvironmentQuery } from "~/state/query";
import {
  runExclusiveTrellisIdea,
  trellisEnvironment,
  trellisIdeaPendingAtom,
} from "~/state/trellis";
import { useAtomCommand } from "~/state/use-atom-command";
import { resolveThreadRouteTarget } from "~/threadRoutes";
import { useNewThreadHandler } from "./useHandleNewThread";

const TRELLIS_FIND_DEBOUNCE_MS = 250;
const EMPTY_HITS: ReadonlyArray<TrellisFindHit> = [];

interface TrellisEnvironment {
  readonly environmentId: EnvironmentId;
  readonly available: boolean;
  readonly root: string | null;
}

/** Trellis status of one environment; null while unknown or without an environment. */
function useTrellisStatusFor(environmentId: EnvironmentId | null): TrellisEnvironment | null {
  const status = useEnvironmentQuery(
    environmentId === null ? null : trellisEnvironment.status({ environmentId, input: {} }),
  ).data;
  const available = status?.available === true;
  const root = status?.root ?? null;
  return useMemo(
    () => (environmentId === null ? null : { environmentId, available, root }),
    [available, environmentId, root],
  );
}

/**
 * The Trellis root of an environment while its server reports a running
 * Trellis service; null otherwise, which marks nothing as Trellis-managed.
 */
export function useTrellisRoot(environmentId: EnvironmentId | null): string | null {
  const status = useTrellisStatusFor(environmentId);
  return status?.available === true ? status.root : null;
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
 * the active thread's environment when it runs Trellis, otherwise the primary
 * one when it does. Null hides every Trellis entry point.
 */
export function useTrellisEnvironment(): {
  readonly environmentId: EnvironmentId;
  readonly root: string | null;
} | null {
  const active = useTrellisStatusFor(useActiveEnvironmentId());
  const primary = useTrellisStatusFor(usePrimaryEnvironmentId());
  const picked = pickTrellisEnvironment(active, primary);
  const environmentId = picked?.environmentId ?? null;
  const root = picked?.root ?? null;
  return useMemo(
    () => (environmentId === null ? null : { environmentId, root }),
    [environmentId, root],
  );
}

/** Whether a new idea is being created in the environment, from any entry point. */
export function useTrellisIdeaPending(environmentId: EnvironmentId | null): boolean {
  const pending = useAtomValue(trellisIdeaPendingAtom);
  return environmentId !== null && pending.includes(environmentId);
}

export type TrellisNewProjectResult =
  | { readonly _tag: "Created" }
  | { readonly _tag: "Failed"; readonly message: string }
  | { readonly _tag: "Interrupted" };

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

/**
 * Creates Trellis ideas and projects, then opens a new thread in the T3
 * project the server created for them. `newIdea` reports failures as a toast
 * and ignores calls while an idea is already being created in the
 * environment; `newProject` returns its outcome so a dialog can show errors
 * inline.
 */
export function useTrellisCreate() {
  const handleNewThread = useNewThreadHandler();
  const runNewIdea = useAtomCommand(trellisEnvironment.newIdea, { reportFailure: false });
  const runNewProject = useAtomCommand(trellisEnvironment.newProject, { reportFailure: false });

  const openCreated = useCallback(
    async (environmentId: EnvironmentId, created: TrellisCreateResult) => {
      const projectRef = scopeProjectRef(environmentId, created.projectId);
      // The server answers once the project is in its read model; the shell
      // stream may deliver it a moment later.
      await waitForProject(projectRef, 5_000).catch(() => null);
      await handleNewThread(projectRef).catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Created ${created.name}, but could not open it`,
            description: failureMessage(error, "An error occurred."),
          }),
        );
      });
    },
    [handleNewThread],
  );

  const newIdea = useCallback(
    async (environmentId: EnvironmentId): Promise<void> => {
      await runExclusiveTrellisIdea(appAtomRegistry, environmentId, async () => {
        const result = await runNewIdea({ environmentId, input: {} });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not create idea",
                description: failureMessage(
                  squashAtomCommandFailure(result),
                  "Trellis did not respond.",
                ),
              }),
            );
          }
          return;
        }
        await openCreated(environmentId, result.value);
      });
    },
    [openCreated, runNewIdea],
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
      await openCreated(environmentId, result.value);
      return { _tag: "Created" };
    },
    [openCreated, runNewProject],
  );

  return { newIdea, newProject };
}

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
