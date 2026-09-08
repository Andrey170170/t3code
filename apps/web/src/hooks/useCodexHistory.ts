import type { CodexThreadsHistoryResult } from "@t3tools/contracts";
import {
  createCodexHistoryReader,
  type CodexHistoryState,
} from "@t3tools/client-runtime/state/codex-history-reader";
import { useCallback, useEffect, useRef, useState } from "react";

const EMPTY: CodexHistoryState = { result: null, loading: false, error: null };

export function useCodexHistory({
  threadKey,
  enabled,
  loadPage,
}: {
  threadKey: string | null;
  enabled: boolean;
  loadPage: (cursor?: string) => Promise<CodexThreadsHistoryResult>;
}) {
  const [state, setState] = useState<CodexHistoryState & { key: string | null }>({
    ...EMPTY,
    key: null,
  });
  const readerRef = useRef<ReturnType<typeof createCodexHistoryReader> | null>(null);
  useEffect(() => {
    if (!threadKey || !enabled) {
      setState({ ...EMPTY, key: null });
      return;
    }
    const reader = createCodexHistoryReader(loadPage, (next) =>
      setState({ ...next, key: threadKey }),
    );
    readerRef.current = reader;
    reader.loadEarlier();
    return () => {
      reader.dispose();
      readerRef.current = null;
    };
  }, [threadKey, enabled, loadPage]);
  const loadEarlier = useCallback(() => readerRef.current?.loadEarlier(), []);
  const retry = useCallback(() => readerRef.current?.retry(), []);
  const current = enabled && state.key === threadKey ? state : EMPTY;
  return {
    ...current,
    loading: enabled && !!threadKey && (current.loading || (!current.result && !current.error)),
    loadEarlier,
    retry,
  };
}
