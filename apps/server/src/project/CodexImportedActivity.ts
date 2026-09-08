import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { readCodexCatalog } from "./CodexConversationCatalog.ts";
import type { NativeThread } from "effect-codex-app-server/thread-history";
import { CodexThreadClient } from "./CodexThreadClient.ts";

const Boundary = Schema.Struct({
  nativeThreadId: Schema.String,
  providerInstanceId: ProviderInstanceId,
  homeIdentity: Schema.String,
  lastActivityAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodePayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ codexHistoryImport: Boundary })),
);
const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ threadId: ThreadId, payload: Schema.NullOr(Schema.String) })),
);
type PendingActivity = { readonly threadId: ThreadId; readonly boundary: typeof Boundary.Type };
const toIso = (value: string | number) => Option.map(DateTime.make(value), DateTime.formatIso);

/** Read durable import activity; older imports backfill bounded native metadata once. */
export const makeCodexImportedActivity = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const client = yield* CodexThreadClient;
  const attempts = new Map<ThreadId, number>();
  const catalogs = new Map<
    ProviderInstanceId,
    { home: string; loadedAt: number; archivedLoaded: boolean; threads: Map<string, NativeThread> }
  >();
  let lastAttemptedId = "";

  return Effect.fn("CodexImportedActivity.lookup")(
    function* (threadIds: ReadonlyArray<ThreadId>) {
      const activity = new Map<ThreadId, string>();
      const missing: Array<PendingActivity> = [];
      const ids = [...new Set(threadIds)];
      for (let offset = 0; offset < ids.length; offset += 500) {
        const rows = yield* decodeRows(
          yield* sql`SELECT thread_id AS "threadId", runtime_payload_json AS payload
        FROM provider_session_runtime WHERE provider_name = 'codex' AND ${sql.in("thread_id", ids.slice(offset, offset + 500))}`,
        );
        for (const row of rows) {
          const imported = Option.getOrUndefined(decodePayload(row.payload));
          if (!imported) continue;
          const boundary = imported.codexHistoryImport;
          const saved = boundary.lastActivityAt
            ? toIso(boundary.lastActivityAt)
            : Option.none<string>();
          if (Option.isSome(saved)) activity.set(row.threadId, saved.value);
          else missing.push({ threadId: row.threadId, boundary });
        }
      }
      // Rotate over a stable identity order so failed/deleted sources cannot
      // monopolize the first 50 slots. Failures also get a bounded retry cooldown.
      missing.sort((a, b) => a.threadId.localeCompare(b.threadId));
      const next = missing.findIndex((row) => row.threadId.localeCompare(lastAttemptedId) > 0);
      const ordered = next <= 0 ? missing : [...missing.slice(next), ...missing.slice(0, next)];
      const now = yield* Clock.currentTimeMillis;
      const pending = ordered
        .filter(
          (row) => now - (attempts.get(row.threadId) ?? Number.NEGATIVE_INFINITY) >= 5 * 60_000,
        )
        .slice(0, 50);
      for (const row of pending) attempts.set(row.threadId, now);
      if (pending.length > 0) lastAttemptedId = pending.at(-1)!.threadId;
      while (attempts.size > 2048) attempts.delete(attempts.keys().next().value!);
      const groups = Map.groupBy(pending, (row) => row.boundary.providerInstanceId);
      yield* Effect.forEach(
        groups,
        ([instanceId, rows]) =>
          Effect.gen(function* () {
            const home = yield* client.resolveNativeHomeIdentity(instanceId);
            const matching = rows.filter((row) => row.boundary.homeIdentity === home);
            if (matching.length === 0) return;
            let cached = catalogs.get(instanceId);
            if (!cached || cached.home !== home || now - cached.loadedAt > 30_000)
              cached = undefined;
            if (
              !cached ||
              (matching.some((row) => !cached!.threads.has(row.boundary.nativeThreadId)) &&
                !cached.archivedLoaded)
            ) {
              cached = yield* client.withClient(instanceId, (native) =>
                Effect.gen(function* () {
                  const entry = cached ?? {
                    home,
                    loadedAt: now,
                    archivedLoaded: false,
                    threads: new Map(
                      (yield* readCodexCatalog(native, false)).threads.map((thread) => [
                        thread.id,
                        thread,
                      ]),
                    ),
                  };
                  if (
                    matching.some((row) => !entry.threads.has(row.boundary.nativeThreadId)) &&
                    !entry.archivedLoaded
                  ) {
                    const archived = yield* readCodexCatalog(native, true);
                    for (const thread of archived.threads) entry.threads.set(thread.id, thread);
                    entry.archivedLoaded = true;
                  }
                  return entry;
                }),
              );
              catalogs.set(instanceId, cached);
              if (catalogs.size > 8) catalogs.delete(catalogs.keys().next().value!);
            }
            const metadata = cached.threads;
            yield* Effect.forEach(
              matching,
              (row) =>
                Effect.gen(function* () {
                  // Never use thread/read(includeTurns:false): some Codex versions return
                  // creation time there. Missing catalog metadata leaves the import active.
                  const thread = metadata.get(row.boundary.nativeThreadId);
                  if (!thread) return;
                  const timestamp = toIso(thread.updatedAt * 1000);
                  if (Option.isNone(timestamp)) return;
                  const saved =
                    yield* sql`UPDATE provider_session_runtime SET runtime_payload_json = json_set(runtime_payload_json, '$.codexHistoryImport.lastActivityAt', ${timestamp.value})
          WHERE thread_id = ${row.threadId} AND json_valid(runtime_payload_json)
          AND json_extract(runtime_payload_json, '$.codexHistoryImport.nativeThreadId') = ${row.boundary.nativeThreadId}
          AND json_extract(runtime_payload_json, '$.codexHistoryImport.providerInstanceId') = ${instanceId}
          AND json_extract(runtime_payload_json, '$.codexHistoryImport.homeIdentity') = ${home}
          AND json_extract(runtime_payload_json, '$.codexHistoryImport.lastActivityAt') IS NULL RETURNING thread_id`;
                  if (saved.length > 0) activity.set(row.threadId, timestamp.value);
                }).pipe(
                  Effect.catchCause((cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? Effect.failCause(cause)
                      : Effect.logDebug("native import activity unavailable", {
                          threadId: row.threadId,
                        }),
                  ),
                ),
              { concurrency: 4, discard: true },
            );
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logDebug("native import activity provider unavailable", { instanceId }),
            ),
          ),
        { concurrency: 2, discard: true },
      );
      return activity;
    },
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("native import activity lookup failed").pipe(
            Effect.as(new Map<ThreadId, string>()),
          ),
    ),
  );
});
