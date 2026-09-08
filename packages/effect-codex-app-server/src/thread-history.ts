import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CodexAppServerRequestError, type CodexAppServerError } from "./errors.ts";

// Keep native item payloads, including new item variants and nested rich content.
export const NativeThreadItem = Schema.StructWithRest(
  Schema.Struct({ id: Schema.String, type: Schema.String }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type NativeThreadItem = typeof NativeThreadItem.Type;

export const NativeTurn = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    status: Schema.String,
    items: Schema.Array(NativeThreadItem),
    itemsView: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type NativeTurn = typeof NativeTurn.Type;

export const NativeThread = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    cwd: Schema.String,
    modelProvider: Schema.String,
    preview: Schema.String,
    createdAt: Schema.Finite,
    updatedAt: Schema.Finite,
    name: Schema.optionalKey(Schema.NullOr(Schema.String)),
    model: Schema.optionalKey(Schema.NullOr(Schema.String)),
    source: Schema.optionalKey(Schema.Unknown),
    status: Schema.optionalKey(Schema.Unknown),
    archived: Schema.optionalKey(Schema.Boolean),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type NativeThread = typeof NativeThread.Type;

export const NativeThreadItemEntry = Schema.Struct({
  turnId: Schema.String,
  item: NativeThreadItem,
});
export type NativeThreadItemEntry = typeof NativeThreadItemEntry.Type;

const cursors = {
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  backwardsCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
};
const ThreadPage = Schema.Struct({ data: Schema.Array(NativeThread), ...cursors });
const TurnPage = Schema.Struct({ data: Schema.Array(NativeTurn), ...cursors });
const ItemPage = Schema.Struct({ data: Schema.Array(NativeThreadItemEntry), ...cursors });

export interface PageParams {
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly sortDirection?: "asc" | "desc";
}
export interface ThreadListParams extends PageParams {
  readonly cwd?: string | ReadonlyArray<string>;
  readonly archived?: boolean;
  readonly modelProviders?: ReadonlyArray<string>;
  readonly sourceKinds?: ReadonlyArray<string>;
  readonly searchTerm?: string;
  readonly sortKey?: "created_at" | "updated_at";
  readonly useStateDbOnly?: boolean;
}
export interface ThreadTurnsParams extends PageParams {
  readonly threadId: string;
  readonly itemsView?: "notLoaded" | "summary" | "full";
}
export interface ThreadItemsParams extends PageParams {
  readonly threadId: string;
  readonly turnId?: string;
}
export interface ThreadHistoryRawClient {
  readonly request: (
    method: string,
    params?: unknown,
  ) => Effect.Effect<unknown, CodexAppServerError>;
}

/** Detect protocol-level unsupported methods, never invalid cursors or transport failures. */
export const isUnsupportedHistoryMethod = (error: CodexAppServerError): boolean =>
  error._tag === "CodexAppServerRequestError" && error.code === -32601;

const legacyCursorPrefix = "t3-codex-legacy-items:v1:";
const LegacyCursor = Schema.fromJsonString(
  Schema.Struct({
    threadId: Schema.String,
    turnId: Schema.NullOr(Schema.String),
    direction: Schema.Literals(["asc", "desc"]),
    turnCursor: Schema.NullOr(Schema.String),
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    expectedTurnId: Schema.NullOr(Schema.String),
    previousItemId: Schema.optionalKey(Schema.String),
  }),
);
type LegacyCursor = typeof LegacyCursor.Type;
const decodeLegacyCursor = Schema.decodeEffect(LegacyCursor);
const encodeLegacyCursor = Schema.encodeEffect(LegacyCursor);

/** One bounded native page per call. Cursors belong to Codex and must remain opaque. */
export const makeThreadHistory = (raw: ThreadHistoryRawClient) => {
  const request = Effect.fn("CodexThreadHistory.request")(function* <A, I>(
    method: string,
    params: unknown,
    schema: Schema.Codec<A, I>,
  ) {
    const result = yield* raw.request(method, params).pipe(
      Effect.mapError((error) =>
        isUnsupportedHistoryMethod(error)
          ? new CodexAppServerRequestError({
              code: -32601,
              method,
              errorMessage: `Codex does not support ${method}. Upgrade Codex to use paginated thread history.`,
              cause: error,
            })
          : error,
      ),
    );
    return yield* Schema.decodeUnknownEffect(schema)(result).pipe(
      Effect.mapError((error) =>
        CodexAppServerRequestError.invalidPayload(method, "decode-payload", error),
      ),
    );
  });

  const limit = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(1, Math.min(100, Math.floor(value)))
      : 50;

  const legacyItems = Effect.fn("CodexThreadHistory.legacyItems")(function* (
    params: ThreadItemsParams,
  ) {
    const direction = params.sortDirection ?? "asc";
    const cursor: LegacyCursor = params.cursor
      ? yield* decodeLegacyCursor(params.cursor.slice(legacyCursorPrefix.length)).pipe(
          Effect.mapError((error) =>
            CodexAppServerRequestError.invalidPayload("thread/items/list", "decode-payload", error),
          ),
        )
      : {
          threadId: params.threadId,
          turnId: params.turnId ?? null,
          direction,
          turnCursor: null,
          offset: 0,
          expectedTurnId: null,
        };
    if (
      cursor.threadId !== params.threadId ||
      cursor.turnId !== (params.turnId ?? null) ||
      cursor.direction !== direction
    ) {
      return yield* CodexAppServerRequestError.invalidParams(
        "Legacy item cursor does not match this thread, turn, or direction.",
      );
    }
    // Legacy Codex supports paging turns, but cannot page items within a turn.
    // Read at most one full native turn per call; never hydrate thread/read.
    const page = yield* request(
      "thread/turns/list",
      {
        threadId: params.threadId,
        cursor: cursor.turnCursor,
        limit: 1,
        sortDirection: direction,
        itemsView: "full",
      },
      TurnPage,
    );
    const turn = page.data[0];
    if (page.nextCursor != null && page.nextCursor === cursor.turnCursor) {
      return yield* CodexAppServerRequestError.invalidParams(
        "Codex returned a non-advancing legacy history cursor.",
      );
    }
    if (cursor.expectedTurnId !== null && turn?.id !== cursor.expectedTurnId) {
      // Older saved cursors may precede their turn instead of anchoring it.
      // Skip one newly appended turn per request without exposing its items.
      if (page.nextCursor == null) {
        return yield* CodexAppServerRequestError.invalidParams(
          "Legacy history anchor is no longer available; the source may have been compacted or rolled back.",
        );
      }
      const continuation = yield* encodeLegacyCursor({
        ...cursor,
        turnCursor: page.nextCursor,
      }).pipe(
        Effect.mapError((error) =>
          CodexAppServerRequestError.invalidPayload("thread/items/list", "encode-payload", error),
        ),
      );
      return { data: [], nextCursor: legacyCursorPrefix + continuation, backwardsCursor: null };
    }
    const matching =
      turn !== undefined && (params.turnId === undefined || turn.id === params.turnId);
    const items = matching ? (direction === "desc" ? turn.items.toReversed() : turn.items) : [];
    if (
      cursor.offset > items.length ||
      (cursor.previousItemId !== undefined &&
        items[cursor.offset - 1]?.id !== cursor.previousItemId)
    ) {
      return yield* CodexAppServerRequestError.invalidParams(
        "Legacy thread items changed while paging; restart history loading.",
      );
    }
    const selected = items.slice(cursor.offset, cursor.offset + limit(params.limit));
    const offset = cursor.offset + selected.length;
    const lastSelected = selected.at(-1);
    const next: LegacyCursor | null =
      offset < items.length && turn
        ? {
            ...cursor,
            offset,
            expectedTurnId: turn.id,
            // Native backwardsCursor includes this turn as its anchor. Keep it
            // opaque; re-reading the newest page would shift after continuation.
            turnCursor: page.backwardsCursor ?? cursor.turnCursor,
            ...(lastSelected ? { previousItemId: lastSelected.id } : {}),
          }
        : page.nextCursor != null && !(matching && params.turnId !== undefined)
          ? {
              threadId: cursor.threadId,
              turnId: cursor.turnId,
              direction: cursor.direction,
              turnCursor: page.nextCursor,
              offset: 0,
              expectedTurnId: null,
            }
          : null;
    const nextCursor =
      next === null
        ? null
        : legacyCursorPrefix +
          (yield* encodeLegacyCursor(next).pipe(
            Effect.mapError((error) =>
              CodexAppServerRequestError.invalidPayload(
                "thread/items/list",
                "encode-payload",
                error,
              ),
            ),
          ));
    return {
      data: turn ? selected.map((item) => ({ turnId: turn.id, item })) : [],
      nextCursor,
      backwardsCursor: null,
    };
  });

  const items = Effect.fn("CodexThreadHistory.items")(function* (params: ThreadItemsParams) {
    if (params.cursor?.startsWith(legacyCursorPrefix)) return yield* legacyItems(params);
    return yield* request(
      "thread/items/list",
      { ...params, limit: limit(params.limit) },
      ItemPage,
    ).pipe(
      Effect.catch((error) => {
        if (!isUnsupportedHistoryMethod(error)) return Effect.fail(error);
        // A native item cursor cannot be reinterpreted as a native turn cursor.
        if (params.cursor)
          return Effect.fail(
            CodexAppServerRequestError.invalidParams(
              "Codex item paging is no longer available; restart history loading.",
            ),
          );
        return legacyItems(params);
      }),
    );
  });

  return {
    list: (params: ThreadListParams = {}) =>
      request("thread/list", { ...params, limit: limit(params.limit) }, ThreadPage),
    read: (threadId: string) =>
      request(
        "thread/read",
        { threadId, includeTurns: false },
        Schema.Struct({ thread: NativeThread }),
      ).pipe(Effect.map(({ thread }) => thread)),
    unarchive: (threadId: string) =>
      request("thread/unarchive", { threadId }, Schema.Struct({ thread: NativeThread })).pipe(
        Effect.map(({ thread }) => thread),
      ),
    turns: (params: ThreadTurnsParams) =>
      request(
        "thread/turns/list",
        { itemsView: "notLoaded", ...params, limit: limit(params.limit) },
        TurnPage,
      ),
    items,
  };
};
