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

const cursors = {
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  backwardsCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
};
const ThreadPage = Schema.Struct({ data: Schema.Array(NativeThread), ...cursors });
const SearchPage = Schema.Struct({
  data: Schema.Array(Schema.Struct({ thread: NativeThread, snippet: Schema.String })),
  ...cursors,
});
const TurnPage = Schema.Struct({ data: Schema.Array(NativeTurn), ...cursors });

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
export interface ThreadSearchParams extends PageParams {
  readonly searchTerm: string;
  readonly archived?: boolean;
  readonly sourceKinds?: ReadonlyArray<string>;
  readonly sortKey?: "created_at" | "updated_at";
}
export interface ThreadTurnsParams extends PageParams {
  readonly threadId: string;
  readonly itemsView?: "notLoaded" | "summary" | "full";
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

  return {
    list: (params: ThreadListParams = {}) =>
      request("thread/list", { ...params, limit: limit(params.limit) }, ThreadPage),
    search: (params: ThreadSearchParams) =>
      request("thread/search", { ...params, limit: limit(params.limit) }, SearchPage),
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
  };
};
