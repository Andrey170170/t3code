import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { CodexAppServerRequestError } from "./errors.ts";
import {
  makeThreadHistory,
  type NativeThreadItemEntry,
  type ThreadHistoryRawClient,
} from "./thread-history.ts";

it.effect("loads separate native pages without changing opaque cursors or rich items", () =>
  Effect.gen(function* () {
    const calls: Array<{ method: string; params: unknown }> = [];
    const item = {
      id: "item-1",
      type: "futureRichTool",
      content: [
        { type: "image", url: "file:///image.png" },
        { type: "text", text: "details" },
      ],
      output: { nested: [1, true, null] },
      agent: { threadId: "agent-1", role: "assistant" },
    };
    const cursor = "opaque:cursor/with+punctuation==";
    const raw: ThreadHistoryRawClient = {
      request: (method, params) =>
        Effect.sync(() => {
          calls.push({ method, params });
          return calls.length === 1
            ? { data: [{ turnId: "turn-1", item }], nextCursor: cursor, backwardsCursor: "back" }
            : { data: [], nextCursor: null };
        }),
    };
    const history = makeThreadHistory(raw);
    const first = yield* history.items({ threadId: "thread-1", limit: 2 });
    assert.deepEqual(first.data, [{ turnId: "turn-1", item }]);
    assert.lengthOf(calls, 1);
    const second = yield* history.items({
      threadId: "thread-1",
      cursor: first.nextCursor ?? null,
      limit: 2,
    });
    assert.isNull(second.nextCursor);
    assert.deepEqual(calls[1], {
      method: "thread/items/list",
      params: { threadId: "thread-1", cursor, limit: 2 },
    });
  }),
);

it.effect("reads metadata without full hydration and retains newer metadata", () =>
  Effect.gen(function* () {
    const metadata = {
      id: "thread-1",
      cwd: "/repo",
      modelProvider: "openai",
      model: "model-1",
      preview: "hello",
      name: null,
      createdAt: 1,
      updatedAt: 2,
      source: { subAgent: { threadSpawn: { parentThreadId: "parent" } } },
      status: { type: "notLoaded" },
      futureMetadata: ["preserved"],
    };
    const history = makeThreadHistory({
      request: (method, params) =>
        Effect.sync(() => {
          assert.equal(method, "thread/read");
          assert.deepEqual(params, { threadId: "thread-1", includeTurns: false });
          return { thread: metadata };
        }),
    });
    assert.deepEqual(yield* history.read("thread-1"), metadata);
  }),
);

it.effect("requires a bounded page and preserves discovery filters", () =>
  Effect.gen(function* () {
    const filters = {
      cwd: ["/repo", "/worktree"],
      archived: true,
      sourceKinds: ["cli", "appServer"],
      modelProviders: ["openai"],
    };
    const history = makeThreadHistory({
      request: (method, params) =>
        Effect.sync(() => {
          assert.equal(method, "thread/list");
          assert.deepEqual(params, { ...filters, limit: 100 });
          return { data: [], nextCursor: null };
        }),
    });
    yield* history.list({ ...filters, limit: 100000 });
  }),
);

it.effect("reports unsupported paging without silently fetching full legacy history", () =>
  Effect.gen(function* () {
    const methods: Array<string> = [];
    const history = makeThreadHistory({
      request: (method) => {
        methods.push(method);
        return Effect.fail(CodexAppServerRequestError.methodNotFound(method));
      },
    });
    const error = yield* history.turns({ threadId: "thread-1" }).pipe(Effect.flip);
    assert.equal(error._tag, "CodexAppServerRequestError");
    assert.include(error.message, "Upgrade Codex");
    assert.deepEqual(methods, ["thread/turns/list"]);
  }),
);

it.effect("does not disguise cursor, server, or malformed-response errors as unsupported", () =>
  Effect.gen(function* () {
    for (const failure of [
      CodexAppServerRequestError.invalidParams("invalid cursor"),
      CodexAppServerRequestError.internalError("disk error"),
    ]) {
      const history = makeThreadHistory({ request: () => Effect.fail(failure) });
      assert.strictEqual(yield* history.items({ threadId: "thread-1" }).pipe(Effect.flip), failure);
    }
    const malformed = makeThreadHistory({
      request: () => Effect.succeed({ data: [{ item: {} }] }),
    });
    const error = yield* malformed.items({ threadId: "thread-1" }).pipe(Effect.flip);
    assert.equal(error._tag, "CodexAppServerRequestError");
    assert.notInclude(error.message, "Upgrade Codex");
  }),
);

