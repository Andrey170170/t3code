import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState } from "react";

import { useTrellisUndoTrash } from "~/hooks/useTrellis";
import { trellisTrashedKey, useTrellisTrashedStore } from "~/state/trellisTrashed";
import { Button } from "../ui/button";

/**
 * "In trash · Undo" for a project row whose Trellis item this client moved to
 * the trash; renders nothing otherwise. Undo restores the item and its
 * conversations.
 */
export function TrellisTrashedUndo(props: {
  readonly members: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
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
