import type { CodexThreadsListResult, ProviderInstanceId } from "@t3tools/contracts";

export type CodexImportCandidate = CodexThreadsListResult["threads"][number];

type CodexImportLocation = {
  readonly cwd: string;
  readonly projectCwd?: string | null;
  readonly worktreePath?: string | null;
  readonly worktreeBranch?: string | null;
  readonly worktreeMissing?: boolean;
};

/** Group linked worktrees by the main checkout without changing their runtime cwd. */
export function codexImportProjectCwd(candidate: CodexImportLocation): string {
  return candidate.projectCwd ?? candidate.cwd;
}

/** Only explicit worktree metadata earns a badge; ordinary project subdirectories do not. */
export function codexImportWorktree(
  candidate: CodexImportLocation,
): { path: string; label: string } | null {
  const path = candidate.worktreePath;
  if (!path || path === codexImportProjectCwd(candidate)) return null;
  return {
    path,
    label:
      candidate.worktreeBranch?.trim() ||
      path.split(/[\\/]/).filter(Boolean).slice(-2).join("/") ||
      path,
  };
}

/** Removed worktrees require an explicit choice from this project's current, proven checkouts. */
export function resolveCodexImportCheckout(
  candidate: CodexImportLocation,
  selectedCwd: string | undefined,
  availableCheckouts: ReadonlyArray<{ readonly cwd: string }>,
):
  | { kind: "original" }
  | { kind: "choose-checkout" }
  | { kind: "chosen-checkout"; cwdOverride: string } {
  if (!candidate.worktreeMissing) return { kind: "original" };
  if (selectedCwd && availableCheckouts.some((checkout) => checkout.cwd === selectedCwd)) {
    return { kind: "chosen-checkout", cwdOverride: selectedCwd };
  }
  return { kind: "choose-checkout" };
}

export function codexImportKey(
  providerId: ProviderInstanceId,
  candidate: CodexImportCandidate,
): string {
  return JSON.stringify([providerId, candidate.sourceIdentity]);
}

/** New conversations import; imported ones are selectable again once the source has new turns. */
export function canImportCodexConversation(candidate: CodexImportCandidate): boolean {
  return candidate.existingThreadId === null || candidate.updateAvailable === true;
}

/** A loaded page is never proof that a whole project is selected. */
export function codexProjectSelectionState(
  selectedCount: number,
  eligibleCount: number,
  catalogComplete: boolean,
) {
  const checked = catalogComplete && eligibleCount > 0 && selectedCount === eligibleCount;
  return { checked, indeterminate: selectedCount > 0 && !checked };
}

/** Preserve selections outside this result set when selecting or clearing a project filter. */
export function updateCodexImportSelection<T>(
  selected: ReadonlyMap<string, T>,
  candidates: ReadonlyArray<readonly [string, T]>,
  checked: boolean,
): Map<string, T> {
  const next = new Map(selected);
  for (const [key, candidate] of candidates) {
    if (checked) next.set(key, candidate);
    else next.delete(key);
  }
  return next;
}

/** Report each settled item; failures never stop unrelated imports. */
export async function runCodexImportBatch<T, R>(
  candidates: ReadonlyArray<T>,
  importOne: (candidate: T) => Promise<R>,
  onSettled: (candidate: T, result: { ok: true; value: R } | { ok: false; error: unknown }) => void,
): Promise<void> {
  let index = 0;
  async function worker() {
    while (index < candidates.length) {
      const candidate = candidates[index++]!;
      try {
        const value = await importOne(candidate);
        onSettled(candidate, { ok: true, value });
      } catch (error) {
        onSettled(candidate, { ok: false, error });
      }
    }
  }
  await Promise.all([worker(), worker()]);
}
