import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import { noProjectKind } from "~/lib/trellis";
import { useScratchProject } from "./useScratchProject";
import { useTrellisCreate, useTrellisStatusFor } from "./useTrellis";

/**
 * Starting a thread "without a project" from `currentEnvironmentId` (the
 * environment the user is working in). With Trellis ready there it opens a
 * new-idea draft; otherwise it is the host scratch project, as without
 * Trellis. `kind` is null when the environment offers neither. The scratch
 * project stays reachable on its own through `useScratchProject`.
 */
export function useNoProjectStart(currentEnvironmentId: EnvironmentId | null) {
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const { newIdea } = useTrellisCreate();
  const scratchTargetEnvironmentId = scratchEnvironmentId(currentEnvironmentId);
  // With no current environment (the hosted app with nothing open), the one
  // environment scratch would pick is also the one whose Trellis decides.
  const targetEnvironmentId = currentEnvironmentId ?? scratchTargetEnvironmentId;
  const trellisState = useTrellisStatusFor(targetEnvironmentId)?.state ?? null;
  const kind = noProjectKind({
    trellisState,
    scratchOffered: scratchTargetEnvironmentId !== null,
  });
  const environmentId = kind === "idea" ? targetEnvironmentId : scratchTargetEnvironmentId;

  const start = useCallback(async (): Promise<void> => {
    if (kind === null || environmentId === null) return;
    await (kind === "idea" ? newIdea(environmentId) : startScratchThread(environmentId));
  }, [environmentId, kind, newIdea, startScratchThread]);

  return { kind, environmentId, start };
}
