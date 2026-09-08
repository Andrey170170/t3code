import type { CodexThreadsListResult, ProviderInstanceId } from "@t3tools/contracts";

export type CodexImportCandidate = CodexThreadsListResult["threads"][number];

export function codexImportKey(
  providerId: ProviderInstanceId,
  candidate: CodexImportCandidate,
): string {
  return JSON.stringify([providerId, candidate.sourceIdentity]);
}

export function canImportCodexConversation(candidate: CodexImportCandidate): boolean {
  return candidate.existingThreadId === null || candidate.historyUpgradeAvailable === true;
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