const legacyTurns = [
  { id: "empty-first", status: "completed", items: [] },
  {
    id: "large",
    status: "completed",
    items: Array.from({ length: 125 }, (_, i) => ({
      id: `rich-${i}`,
      type: "futureTool",
      content: [{ type: "image", url: `file:///${i}.png` }],
      payload: { rich: [true, null, { output: "retained" }] },
    })),
  },
  { id: "empty-middle", status: "completed", items: [] },
  {
    id: "last",
    status: "completed",
    items: [{ id: "last-item", type: "agentMessage", text: "done" }],
  },
  { id: "empty-last", status: "completed", items: [] },
];

it.effect(
  "pages legacy rich items across turns and client restarts without gaps or duplicates",
  () =>
    Effect.gen(function* () {
      for (const direction of ["asc", "desc"] as const) {
        const calls: Array<string> = [];
        const turns = direction === "asc" ? legacyTurns : legacyTurns.toReversed();
        const raw: ThreadHistoryRawClient = {
          request: (method, params) => {
            calls.push(method);
            if (method === "thread/items/list")
              return Effect.fail(
                CodexAppServerRequestError.methodNotFound("thread/items/list is not supported yet"),
              );
            return Effect.sync(() => {
              if (typeof params !== "object" || params === null || !("cursor" in params))
                throw new Error("missing params");
              assert.equal(method, "thread/turns/list");
              assert.propertyVal(params, "limit", 1);
              assert.propertyVal(params, "itemsView", "full");
              assert.propertyVal(params, "sortDirection", direction);
              const index =
                params.cursor === null
                  ? 0
                  : Number(String(params.cursor).replace("opaque-native/", ""));
              return {
                data: [turns[index]],
                nextCursor: index + 1 < turns.length ? `opaque-native/${index + 1}` : null,
              };
            });
          },
        };
        let cursor: string | null = null;
        const received: Array<unknown> = [];
        let pages = 0;
        do {
          // First request may be the import's limit=1 snapshot fence; subsequent
          // requests use a newly scoped app-server client and a different size.
          const page: {
            readonly data: ReadonlyArray<NativeThreadItemEntry>;
            readonly nextCursor?: string | null;
          } = yield* makeThreadHistory(raw).items({
            threadId: "legacy",
            sortDirection: direction,
            cursor,
            limit: pages < 2 ? 1 : 50,
          });
          assert.isAtMost(page.data.length, pages < 2 ? 1 : 50);
          received.push(...page.data);
          cursor = page.nextCursor ?? null;
          pages++;
          assert.isBelow(pages, 20);
        } while (cursor !== null);
        const expected = turns.flatMap((turn) =>
          (direction === "asc" ? turn.items : turn.items.toReversed()).map((item) => ({
            turnId: turn.id,
            item,
          })),
        );
        assert.deepEqual(received, expected);
        assert.equal(calls.filter((method) => method === "thread/items/list").length, 1);
        assert.notInclude(calls, "thread/read");
      }
    }),
);

it.effect("rejects mismatched legacy cursor context and non-advancing empty pages", () =>
  Effect.gen(function* () {
    let requests = 0;
    const raw: ThreadHistoryRawClient = {
      request: (method) => {
        requests++;
        return method === "thread/items/list"
          ? Effect.fail(CodexAppServerRequestError.methodNotFound(method))
          : Effect.succeed({ data: [], nextCursor: "stuck-native" });
      },
    };
    const page = yield* makeThreadHistory(raw).items({ threadId: "legacy" });
    const cursor = page.nextCursor ?? null;
    const mismatch = yield* makeThreadHistory(raw)
      .items({ threadId: "other", cursor })
      .pipe(Effect.flip);
    assert.include(mismatch.message, "does not match");
    assert.equal(requests, 2);
    const stuck = yield* makeThreadHistory(raw)
      .items({ threadId: "legacy", cursor })
      .pipe(Effect.flip);
    assert.include(stuck.message, "non-advancing");
  }),
);

