import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { type KeyboardEvent, useState } from "react";

import { useTrellisGraduate } from "~/hooks/useTrellis";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironmentQuery } from "~/state/query";
import { trellisEnvironment } from "~/state/trellis";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

interface GraduateTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
}

/**
 * Which idea the dialog graduates. Set by an entry point (the command
 * palette, project settings) and rendered once by the chat layout.
 */
const graduateIdeaDialogAtom = Atom.make<GraduateTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("trellis:graduate-idea-dialog"),
);

export function openGraduateIdeaDialog(target: GraduateTarget): void {
  appAtomRegistry.set(graduateIdeaDialogAtom, target);
}

/** Mounted once by the chat layout; shows the dialog while an entry point asked for it. */
export function GraduateIdeaDialogHost() {
  const target = useAtomValue(graduateIdeaDialogAtom);
  if (target === null) return null;
  return (
    <GraduateIdeaDialog
      key={`${target.environmentId}:${target.projectId}`}
      target={target}
      onClose={() => appAtomRegistry.set(graduateIdeaDialogAtom, null)}
    />
  );
}

function GraduateIdeaDialog(props: {
  readonly target: GraduateTarget;
  readonly onClose: () => void;
}) {
  const graduate = useTrellisGraduate();
  const bases = useEnvironmentQuery(
    trellisEnvironment.bases({ environmentId: props.target.environmentId, input: {} }),
  );
  const defaultBase = bases.data?.defaultBase ?? null;
  const [base, setBase] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Until the user picks one, the default base.
  const chosenBase = base ?? defaultBase;
  const trimmedName = name.trim();

  const submit = async () => {
    if (pending) return;
    setError(null);
    setPending(true);
    const failure = await graduate(props.target.environmentId, {
      projectId: props.target.projectId,
      ...(chosenBase === null ? {} : { base: chosenBase }),
      ...(trimmedName.length > 0 ? { name: trimmedName } : {}),
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
          <DialogTitle>Graduate "{props.target.title}"</DialogTitle>
          <DialogDescription>
            Turns the idea into a project with its own Trellis workspace, starting from a copy of
            its folder. Its threads move there with their conversations; packages installed while it
            was an idea do not come along.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="trellis-graduate-base">Base</Label>
              <Select
                value={chosenBase}
                disabled={pending || bases.data === undefined}
                onValueChange={(value) => setBase(value as string)}
              >
                <SelectTrigger id="trellis-graduate-base" aria-label="Base">
                  <SelectValue>
                    {(value: string | null) =>
                      value === null
                        ? bases.error
                          ? "The default base"
                          : "Loading bases..."
                        : value === defaultBase
                          ? `${value} (default)`
                          : value
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {(bases.data?.bases ?? []).map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {entry === defaultBase ? `${entry} (default)` : entry}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="trellis-graduate-name">Name (optional)</Label>
              <Input
                id="trellis-graduate-name"
                placeholder="Leave empty to keep the idea's name"
                value={name}
                disabled={pending}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={submitOnEnter}
                autoFocus
              />
            </div>
            {error ? <p className="text-destructive text-xs">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={props.onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={pending}>
            {pending ? "Graduating..." : "Graduate"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
