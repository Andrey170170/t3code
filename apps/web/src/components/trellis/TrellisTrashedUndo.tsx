import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useTrellisStatusFor, useTrellisUndoTrash } from "~/hooks/useTrellis";
import { trellisTrashedKey, useTrellisTrashedStore } from "~/state/trellisTrashed";
import { Button } from "../ui/button";

/**
 * "In trash · Undo" for a project row whose Trellis item this client moved to
 * the trash; renders nothing otherwise. Undo restores the item and its
 * conversations. An entry whose project Trellis no longer has in the trash
 * (restored elsewhere: Settings → Trellis, the CLI, another client) is
 * dropped.
 */
export function TrellisTrashedUndo(props: {
  readonly members: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
  readonly className?: string;
  /** False where the surrounding text already says it is in the trash. */
  readonly label?: boolean;
}) {
  const trashedHere = useTrellisTrashedStore((state) => state.projects);
  const trashed = props.members.filter(
    (member) => trellisTrashedKey(member.environmentId, member.id) in trashedHere,
  );
  const undo = useTrellisUndoTrash();
  const status = useTrellisStatusFor(props.members[0]?.environmentId ?? null);
  const live = trashed.filter(
    (member) =>
      status !== null &&
      member.environmentId === status.environmentId &&
      status.state === "ready" &&
      !status.retiredRoots.includes(member.workspaceRoot.replace(/(.)\/+$/, "$1")),
  );
  const liveKeys = live
    .map((member) => trellisTrashedKey(member.environmentId, member.id))
    .join("\n");
  useEffect(() => {
    if (liveKeys.length === 0) return;
    for (const key of liveKeys.split("\n")) useTrellisTrashedStore.getState().remove(key);
  }, [liveKeys]);
  const [pending, setPending] = useState(false);
  if (trashed.length === 0) return null;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 ${props.className ?? ""}`}>
      {props.label === false ? null : (
        <span className="text-muted-foreground text-xs">In trash</span>
      )}
      <Button
        size="xs"
        variant="outline"
        disabled={pending}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setPending(true);
          void Promise.all(trashed.map((member) => undo(member.environmentId, member.id))).finally(
            () => setPending(false),
          );
        }}
      >
        Undo
      </Button>
    </span>
  );
}
