import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { CodexAppServerRequestError } from "./errors.ts";
import { makeThreadHistory, type ThreadHistoryRawClient } from "./thread-history.ts";

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
      assert.strictEqual(yield* history.turns({ threadId: "thread-1" }).pipe(Effect.flip), failure);
    }
    const malformed = makeThreadHistory({
      request: () => Effect.succeed({ data: [{ status: "completed" }] }),
    });
    const error = yield* malformed.turns({ threadId: "thread-1" }).pipe(Effect.flip);
    assert.equal(error._tag, "CodexAppServerRequestError");
    assert.notInclude(error.message, "Upgrade Codex");
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
