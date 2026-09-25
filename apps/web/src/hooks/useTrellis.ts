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
  TrellisStatus,
} from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { waitForProject } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useDebouncedValue } from "~/state/queries";
import { useEnvironmentQuery } from "~/state/query";
import { trellisEnvironment } from "~/state/trellis";
import { useAtomCommand } from "~/state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";

const TRELLIS_FIND_DEBOUNCE_MS = 250;
const EMPTY_HITS: ReadonlyArray<TrellisFindHit> = [];

function useTrellisStatus(environmentId: EnvironmentId | null): TrellisStatus | null {
  return useEnvironmentQuery(
    environmentId === null ? null : trellisEnvironment.status({ environmentId, input: {} }),
  ).data;
}

/**
 * The environment Trellis actions target: the primary one, while its server
 * reports a running Trellis service. Null hides every Trellis entry point.
 */
export function useTrellisEnvironment(): {
  readonly environmentId: EnvironmentId;
  readonly root: string | null;
} | null {
  const environmentId = usePrimaryEnvironmentId();
  const status = useTrellisStatus(environmentId);
  const root = status?.root ?? null;
  return useMemo(
    () => (environmentId !== null && status?.available === true ? { environmentId, root } : null),
    [environmentId, root, status?.available],
  );
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

/**
 * Creates Trellis ideas and projects, then opens a new thread in the T3
 * project the server created for them. `newIdea` reports failures as a toast;
 * `newProject` returns its error so a dialog can show it inline.
 */
export function useTrellisCreate() {
  const handleNewThread = useNewThreadHandler();
  const runNewIdea = useAtomCommand(trellisEnvironment.newIdea, { reportFailure: false });
  const runNewProject = useAtomCommand(trellisEnvironment.newProject, { reportFailure: false });
  const [ideaPending, setIdeaPending] = useState(false);

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
      setIdeaPending(true);
      try {
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
      } finally {
        setIdeaPending(false);
      }
    },
    [openCreated, runNewIdea],
  );

  const newProject = useCallback(
    async (environmentId: EnvironmentId, input: TrellisNewProjectInput): Promise<string | null> => {
      const result = await runNewProject({ environmentId, input });
      if (result._tag === "Failure") {
        return isAtomCommandInterrupted(result)
          ? null
          : failureMessage(squashAtomCommandFailure(result), "Could not create the project.");
      }
      await openCreated(environmentId, result.value);
      return null;
    },
    [openCreated, runNewProject],
  );

  return { newIdea, ideaPending, newProject };
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
