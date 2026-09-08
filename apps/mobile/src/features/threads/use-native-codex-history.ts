import {
  createCodexHistoryReader,
  type CodexHistoryState,
} from "@t3tools/client-runtime/state/codex-history-reader";
import type { CodexThreadsHistoryResult } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

const EMPTY_HISTORY: CodexHistoryState = {
  result: null,
  loading: false,
  error: null,
};

/** Own the React lifecycle around the shared, surface-neutral history reader. */
export function useNativeCodexHistory(props: {
  readonly threadKey: string;
  readonly enabled: boolean;
  readonly loadPage: (cursor?: string) => Promise<CodexThreadsHistoryResult>;
}) {
  const [state, setState] = useState<(CodexHistoryState & { readonly key: string }) | null>(null);
  const readerRef = useRef<ReturnType<typeof createCodexHistoryReader> | null>(null);

  useEffect(() => {
    readerRef.current?.dispose();
    readerRef.current = null;
    if (!props.enabled) {
      setState(null);
      return;
    }

    const reader = createCodexHistoryReader(props.loadPage, (next) => {
      setState({ ...next, key: props.threadKey });
    });
    readerRef.current = reader;
    reader.loadEarlier();
    return () => {
      reader.dispose();
      if (readerRef.current === reader) readerRef.current = null;
    };
  }, [props.enabled, props.loadPage, props.threadKey]);

  const loadEarlier = useCallback(() => readerRef.current?.loadEarlier(), []);
  const retry = useCallback(() => readerRef.current?.retry(), []);
  const current = props.enabled && state?.key === props.threadKey ? state : EMPTY_HISTORY;

  return {
    ...current,
    loading: props.enabled && (current.loading || (!current.result && !current.error)),
    loadEarlier,
    retry,
  };
}
