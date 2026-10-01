import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, TrellisWorkspaceEntry } from "@t3tools/contracts";
import { GitForkIcon, LayersIcon } from "lucide-react";
import { type KeyboardEvent, useState } from "react";

import { useTrellisForkWorkspace } from "~/hooks/useTrellis";
import {
  filterTrellisWorkspaces,
  type TrellisWorkspaceFilter,
  trellisWorkspaceDetail,
} from "~/lib/trellis";
import { readLocalApi } from "~/localApi";
import { useEnvironmentQuery } from "~/state/query";
import { trellisEnvironment } from "~/state/trellis";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";

const FILTERS: ReadonlyArray<{ readonly value: TrellisWorkspaceFilter; readonly label: string }> = [
  { value: "all", label: "All" },
  { value: "leads", label: "Leads" },
  { value: "workers", label: "Workers" },
  { value: "discarded", label: "Discarded" },
];

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * The workspaces of a Trellis project, in its settings: the project's own
 * workspace, forks the user made, worker forks (which the sidebar hides) and
 * discarded forks with their unmerged state, expiry and purge requests.
 * "Fork…" makes a visible fork from a checkpoint.
 */
export function TrellisWorkspacesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const { environmentId, projectId } = props;
  const query = useEnvironmentQuery(
    trellisEnvironment.workspaces({ environmentId, input: { projectId } }),
  );
  const purge = useAtomCommand(trellisEnvironment.purge, { reportFailure: false });
  const [filter, setFilter] = useState<TrellisWorkspaceFilter>("all");
  const [forking, setForking] = useState<TrellisWorkspaceEntry | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const items = query.data?.items ?? [];
  if (query.data != null && query.data.trellisProjectId === null) return null;
  const shown = filterTrellisWorkspaces(items, filter);

  const confirmPurge = async (entry: TrellisWorkspaceEntry) => {
    const api = readLocalApi();
    if (!api) return;
    const confirmed = await api.dialogs.confirm(
      [
        `Purge the discarded fork "${entry.name}" for good?`,
        entry.unmerged === true
          ? `It holds unmerged work${entry.unmergedReason ? ` (${entry.unmergedReason})` : ""}, which is lost.`
          : "Its files, workspace and snapshots are removed.",
        "This action cannot be undone.",
      ].join("\n"),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setPending(entry.id);
    try {
      const result = await purge({ environmentId, input: { ids: [entry.id] } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: `Could not purge "${entry.name}"`,
          description: error instanceof Error ? error.message : "Trellis did not respond.",
        });
      }
    } finally {
      setPending(null);
      query.refresh();
    }
  };

  return (
    <SettingsSection
      title="Trellis workspaces"
      icon={<LayersIcon className="size-3.5" />}
      headerAction={
        <ToggleGroup
          aria-label="Show workspaces"
          variant="segmented"
          value={[filter]}
          onValueChange={(next) => {
            const value = next[0];
            if (FILTERS.some((entry) => entry.value === value)) {
              setFilter(value as TrellisWorkspaceFilter);
            }
          }}
        >
          {FILTERS.map((entry) => (
            <Toggle key={entry.value} value={entry.value}>
              {entry.label}
            </Toggle>
          ))}
        </ToggleGroup>
      }
    >
      {shown.length === 0 ? (
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              {query.isPending ? <Spinner size="sm" tone="muted" /> : null}
              {query.isPending
                ? "Loading the workspaces"
                : query.error
                  ? "Could not load the workspaces"
                  : "No workspaces here"}
            </span>
          }
          description={
            query.error ??
            (filter === "workers"
              ? "Workers a thread delegates into a fork run here, hidden from the sidebar."
              : filter === "discarded"
                ? "Discarded forks stay in the Trellis trash until they expire or are purged."
                : "Fork this workspace from a checkpoint to work on a copy.")
          }
        />
      ) : (
        shown.map((entry) => (
          <SettingsRow
            key={entry.id}
            title={
              <span className="inline-flex min-w-0 items-center gap-2">
                <GitForkIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{entry.name}</span>
                <span className="shrink-0 text-muted-foreground text-xs">{entry.id}</span>
                {entry.projectId === projectId ? (
                  <span className="shrink-0 text-muted-foreground text-xs">(this one)</span>
                ) : null}
              </span>
            }
            description={trellisWorkspaceDetail(entry)}
            control={
              entry.state === "discarded" ? (
                entry.purgeRequested !== null ? (
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    disabled={pending !== null}
                    onClick={() => void confirmPurge(entry)}
                  >
                    {pending === entry.id ? "Purging…" : "Purge"}
                  </Button>
                ) : null
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => setForking(entry)}
                >
                  Fork…
                </Button>
              )
            }
          />
        ))
      )}
      {forking === null ? null : (
        <ForkWorkspaceDialog
          environmentId={environmentId}
          workspace={forking}
          onClose={() => {
            setForking(null);
            query.refresh();
          }}
        />
      )}
    </SettingsSection>
  );
}

/** Picks one of a workspace's checkpoints (newest first) and a name, then forks. */
function ForkWorkspaceDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly workspace: TrellisWorkspaceEntry;
  readonly onClose: () => void;
}) {
  const { environmentId, workspace } = props;
  const checkpoints = useEnvironmentQuery(
    trellisEnvironment.checkpoints({ environmentId, input: { workspaceId: workspace.id } }),
  );
  const fork = useTrellisForkWorkspace();
  const items = checkpoints.data?.items ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshot = chosen ?? items[0]?.id ?? null;

  const submit = async () => {
    if (pending || snapshot === null) return;
    setPending(true);
    setError(null);
    const trimmed = name.trim();
    const failure = await fork(environmentId, {
      workspaceId: workspace.id,
      snapshot,
      ...(trimmed.length > 0 ? { name: trimmed } : {}),
    });
    setPending(false);
    if (failure === null) props.onClose();
    else setError(failure);
  };
  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void submit();
  };

  return (
    <Dialog open onOpenChange={(next) => (next || pending ? undefined : props.onClose())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Fork workspace "{workspace.name}"</DialogTitle>
          <DialogDescription>
            Makes an independent copy of the workspace as it was at a checkpoint, listed in the
            sidebar, and opens a new thread there.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label>Checkpoint</Label>
              {checkpoints.isPending ? (
                <span className="inline-flex items-center gap-2 text-muted-foreground text-xs">
                  <Spinner size="sm" tone="muted" /> Loading checkpoints
                </span>
              ) : items.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  {checkpoints.error ??
                    "This workspace has no checkpoint yet. Ask its lead to call trellis_checkpoint, or run `trellis checkpoint` in it."}
                </p>
              ) : (
                <RadioGroup
                  aria-label="Checkpoint"
                  value={snapshot ?? ""}
                  onValueChange={(value) => setChosen(String(value))}
                >
                  {items.map((checkpoint, index) => (
                    <label
                      key={checkpoint.id}
                      className="flex cursor-pointer items-center gap-2 text-sm"
                    >
                      <Radio value={checkpoint.id} disabled={pending} />
                      <span>{checkpoint.label ?? checkpoint.id}</span>
                      <span className="text-muted-foreground text-xs">
                        {timeFormat.format(new Date(checkpoint.createdAt * 1000))}
                        {index === 0 ? " · latest" : ""}
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="trellis-fork-name">Name (optional)</Label>
              <Input
                id="trellis-fork-name"
                placeholder="Leave empty for fork-N"
                value={name}
                disabled={pending}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={submitOnEnter}
              />
            </div>
            {error ? <p className="text-destructive text-xs">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={props.onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={pending || snapshot === null}>
            {pending ? "Forking…" : "Fork"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
