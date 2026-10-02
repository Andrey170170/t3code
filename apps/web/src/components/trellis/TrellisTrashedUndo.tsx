import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useTrellisUndoTrash } from "~/hooks/useTrellis";
import { useEnvironmentQuery } from "~/state/query";
import { trellisEnvironment } from "~/state/trellis";
import {
  reconcileTrellisTrashed,
  trellisTrashedKey,
  useTrellisTrashedStore,
} from "~/state/trellisTrashed";
import { Button } from "../ui/button";

/**
 * "In trash · Undo" for a project row whose Trellis items (any of its
 * members) this client moved to the trash; renders nothing otherwise. Undo
 * restores them and their conversations. Each member environment's status is
 * applied to the entries, so one restored elsewhere stops showing here.
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
  const restoring = trashed.every(
    (member) =>
      trashedHere[trellisTrashedKey(member.environmentId, member.id)]?.phase === "restoring",
  );
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 ${props.className ?? ""}`}>
      {[...new Set(trashed.map((member) => member.environmentId))].map((environmentId) => (
        <TrellisTrashedReconciler key={environmentId} environmentId={environmentId} />
      ))}
      {props.label === false ? null : (
        <span className="text-muted-foreground text-xs">In trash</span>
      )}
      <Button
        size="xs"
        variant="outline"
        disabled={pending || restoring}
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
        {restoring ? "Restoring…" : "Undo"}
      </Button>
    </span>
  );
}

/** Applies an environment's Trellis status to this client's trashed entries. */
function TrellisTrashedReconciler(props: { readonly environmentId: EnvironmentId }) {
  const status = useEnvironmentQuery(
    trellisEnvironment.status({ environmentId: props.environmentId, input: {} }),
  ).data;
  useEffect(() => {
    if (status !== undefined && status !== null) {
      reconcileTrellisTrashed(props.environmentId, status);
    }
  }, [props.environmentId, status]);
  return null;
}