it.effect(
  "retains a partial imported turn after newer turns appear, including older saved cursors",
  () =>
    Effect.gen(function* () {
      for (const supportsAnchor of [true, false]) {
        const older = {
          id: "older",
          status: "completed",
          items: [{ id: "old", type: "agentMessage", text: "old" }],
        };
        const imported = {
          id: "imported",
          status: "completed",
          items: [
            { id: "user", type: "userMessage", text: "original" },
            { id: "assistant", type: "agentMessage", text: "original response" },
          ],
        };
        const appended = {
          id: "appended",
          status: "completed",
          items: [{ id: "new", type: "agentMessage", text: "new response" }],
        };
        let turns = [imported, older];
        const raw: ThreadHistoryRawClient = {
          request: (method, params) => {
            if (method === "thread/items/list")
              return Effect.fail(CodexAppServerRequestError.methodNotFound(method));
            return Effect.sync(() => {
              if (typeof params !== "object" || params === null || !("cursor" in params))
                throw new Error("missing cursor");
              const token = params.cursor;
              const index =
                token === null
                  ? 0
                  : turns.findIndex(
                      (turn) => token === `at/${turn.id}` || token === `after/${turn.id}`,
                    ) + (String(token).startsWith("after/") ? 1 : 0);
              const turn = turns[index];
              return {
                data: turn ? [turn] : [],
                nextCursor: index + 1 < turns.length ? `after/${turn?.id}` : null,
                ...(supportsAnchor && turn ? { backwardsCursor: `at/${turn.id}` } : {}),
              };
            });
          },
        };
        const first = yield* makeThreadHistory(raw).items({
          threadId: "thread",
          sortDirection: "desc",
          limit: 1,
        });
        assert.equal(first.data[0]?.item.id, "assistant");
        turns = [appended, ...turns];
        let cursor = first.nextCursor ?? null;
        const remaining: Array<string> = [];
        for (let i = 0; cursor !== null && i < 5; i++) {
          const page: { data: ReadonlyArray<NativeThreadItemEntry>; nextCursor?: string | null } =
            yield* makeThreadHistory(raw).items({
              threadId: "thread",
              sortDirection: "desc",
              cursor,
            });
          remaining.push(...page.data.map((entry) => entry.item.id));
          cursor = page.nextCursor ?? null;
        }
        assert.isNull(cursor);
        assert.deepEqual(remaining, ["user", "old"]);
      }
    }),
);

it.effect("reports removed legacy anchors and rolled-back items as unavailable", () =>
  Effect.gen(function* () {
    for (const removedTurn of [true, false]) {
      let changed = false;
      const raw: ThreadHistoryRawClient = {
        request: (method) =>
          method === "thread/items/list"
            ? Effect.fail(CodexAppServerRequestError.methodNotFound(method))
            : Effect.succeed({
                data:
                  changed && removedTurn
                    ? []
                    : [
                        {
                          id: "turn",
                          status: "completed",
                          items: changed
                            ? [{ id: "replacement", type: "agentMessage" }]
                            : [
                                { id: "a", type: "userMessage" },
                                { id: "b", type: "agentMessage" },
                              ],
                        },
                      ],
                nextCursor: null,
              }),
      };
      const first = yield* makeThreadHistory(raw).items({ threadId: "thread", limit: 1 });
      changed = true;
      const failure = yield* makeThreadHistory(raw)
        .items({ threadId: "thread", cursor: first.nextCursor ?? null })
        .pipe(Effect.flip);
      assert.equal(failure._tag, "CodexAppServerRequestError");
      assert.match(failure.message, /no longer available|items changed/);
    }
  }),
);

it.effect("searches native message content with snippets and opaque pagination", () =>
  Effect.gen(function* () {
    const history = makeThreadHistory({
      request: (method, params) =>
        Effect.sync(() => {
          assert.equal(method, "thread/search");
          assert.deepEqual(params, {
            searchTerm: "needle",
            sourceKinds: ["exec"],
            cursor: "opaque",
            limit: 100,
          });
          return {
            data: [
              {
                thread: {
                  id: "match",
                  cwd: "/repo",
                  modelProvider: "custom",
                  preview: "unrelated title",
                  createdAt: 1,
                  updatedAt: 2,
                },
                snippet: "message needle match",
              },
            ],
            nextCursor: "next",
          };
        }),
    });
    const page = yield* history.search({
      searchTerm: "needle",
      sourceKinds: ["exec"],
      cursor: "opaque",
      limit: 1000,
    });
    assert.equal(page.data[0]?.snippet, "message needle match");
    assert.equal(page.nextCursor, "next");
  }),
);
