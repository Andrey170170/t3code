import type { CodexConversationOrigin } from "@t3tools/contracts";
import { CodexThreadError } from "@t3tools/contracts";
import type { makeThreadHistory, NativeThread } from "effect-codex-app-server/thread-history";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

// Empty sourceKinds means interactive-only; an omitted provider means the configured
// provider only. Both defaults silently hide legitimate native conversations.
export const codexCatalogSourceKinds = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "unknown",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
];

export interface CodexOriginEvidence {
  readonly kind: "human" | "agent";
  readonly hasHumanParticipation: boolean;
}

export const classifyCodexOrigin = (
  thread: NativeThread,
  evidence?: CodexOriginEvidence,
): CodexConversationOrigin => {
  if (evidence?.kind === "agent") return evidence.hasHumanParticipation ? "mixed" : "agent";
  if (evidence?.kind === "human" || thread.threadSource === "user") return "human";
  if (thread.threadSource === "agent") return "agent";
  // A source client (appServer, CLI, exec) and a user-shaped tool output are
  // not evidence of who initiated or participated in a conversation.
  return "unknown";
};

const parentId = (thread: NativeThread): string | undefined => {
  if (typeof thread.parentThreadId === "string") return thread.parentThreadId;
  const source = thread.source;
  if (!Predicate.isObject(source) || !Predicate.isObject(source.subAgent)) return undefined;
  const spawn = source.subAgent.thread_spawn ?? source.subAgent.threadSpawn;
  if (!Predicate.isObject(spawn)) return undefined;
  const parent = spawn.parent_thread_id ?? spawn.parentThreadId;
  return typeof parent === "string" ? parent : undefined;
};

export const isCodexChild = (thread: NativeThread): boolean =>
  parentId(thread) !== undefined ||
  (Predicate.isObject(thread.source) && "subAgent" in thread.source) ||
  ["subagent", "guardian_review", "memory_consolidation"].includes(String(thread.threadSource));

/** Count only descendants with a real parent chain; unrelated reviews stay uncounted. */
export const topLevelCodexThreads = (threads: ReadonlyArray<NativeThread>) => {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const roots = new Map(
    threads
      .filter((thread) => !isCodexChild(thread))
      .map((thread) => [thread.id, { thread, childCount: 0 }]),
  );
  for (const thread of threads) {
    if (!isCodexChild(thread)) continue;
    const seen = new Set([thread.id]);
    let parent = parentId(thread);
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const root = roots.get(parent);
      if (root) {
        root.childCount++;
        break;
      }
      const ancestor = byId.get(parent);
      parent = ancestor ? parentId(ancestor) : undefined;
    }
  }
  return [...roots.values()];
};

/** One app-server connection for the catalog, with bounded native metadata pages. */
export const readCodexCatalog = Effect.fn("readCodexCatalog")(function* (
  native: ReturnType<typeof makeThreadHistory>,
  archived: boolean,
) {
  const threads = new Map<string, NativeThread>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = yield* native.list({
      sourceKinds: codexCatalogSourceKinds,
      modelProviders: [],
      useStateDbOnly: false,
      archived,
      limit: 100,
      sortDirection: "desc",
      sortKey: "updated_at",
      ...(cursor ? { cursor } : {}),
    });
    for (const thread of page.data) threads.set(thread.id, thread);
    if (!page.nextCursor) return { threads: [...threads.values()], complete: true };
    if (seen.has(page.nextCursor))
      return yield* new CodexThreadError({
        message: "Codex returned a non-advancing catalog cursor. Refresh and try again.",
      });
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return { threads: [...threads.values()], complete: false };
});
