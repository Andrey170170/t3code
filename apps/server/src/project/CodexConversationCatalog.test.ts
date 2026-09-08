import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeThreadHistory, type NativeThread } from "effect-codex-app-server/thread-history";
import {
  classifyCodexOrigin,
  topLevelCodexThreads,
  readCodexCatalog,
} from "./CodexConversationCatalog.ts";

const thread = (id: string, extra: Partial<NativeThread> = {}): NativeThread => ({
  id,
  cwd: "/repo",
  modelProvider: "custom",
  preview: id,
  createdAt: 1,
  updatedAt: 2,
  ...extra,
});

it("excludes spawned and guardian children while retaining agent-created top-level work", () => {
  const result = topLevelCodexThreads([
    thread("human", { threadSource: "user" }),
    thread("task", { threadSource: "agent" }),
    thread("child", { threadSource: "subagent", parentThreadId: "human" }),
    thread("grandchild", { source: { subAgent: { thread_spawn: { parent_thread_id: "child" } } } }),
    thread("guardian", { threadSource: "guardian_review" }),
  ]);
  assert.deepEqual(
    result.map(({ thread, childCount }) => [thread.id, childCount]),
    [
      ["human", 2],
      ["task", 0],
    ],
  );
});

it("requires provenance for human and mixed origins", () => {
  assert.equal(classifyCodexOrigin(thread("user", { threadSource: "user" })), "human");
  assert.equal(classifyCodexOrigin(thread("agent", { threadSource: "agent" })), "agent");
  assert.equal(classifyCodexOrigin(thread("missing", { source: "appServer" })), "unknown");
  assert.equal(
    classifyCodexOrigin(
      thread("agent", { threadSource: "agent", turns: [{ items: [{ type: "userMessage" }] }] }),
    ),
    "agent",
  );
  assert.equal(
    classifyCodexOrigin(thread("mixed"), { kind: "agent", hasHumanParticipation: true }),
    "mixed",
  );
});

it.effect("scans metadata with explicit sources and every provider, retaining native pages", () =>
  Effect.gen(function* () {
    const calls: unknown[] = [];
    const native = makeThreadHistory({
      request: (method, params) =>
        Effect.sync(() => {
          assert.equal(method, "thread/list");
          calls.push(params);
          assert.include((params as { sourceKinds: string[] }).sourceKinds, "exec");
          assert.include((params as { sourceKinds: string[] }).sourceKinds, "subAgent");
          assert.deepInclude(params, { modelProviders: [], useStateDbOnly: false, limit: 100 });
          return calls.length === 1
            ? { data: [thread("first")], nextCursor: "opaque" }
            : { data: [thread("second")], nextCursor: null };
        }),
    });
    const result = yield* readCodexCatalog(native, false);
    assert.deepEqual(
      result.threads.map((entry) => entry.id),
      ["first", "second"],
    );
    assert.isTrue(result.complete);
    assert.lengthOf(calls, 2);
  }),
);

it.effect("marks a bounded catalog incomplete rather than claiming exact all-project counts", () =>
  Effect.gen(function* () {
    let page = 0;
    const native = makeThreadHistory({
      request: () =>
        Effect.sync(() => ({ data: [thread(`thread-${++page}`)], nextCursor: `cursor-${page}` })),
    });
    const result = yield* readCodexCatalog(native, false);
    assert.isFalse(result.complete);
    assert.equal(result.threads.length, 100);
  }),
);
