import { describe, expect, it } from "vite-plus/test";
import type { CodexThreadsHistoryResult } from "@t3tools/contracts";
import { createCodexHistoryReader, type CodexHistoryState } from "./codexHistoryReader.ts";

const page = (id: string, nextCursor: string | null): CodexThreadsHistoryResult => ({
  imported: true,
  boundary: null,
  items: [{ turnId: "turn", item: { id, type: "agentMessage", text: id } }],
  nextCursor,
});
const deferred = () => {
  let resolve!: (value: CodexThreadsHistoryResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<CodexThreadsHistoryResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe("native history reader", () => {
  it("keeps a bounded page and requests older messages once when asked", async () => {
    const requests: Array<string | undefined> = [];
    const first = deferred();
    const second = deferred();
    let state: CodexHistoryState | undefined;
    const reader = createCodexHistoryReader(
      (cursor) => {
        requests.push(cursor);
        return cursor ? second.promise : first.promise;
      },
      (next) => {
        state = next;
      },
    );
    reader.loadEarlier();
    reader.loadEarlier();
    expect(requests).toEqual([undefined]);
    first.resolve(page("newer", "older"));
    await first.promise;
    expect(state?.result?.items).toHaveLength(1);
    expect(requests).toHaveLength(1);
    reader.loadEarlier();
    second.resolve(page("older", null));
    await second.promise;
    expect(requests).toEqual([undefined, "older"]);
    expect(state?.result?.items.map((x) => x.item.id)).toEqual(["newer", "older"]);
    reader.loadEarlier();
    expect(requests).toHaveLength(2);
    reader.dispose();
  });

  it("preserves loaded messages after a failed older-page request and retries the same cursor", async () => {
    const pending = [deferred(), deferred(), deferred()];
    const cursors: Array<string | undefined> = [];
    let state: CodexHistoryState | undefined;
    const reader = createCodexHistoryReader(
      (cursor) => {
        cursors.push(cursor);
        return pending[cursors.length - 1]!.promise;
      },
      (next) => {
        state = next;
      },
    );
    reader.loadEarlier();
    pending[0]!.resolve(page("new", "older"));
    await pending[0]!.promise;
    reader.loadEarlier();
    pending[1]!.reject(new Error("offline"));
    await pending[1]!.promise.catch(() => {});
    expect(state?.result?.items[0]?.item.id).toBe("new");
    expect(state?.error).toBeTruthy();
    reader.retry();
    pending[2]!.resolve(page("old", null));
    await pending[2]!.promise;
    expect(cursors).toEqual([undefined, "older", "older"]);
    expect(state?.error).toBeNull();
    expect(state?.result?.items).toHaveLength(2);
    reader.dispose();
  });

  it("ignores responses and further reads after navigating away", async () => {
    const response = deferred();
    const states: CodexHistoryState[] = [];
    const reader = createCodexHistoryReader(
      () => response.promise,
      (state) => states.push(state),
    );
    reader.loadEarlier();
    reader.dispose();
    response.resolve(page("old thread", null));
    await response.promise;
    reader.retry();
    reader.loadEarlier();
    expect(states).toHaveLength(1);
    expect(states[0]?.loading).toBe(true);
  });
});
