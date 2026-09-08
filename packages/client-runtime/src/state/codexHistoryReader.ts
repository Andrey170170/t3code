import type { CodexThreadsHistoryResult } from "@t3tools/contracts";

export type CodexHistoryState = {
  result: CodexThreadsHistoryResult | null;
  loading: boolean;
  error: string | null;
};

/** One thread's bounded history reader. Dispose fences replies after navigation. */
export function createCodexHistoryReader(
  loadPage: (cursor?: string) => Promise<CodexThreadsHistoryResult>,
  onChange: (state: CodexHistoryState) => void,
) {
  let disposed = false;
  let busy = false;
  let result: CodexThreadsHistoryResult | null = null;
  const read = async (retry: boolean) => {
    if (disposed || busy || (!retry && result && !result.nextCursor)) return;
    busy = true;
    onChange({ result, loading: true, error: null });
    try {
      const page = await loadPage(result?.nextCursor ?? undefined);
      if (disposed) return;
      result = {
        ...page,
        items: result?.nextCursor ? [...result.items, ...page.items] : page.items,
      };
      onChange({ result, loading: false, error: null });
    } catch {
      if (!disposed)
        onChange({ result, loading: false, error: "Could not load earlier messages." });
    } finally {
      busy = false;
    }
  };
  return {
    loadEarlier: () => {
      void read(false);
    },
    retry: () => {
      void read(true);
    },
    dispose: () => {
      disposed = true;
    },
  };
}
