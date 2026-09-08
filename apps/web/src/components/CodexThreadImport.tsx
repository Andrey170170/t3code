import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { codexThreads } from "../state/codexThreads";
import { serverEnvironment, EMPTY_SERVER_PROVIDERS } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "./ui/dialog";

type Props = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  workspaceRoot: string;
  label?: string;
};

/** Project-scoped import stays on the selected environment, including remote servers. */
export function CodexThreadImportButton(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {props.label ?? "Import conversations"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-2xl">
          <DialogTitle>Import conversations</DialogTitle>
          <DialogDescription>Bring existing conversations into this project.</DialogDescription>
          {open ? (
            <CodexThreadImport key={`${props.environmentId}:${props.projectId}`} {...props} />
          ) : null}
        </DialogPopup>
      </Dialog>
    </>
  );
}

function CodexThreadImport({ environmentId, projectId, workspaceRoot }: Props) {
  const providers = (
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS
  ).filter((provider) => provider.driver === "codex" && provider.enabled);
  const [selectedProvider, setSelectedProvider] = useState<ProviderInstanceId | null>(null);
  const providerInstanceId = selectedProvider ?? providers[0]?.instanceId;
  const list = useAtomCommand(codexThreads.list, { reportFailure: false });
  const adopt = useAtomCommand(codexThreads.import, { reportFailure: false });
  const recent = useAtomCommand(codexThreads.importRecent, { reportFailure: false });
  type ListResult = Extract<Awaited<ReturnType<typeof list>>, { _tag: "Success" }>["value"];
  const [threads, setThreads] = useState<ListResult["threads"]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [allFolders, setAllFolders] = useState(false);
  const [useProjectFolder, setUseProjectFolder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  function resetResults() {
    generation.current++;
    setThreads([]);
    setCursor(null);
    setMessage("");
  }
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  async function load(next?: string) {
    if (!providerInstanceId) return;
    const request = ++generation.current;
    setBusy(true);
    setMessage("");
    const result = await list({
      environmentId,
      input: {
        providerInstanceId,
        ...(allFolders ? {} : { projectId }),
        archived,
        ...(search.trim() ? { search: search.trim() } : {}),
        ...(next ? { cursor: next } : {}),
      },
    });
    if (generation.current !== request) {
      setBusy(false);
      return;
    }
    setBusy(false);
    if (result._tag !== "Success") {
      setMessage(
        "Could not load Codex conversations. Check the provider connection and try again.",
      );
      return;
    }
    setThreads((previous) =>
      next
        ? [
            ...new Map(
              [...previous, ...result.value.threads].map((thread) => [thread.id, thread]),
            ).values(),
          ]
        : result.value.threads,
    );
    setCursor(result.value.nextCursor);
    if (!next && result.value.threads.length === 0)
      setMessage("No conversations match these filters.");
  }
  async function importThread(nativeThreadId: string) {
    if (!providerInstanceId) return;
    const selectedThread = threads.find((thread) => thread.id === nativeThreadId);
    setBusy(true);
    setMessage("");
    const result = await adopt({
      environmentId,
      input: {
        providerInstanceId,
        nativeThreadId,
        archived: selectedThread?.archived ?? false,
        projectId,
        ...(allFolders && useProjectFolder ? { cwdOverride: workspaceRoot } : {}),
      },
    });
    setBusy(false);
    if (result._tag !== "Success") {
      setMessage(
        result._tag === "Failure"
          ? String(squashAtomCommandFailure(result))
          : "Import interrupted. You can retry.",
      );
      return;
    }
    setThreads((previous) =>
      previous.map((thread) =>
        thread.id === nativeThreadId
          ? {
              ...thread,
              existingThreadId: result.value.threadId,
              historyUpgradeAvailable: false,
              historyAvailable: true,
            }
          : thread,
      ),
    );
    setMessage(
      result.value.alreadyImported
        ? "Full original history is available in the existing conversation."
        : "Conversation imported. Open it from the project sidebar.",
    );
  }
  async function importRecent() {
    setBusy(true);
    setMessage("");
    const result = await recent({
      environmentId,
      input: { projectId, expectedWorkspaceRoot: workspaceRoot },
    });
    setBusy(false);
    setMessage(
      result._tag === "Success"
        ? `Imported ${result.value.importedCount} recent conversations; skipped ${result.value.skippedCount}.`
        : "Could not import recent conversations. You can retry.",
    );
    setThreads([]);
    setCursor(null);
  }
  return (
    <div className="flex flex-col gap-3 pt-4">
      <Button variant="outline" disabled={busy} onClick={() => void importRecent()}>
        Import recent Claude and Codex conversations
      </Button>
      <p className="text-sm text-muted-foreground">
        Or select Codex conversations, including older history. Conversations must be idle before
        importing.
      </p>
      {archived ? (
        <p className="text-sm text-muted-foreground">
          Import restores archived conversations so you can continue them.
        </p>
      ) : null}
      {providers.length ? (
        <>
          <label className="text-sm">
            Codex provider
            <select
              className="ml-2 rounded border bg-background p-1"
              value={providerInstanceId}
              disabled={busy}
              onChange={(event) => {
                resetResults();
                setSelectedProvider(event.target.value as ProviderInstanceId);
              }}
            >
              {providers.map((provider) => (
                <option key={provider.instanceId} value={provider.instanceId}>
                  {provider.instanceId}
                </option>
              ))}
            </select>
          </label>
          <Input
            aria-label="Search Codex conversations"
            value={search}
            disabled={busy}
            onChange={(event) => {
              resetResults();
              setSearch(event.target.value);
            }}
            placeholder="Search conversations"
          />
          <div className="flex flex-wrap gap-4 text-sm">
            <label>
              <input
                type="checkbox"
                checked={archived}
                disabled={busy}
                onChange={(event) => {
                  resetResults();
                  setArchived(event.target.checked);
                }}
              />{" "}
              Archived
            </label>
            <label>
              <input
                type="checkbox"
                checked={allFolders}
                disabled={busy}
                onChange={(event) => {
                  resetResults();
                  setAllFolders(event.target.checked);
                }}
              />{" "}
              All folders and worktrees
            </label>
          </div>
          {allFolders ? (
            <label className="text-sm">
              <input
                type="checkbox"
                checked={useProjectFolder}
                disabled={busy}
                onChange={(event) => setUseProjectFolder(event.target.checked)}
              />{" "}
              Continue imported conversations in this project folder ({workspaceRoot})
            </label>
          ) : null}
          <Button disabled={busy} variant="outline" onClick={() => void load()}>
            Browse conversations
          </Button>
          <div className="max-h-72 overflow-y-auto" aria-label="Codex conversations">
            {threads.map((thread) => (
              <div key={thread.id} className="flex items-center gap-3 border-b py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{thread.title || "Untitled conversation"}</p>
                  <p className="truncate text-xs text-muted-foreground">{thread.cwd}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    busy || (thread.existingThreadId !== null && !thread.historyUpgradeAvailable)
                  }
                  onClick={() => void importThread(thread.id)}
                >
                  {thread.historyUpgradeAvailable
                    ? "Load full history"
                    : thread.existingThreadId
                      ? "Already in T3"
                      : "Import"}
                </Button>
              </div>
            ))}
          </div>
          {cursor ? (
            <Button disabled={busy} variant="outline" onClick={() => void load(cursor)}>
              Load more
            </Button>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Enable a Codex provider to browse individual conversations.
        </p>
      )}
      <p role="status" className="text-sm">
        {busy ? "Working…" : message}
      </p>
    </div>
  );
}
