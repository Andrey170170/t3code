import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { type KeyboardEvent, useState } from "react";

import { useTrellisCreate } from "~/hooks/useTrellis";
import { appAtomRegistry } from "~/rpc/atomRegistry";
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

/**
 * Which environment has the dialog open. Set by the command palette (which
 * closes as soon as its command runs) and rendered once by the chat layout.
 */
const newTrellisProjectDialogEnvironmentAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("trellis:new-project-dialog-environment"),
);

export function openNewTrellisProjectDialog(environmentId: EnvironmentId): void {
  appAtomRegistry.set(newTrellisProjectDialogEnvironmentAtom, environmentId);
}

/** Mounted once by the chat layout; shows the dialog while an entry point asked for it. */
export function NewTrellisProjectDialogHost() {
  const environmentId = useAtomValue(newTrellisProjectDialogEnvironmentAtom);
  if (environmentId === null) return null;
  return (
    <NewTrellisProjectDialog
      key={environmentId}
      environmentId={environmentId}
      onClose={() => appAtomRegistry.set(newTrellisProjectDialogEnvironmentAtom, null)}
    />
  );
}

function NewTrellisProjectDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const { newProject } = useTrellisCreate();
  const [name, setName] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmedName = name.trim();
  const trimmedGitUrl = gitUrl.trim();

  const submit = async () => {
    if (pending) return;
    setError(null);
    setPending(true);
    const result = await newProject(props.environmentId, {
      ...(trimmedName.length > 0 ? { name: trimmedName } : {}),
      ...(trimmedGitUrl.length > 0 ? { gitUrl: trimmedGitUrl } : {}),
    });
    setPending(false);
    // Interrupted keeps the dialog open with the entered values for a retry.
    if (result._tag === "Failed") setError(result.message);
    if (result._tag === "Created") props.onClose();
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
          <DialogTitle>New Trellis project</DialogTitle>
          <DialogDescription>
            Creates a project with its own Trellis workspace, optionally cloned from a Git
            repository, and opens a new thread in it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="trellis-project-name">Name (optional)</Label>
              <Input
                id="trellis-project-name"
                placeholder="Leave empty for a default name"
                value={name}
                disabled={pending}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={submitOnEnter}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="trellis-project-git-url">Git URL (optional)</Label>
              <Input
                id="trellis-project-git-url"
                placeholder="https://github.com/owner/repo.git"
                value={gitUrl}
                disabled={pending}
                onChange={(event) => setGitUrl(event.target.value)}
                onKeyDown={submitOnEnter}
              />
            </div>
            {pending && trimmedGitUrl.length > 0 ? (
              <p className="text-muted-foreground text-xs">
                Cloning can take a while for large repositories.
              </p>
            ) : null}
            {error ? <p className="text-destructive text-xs">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={props.onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={pending}>
            {pending ? (trimmedGitUrl.length > 0 ? "Cloning..." : "Creating...") : "Create"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
