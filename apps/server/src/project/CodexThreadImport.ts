import {
  CodexThreadError,
  CodexHistoryItem,
  CommandId,
  DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ThreadId,
  type CodexThreadsListInput,
  type CodexThreadsListResult,
  type CodexThreadsImportInput,
  type CodexThreadsHistoryInput,
  type CodexThreadsHistoryResult,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import {
  isUnsupportedHistoryMethod,
  type NativeThread,
} from "effect-codex-app-server/thread-history";
import { CodexAppServerRequestError } from "effect-codex-app-server/errors";
import * as Clock from "effect/Clock";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { agentSessionImportLock } from "./AgentSessionImportLock.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../provider/Services/ProviderSessionDirectory.ts";
import {
  classifyCodexOrigin,
  codexCatalogSourceKinds,
  isCodexChild,
  readCodexCatalog,
  topLevelCodexThreads,
  type CodexOriginEvidence,
} from "./CodexConversationCatalog.ts";
import { CodexImportTitle, needsCodexImportTitle } from "./CodexImportTitle.ts";
import { CodexThreadClient } from "./CodexThreadClient.ts";

const ResumeCursor = Schema.Struct({ threadId: Schema.String });
const HistoryBoundary = Schema.Struct({
  nativeThreadId: Schema.String,
  providerInstanceId: ProviderInstanceId,
  importedAt: Schema.String,
  homeIdentity: Schema.String,
  replacesLegacyMessages: Schema.optionalKey(Schema.Boolean),
  firstItem: Schema.NullOr(CodexHistoryItem),
  nextCursor: Schema.NullOr(Schema.String),
});
const ImportPayload = Schema.Struct({ codexHistoryImport: HistoryBoundary });
const encodeBoundary = Schema.encodeSync(Schema.fromJsonString(HistoryBoundary));
const TurnRow = Schema.Struct({ turnId: Schema.String });
const decodeTurns = Schema.decodeUnknownEffect(Schema.Array(TurnRow));
const decodeLegacyExists = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ present: Schema.Finite })),
);
const decodeCursor = Schema.decodeUnknownOption(ResumeCursor);
const decodeImport = Schema.decodeUnknownOption(ImportPayload);
const fail = (message: string) => new CodexThreadError({ message });
const isCodexThreadError = Schema.is(CodexThreadError);
const decodeStatus = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.String }));
const toError = (cause: unknown) =>
  isCodexThreadError(cause) ? cause : fail(cause instanceof Error ? cause.message : String(cause));

const CatalogCursor = Schema.fromJsonString(
  Schema.Struct({
    key: Schema.String,
    stamp: Schema.Finite,
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    query: Schema.String,
  }),
);
const encodeCatalogCursor = Schema.encodeSync(CatalogCursor);
const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeCatalogCursor = Schema.decodeUnknownEffect(CatalogCursor);
const OriginRow = Schema.Struct({
  threadId: ThreadId,
  firstAgent: Schema.Finite,
  humanCount: Schema.Finite,
});
const LegacyRow = Schema.Struct({ threadId: ThreadId });
const decodeOrigins = Schema.decodeUnknownEffect(Schema.Array(OriginRow));
const decodeLegacyRows = Schema.decodeUnknownEffect(Schema.Array(LegacyRow));
const isRequestError = Schema.is(CodexAppServerRequestError);

/** Match native identity independently of the T3 thread's arbitrary local id. */
export const findNativeBinding = Effect.fn("findNativeBinding")(function* (
  bindings: ReadonlyArray<ProviderRuntimeBinding>,
  instanceId: ProviderInstanceId,
  nativeThreadId: string,
  resolveHome: (id: ProviderInstanceId) => Effect.Effect<string, CodexThreadError>,
) {
  const candidates = bindings.filter(
    (binding) =>
      binding.provider === "codex" &&
      Option.getOrUndefined(decodeCursor(binding.resumeCursor))?.threadId === nativeThreadId,
  );
  const direct = candidates.find((binding) => binding.providerInstanceId === instanceId);
  if (direct) return Option.some(direct);
  if (candidates.length === 0) return Option.none<ProviderRuntimeBinding>();
  const home = yield* resolveHome(instanceId);
  for (const binding of candidates) {
    const savedImport = Option.getOrUndefined(
      decodeImport(binding.runtimePayload),
    )?.codexHistoryImport;
    const savedHome =
      savedImport?.nativeThreadId === nativeThreadId ? savedImport.homeIdentity : undefined;
    const otherHome =
      savedHome ??
      (binding.providerInstanceId
        ? yield* resolveHome(binding.providerInstanceId).pipe(Effect.orElseSucceed(() => ""))
        : "");
    if (otherHome === home) return Option.some(binding);
  }
  return Option.none<ProviderRuntimeBinding>();
});

export const makeCodexThreadImport = Effect.gen(function* () {
  const client = yield* CodexThreadClient;
  const titles = yield* CodexImportTitle;
  const directory = yield* ProviderSessionDirectory;
  const snapshots = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  const hasLegacyMessages = Effect.fn("CodexThreadImport.hasLegacyMessages")(function* (
    threadId: ThreadId,
  ) {
    const rows = yield* decodeLegacyExists(
      yield* sql`SELECT EXISTS(SELECT 1 FROM projection_thread_messages WHERE thread_id = ${threadId} AND message_id LIKE 'import:%') AS present`,
    );
    return rows[0]?.present === 1;
  });
  const omitProjectedTurns = Effect.fn("CodexThreadImport.omitProjectedTurns")(function* (
    threadId: ThreadId,
    items: ReadonlyArray<typeof CodexHistoryItem.Type>,
  ) {
    if (items.length === 0) return items;
    const rows = yield* decodeTurns(
      yield* sql`SELECT turn_id AS "turnId" FROM projection_turns WHERE thread_id = ${threadId} AND ${sql.in("turn_id", [...new Set(items.map((entry) => entry.turnId))])}`,
    );
    const projected = new Set(rows.map((row) => row.turnId));
    return items.filter((entry) => !projected.has(entry.turnId));
  });
  const lock = agentSessionImportLock;
  const find = (
    bindings: ReadonlyArray<ProviderRuntimeBinding>,
    instanceId: ProviderInstanceId,
    id: string,
  ) => findNativeBinding(bindings, instanceId, id, client.resolveNativeHomeIdentity);
  const project = Effect.fn("CodexThreadImport.project")(function* (
    id: CodexThreadsImportInput["projectId"],
  ) {
    const result = yield* snapshots.getProjectShellById(id);
    if (Option.isNone(result))
      return yield* fail("Project no longer exists. Select a project and try again.");
    return result.value;
  });

  type Catalog = {
    stamp: number;
    loadedAt: number;
    threads: ReadonlyArray<NativeThread>;
    complete: boolean;
    searches: Map<string, { matches: Map<string, string>; complete: boolean }>;
    messageSearchSupported: boolean | null;
  };
  const catalogs = new Map<string, Catalog>();
  const catalogLock = yield* Semaphore.make(1);
  let revision = 0;

  const list = Effect.fn("CodexThreadImport.list")(function* (
    input: CodexThreadsListInput,
  ): Effect.fn.Return<CodexThreadsListResult, unknown> {
    const selectedProject = input.projectId ? yield* project(input.projectId) : undefined;
    const cwd = input.cwd;
    const home = yield* client.resolveNativeHomeIdentity(input.providerInstanceId);
    const key = encodeIdentity([home, String(input.archived ?? false)]);
    const search = input.search?.trim() ?? "";
    const query = encodeIdentity([
      input.projectId ?? "",
      cwd ?? "",
      input.origin ?? "",
      search,
      input.searchScope ?? "titles",
    ]);
    const cursor = input.cursor
      ? yield* decodeCatalogCursor(input.cursor).pipe(
          Effect.mapError(() => fail("Invalid catalog cursor. Refresh the import list.")),
        )
      : undefined;
    const catalog = yield* catalogLock.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        let cached = catalogs.get(key);
        if (cursor) {
          if (cursor.key !== key || cursor.query !== query || cursor.stamp !== cached?.stamp)
            return yield* fail("The import list changed. Refresh it before continuing.");
        } else if (!cached || input.refresh || now - cached.loadedAt > 30_000) {
          const result = yield* client.withClient(input.providerInstanceId, (native) =>
            readCodexCatalog(native, input.archived ?? false),
          );
          cached = {
            ...result,
            stamp: ++revision,
            loadedAt: now,
            searches: new Map(),
            messageSearchSupported: null,
          };
          catalogs.set(key, cached);
          // Bound retained catalogs; cursors from evicted catalogs fail explicitly.
          if (catalogs.size > 8) catalogs.delete(catalogs.keys().next().value!);
        }
        if (!cached) return yield* fail("The import list expired. Refresh it before continuing.");
        if (search && input.searchScope === "messages" && !cached.searches.has(search)) {
          const result = yield* client
            .withClient(input.providerInstanceId, (native) =>
              Effect.gen(function* () {
                const matches = new Map<string, string>();
                const seen = new Set<string>();
                let next: string | undefined;
                for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
                  const page = yield* native.search({
                    searchTerm: search,
                    archived: input.archived ?? false,
                    sourceKinds: codexCatalogSourceKinds,
                    limit: 100,
                    sortKey: "updated_at",
                    sortDirection: "desc",
                    ...(next ? { cursor: next } : {}),
                  });
                  for (const match of page.data) matches.set(match.thread.id, match.snippet);
                  if (!page.nextCursor) return { matches, complete: true };
                  if (seen.has(page.nextCursor))
                    return yield* fail("Codex returned a non-advancing search cursor.");
                  seen.add(page.nextCursor);
                  next = page.nextCursor;
                }
                return { matches, complete: false };
              }),
            )
            .pipe(
              Effect.catch((error) => {
                if (isRequestError(error) && isUnsupportedHistoryMethod(error)) {
                  cached!.messageSearchSupported = false;
                  return Effect.fail(
                    fail(
                      "This Codex version does not support native message search. Upgrade Codex or search titles instead.",
                    ),
                  );
                }
                return Effect.fail(error);
              }),
            );
          cached.searches.set(search, result);
          if (cached.searches.size > 8)
            cached.searches.delete(cached.searches.keys().next().value!);
          cached.messageSearchSupported = true;
        }
        return cached;
      }),
    );
    const bindings = yield* directory.listBindings();
    const byNative = new Map<string, ProviderRuntimeBinding>();
    const homes = new Map<ProviderInstanceId, string>([[input.providerInstanceId, home]]);
    for (const binding of bindings) {
      if (binding.provider !== "codex") continue;
      const nativeId = Option.getOrUndefined(decodeCursor(binding.resumeCursor))?.threadId;
      if (!nativeId) continue;
      const saved = Option.getOrUndefined(decodeImport(binding.runtimePayload))?.codexHistoryImport;
      let bindingHome = saved?.nativeThreadId === nativeId ? saved.homeIdentity : undefined;
      if (!bindingHome && binding.providerInstanceId) {
        bindingHome = homes.get(binding.providerInstanceId);
        if (!bindingHome) {
          bindingHome = yield* client
            .resolveNativeHomeIdentity(binding.providerInstanceId)
            .pipe(Effect.orElseSucceed(() => ""));
          homes.set(binding.providerInstanceId, bindingHome);
        }
      }
      if (
        bindingHome === home &&
        (!byNative.has(nativeId) || binding.providerInstanceId === input.providerInstanceId)
      )
        byNative.set(nativeId, binding);
    }
    // Provenance is attached to actual T3 prompts. Synthetic legacy import
    // previews cannot establish human participation in an agent-created task.
    const boundThreadIds = [...new Set([...byNative.values()].map((binding) => binding.threadId))];
    const originRows =
      boundThreadIds.length === 0
        ? []
        : yield* decodeOrigins(
            yield* sql`
      WITH prompts AS (
        SELECT thread_id, agent_origin_json,
          ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at, rowid) AS position
        FROM projection_thread_messages WHERE role = 'user' AND message_id NOT LIKE 'import:%' AND ${sql.in("thread_id", boundThreadIds)}
      ) SELECT thread_id AS "threadId",
        MAX(CASE WHEN position = 1 AND agent_origin_json IS NOT NULL THEN 1 ELSE 0 END) AS "firstAgent",
        SUM(CASE WHEN agent_origin_json IS NULL THEN 1 ELSE 0 END) AS "humanCount"
      FROM prompts GROUP BY thread_id`,
          );
    const origins = new Map<ThreadId, CodexOriginEvidence>(
      originRows.map((row) => [
        row.threadId,
        { kind: row.firstAgent ? "agent" : "human", hasHumanParticipation: row.humanCount > 0 },
      ]),
    );
    const legacyRows =
      boundThreadIds.length === 0
        ? []
        : yield* decodeLegacyRows(
            yield* sql`SELECT DISTINCT thread_id AS "threadId" FROM projection_thread_messages WHERE message_id LIKE 'import:%' AND ${sql.in("thread_id", boundThreadIds)}`,
          );
    const legacy = new Set(legacyRows.map((row) => row.threadId));
    const projectedRows =
      boundThreadIds.length === 0
        ? []
        : yield* decodeLegacyRows(
            yield* sql`SELECT thread_id AS "threadId" FROM projection_threads WHERE deleted_at IS NULL AND ${sql.in("thread_id", boundThreadIds)}`,
          );
    const projected = new Set(projectedRows.map((row) => row.threadId));
    const snapshot = yield* snapshots.getShellSnapshot();
    const projectsByCwd = new Map(
      snapshot.projects.map((entry) => [
        normalizeProjectPathForComparison(entry.workspaceRoot),
        entry,
      ]),
    );
    const projectsById = new Map(snapshot.projects.map((entry) => [entry.id, entry]));
    for (const thread of snapshot.threads) {
      const owner = projectsById.get(thread.projectId);
      if (owner && thread.worktreePath) {
        const pathKey = normalizeProjectPathForComparison(thread.worktreePath);
        if (!projectsByCwd.has(pathKey)) projectsByCwd.set(pathKey, owner);
      }
    }
    const searchResult =
      search && input.searchScope === "messages" ? catalog.searches.get(search) : undefined;
    const lowerSearch = search.toLocaleLowerCase();
    const rows = topLevelCodexThreads(catalog.threads)
      .map(({ thread, childCount }) => {
        const binding = byNative.get(thread.id);
        const origin = classifyCodexOrigin(
          thread,
          binding ? origins.get(binding.threadId) : undefined,
        );
        const historyAvailable =
          binding !== undefined && Option.isSome(decodeImport(binding.runtimePayload));
        const retryableImport =
          historyAvailable && binding?.status === "stopped" && !projected.has(binding.threadId);
        return {
          id: thread.id,
          sourceIdentity: encodeIdentity([home, thread.id]),
          origin,
          childCount,
          title: thread.name || thread.preview || "Codex conversation",
          cwd: thread.cwd,
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(thread.createdAt * 1000)),
          updatedAt: DateTime.formatIso(DateTime.makeUnsafe(thread.updatedAt * 1000)),
          archived: thread.archived ?? input.archived ?? false,
          existingThreadId: retryableImport ? null : (binding?.threadId ?? null),
          historyAvailable: historyAvailable && !retryableImport,
          historyUpgradeAvailable:
            binding !== undefined && !historyAvailable && legacy.has(binding.threadId),
          ...(searchResult?.matches.has(thread.id)
            ? { matchPreview: searchResult.matches.get(thread.id)! }
            : {}),
        };
      })
      .filter(
        (row) =>
          (!input.origin || row.origin === input.origin) &&
          (!search ||
            (searchResult
              ? searchResult.matches.has(row.id)
              : `${row.title} ${row.cwd}`.toLocaleLowerCase().includes(lowerSearch))),
      );
    const groups = new Map<string, CodexThreadsListResult["projects"][number]>();
    for (const row of rows) {
      const pathKey = normalizeProjectPathForComparison(row.cwd);
      const known = projectsByCwd.get(pathKey);
      const group = groups.get(pathKey) ?? {
        cwd: row.cwd,
        title:
          known?.title ?? row.cwd.split(/[\\/]/).findLast((part) => part.length > 0) ?? row.cwd,
        existingProjectId: known?.id ?? null,
        totalCount: 0,
        importableCount: 0,
        humanCount: 0,
        agentCount: 0,
        mixedCount: 0,
        unknownCount: 0,
      };
      groups.set(pathKey, {
        ...group,
        totalCount: group.totalCount + 1,
        importableCount:
          group.importableCount +
          (row.existingThreadId === null || row.historyUpgradeAvailable ? 1 : 0),
        [`${row.origin}Count`]: group[`${row.origin}Count`] + 1,
      });
    }
    const filtered = rows.filter((row) => {
      const pathKey = normalizeProjectPathForComparison(row.cwd);
      return (
        (cwd === undefined || pathKey === normalizeProjectPathForComparison(cwd)) &&
        (!selectedProject ||
          pathKey === normalizeProjectPathForComparison(selectedProject.workspaceRoot) ||
          projectsByCwd.get(pathKey)?.id === selectedProject.id)
      );
    });
    const offset = cursor?.offset ?? 0;
    const threads = filtered.slice(offset, offset + 50);
    return {
      threads,
      projects: [...groups.values()],
      totalCount: filtered.length,
      catalogComplete: catalog.complete && (searchResult?.complete ?? true),
      messageSearchSupported: catalog.messageSearchSupported,
      nextCursor:
        offset + threads.length < filtered.length
          ? encodeCatalogCursor({
              key,
              stamp: catalog.stamp,
              offset: offset + threads.length,
              query,
            })
          : null,
    };
  }, Effect.mapError(toError));

  const adopt = Effect.fn("CodexThreadImport.adopt")(
    function* (input: CodexThreadsImportInput) {
      const selectedProject = yield* project(input.projectId);
      const bindings = yield* directory.listBindings();
      const existing = yield* find(bindings, input.providerInstanceId, input.nativeThreadId);
      let upgrading = false;
      if (Option.isSome(existing)) {
        const thread = yield* snapshots.getThreadShellById(existing.value.threadId);
        if (Option.isSome(thread)) {
          upgrading =
            Option.isNone(decodeImport(existing.value.runtimePayload)) &&
            (yield* hasLegacyMessages(existing.value.threadId));
          if (!upgrading) return { threadId: existing.value.threadId, alreadyImported: true };
        }
        if (
          Option.isNone(thread) &&
          (Option.isNone(decodeImport(existing.value.runtimePayload)) ||
            existing.value.status !== "stopped")
        )
          return yield* fail(
            "This Codex conversation already has a T3 binding but its thread is unavailable. Restore that thread before importing again.",
          );
        // A stopped imported binding with no projection is a retry after interruption.
      }
      return yield* client.withClient(input.providerInstanceId, (native) =>
        Effect.gen(function* () {
          const thread = yield* native.read(input.nativeThreadId);
          if (isCodexChild(thread))
            return yield* fail(
              "Subagent and review conversations belong to their parent and cannot be imported independently.",
            );
          const status = decodeStatus(thread.status);
          if (!upgrading && Option.isSome(status) && status.value.type === "active")
            return yield* fail(
              "This Codex conversation is active. Stop it in its original client before importing. T3 cannot take over an externally running conversation.",
            );
          const cwd = input.cwdOverride ?? thread.cwd;
          let worktreePath: string | null = null;
          if (!upgrading) {
            const stat = yield* fs
              .stat(cwd)
              .pipe(
                Effect.mapError(() =>
                  fail(
                    "The original conversation folder is unavailable. Choose an explicit workspace override to import it.",
                  ),
                ),
              );
            if (stat.type !== "Directory")
              return yield* fail("Choose an existing directory for this conversation.");
            if (
              normalizeProjectPathForComparison(cwd) !==
              normalizeProjectPathForComparison(selectedProject.workspaceRoot)
            ) {
              const snapshot = yield* snapshots.getShellSnapshot();
              const knownWorktree = snapshot.threads.some(
                (entry) =>
                  entry.projectId === input.projectId &&
                  entry.worktreePath !== null &&
                  normalizeProjectPathForComparison(entry.worktreePath) ===
                    normalizeProjectPathForComparison(cwd),
              );
              if (!knownWorktree)
                return yield* fail(
                  `This conversation belongs to '${cwd}'. Create or select a project rooted at that folder, or explicitly choose a workspace override.`,
                );
              worktreePath = cwd;
            }
          }
          // Capture one immutable starting point. Following its native cursor only reads
          // older items, so later T3 turns never leak into the imported history panel.
          const first = yield* native.items({
            threadId: thread.id,
            limit: 1,
            sortDirection: "desc",
          });
          // Codex rejects resuming archived sessions. The rollout path lets a
          // retry see that a previous interrupted adoption already restored it.
          const archived =
            typeof thread.path === "string"
              ? /(?:^|[\\/])archived_sessions[\\/]/.test(thread.path)
              : (thread.archived ?? input.archived ?? false);
          if (archived && !upgrading) yield* native.unarchive(thread.id);
          const importedAt = DateTime.formatIso(yield* DateTime.now);
          const homeIdentity = yield* client.resolveNativeHomeIdentity(input.providerInstanceId);
          const threadId =
            Option.getOrUndefined(existing)?.threadId ??
            ThreadId.make(`import:${input.providerInstanceId}:${thread.id}`);
          const boundary = {
            nativeThreadId: thread.id,
            providerInstanceId: input.providerInstanceId,
            importedAt,
            homeIdentity,
            firstItem: first.data[0] ?? null,
            nextCursor: first.nextCursor ?? null,
            replacesLegacyMessages: upgrading,
          };
          if (upgrading) {
            // Only attach immutable history metadata. Runtime state may have
            // changed while the native page was being read; never replay a stale binding.
            const rows = yield* sql`UPDATE provider_session_runtime
              SET runtime_payload_json = json_set(CASE WHEN json_valid(runtime_payload_json) AND json_type(runtime_payload_json) = 'object' THEN runtime_payload_json ELSE '{}' END, '$.codexHistoryImport', json(${encodeBoundary(boundary)}))
              WHERE thread_id = ${threadId} AND json_extract(runtime_payload_json, '$.codexHistoryImport') IS NULL
              RETURNING thread_id`;
            if (rows.length === 0 && Option.isNone(yield* directory.getBinding(threadId)))
              return yield* fail(
                "The T3 conversation binding disappeared during history import. Retry after restoring it.",
              );
            return { threadId, alreadyImported: true };
          }
          yield* directory.upsert(
            {
              threadId,
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId: input.providerInstanceId,
              status: "stopped",
              runtimeMode: DEFAULT_RUNTIME_MODE,
              resumeCursor: { threadId: thread.id },
              runtimePayload: {
                cwd,
                codexHistoryImport: boundary,
              },
            },
            { onConflict: "ignore" },
          );
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            projectId: input.projectId,
            title: thread.name || thread.preview || "Imported Codex conversation",
            modelSelection: {
              instanceId: input.providerInstanceId,
              model:
                thread.model ||
                DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make("codex")] ||
                DEFAULT_MODEL,
            },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath,
            createdAt: DateTime.formatIso(DateTime.makeUnsafe(thread.createdAt * 1000)),
            historyImport: true,
          });
          if (needsCodexImportTitle(thread.name)) {
            yield* titles.schedule({
              threadId,
              cwd,
              expectedTitle: thread.name || thread.preview || "Imported Codex conversation",
              context: thread.preview.slice(0, 4000),
            });
          }
          return { threadId, alreadyImported: false };
        }),
      );
    },
    lock.withPermit,
    Effect.mapError(toError),
  );

  const history = Effect.fn("CodexThreadImport.history")(function* (
    input: CodexThreadsHistoryInput,
  ): Effect.fn.Return<CodexThreadsHistoryResult, unknown> {
    const binding = yield* directory.getBinding(input.threadId);
    const imported = Option.isSome(binding)
      ? decodeImport(binding.value.runtimePayload)
      : Option.none();
    if (Option.isNone(imported) || Option.isNone(binding))
      return { imported: false, boundary: null, items: [], nextCursor: null };
    const boundary = imported.value.codexHistoryImport;
    const publicBoundary = {
      nativeThreadId: boundary.nativeThreadId,
      importedAt: boundary.importedAt,
      replacesLegacyMessages: boundary.replacesLegacyMessages ?? false,
    };
    const limit = input.limit ?? 50;
    const cursor = input.cursor ?? boundary.nextCursor;
    const firstItems = input.cursor ? [] : boundary.firstItem ? [boundary.firstItem] : [];
    if (!cursor || (firstItems.length === 1 && limit === 1))
      return {
        imported: true,
        boundary: publicBoundary,
        items: yield* omitProjectedTurns(input.threadId, firstItems),
        nextCursor: cursor,
      };
    const page = yield* client.withClient(boundary.providerInstanceId, (native) =>
      native.items({
        threadId: boundary.nativeThreadId,
        cursor,
        limit: limit - firstItems.length,
        sortDirection: "desc",
      }),
    );
    return {
      imported: true,
      boundary: publicBoundary,
      items: yield* omitProjectedTurns(input.threadId, [...firstItems, ...page.data]),
      nextCursor: page.nextCursor ?? null,
    };
  }, Effect.mapError(toError));
  return { list, adopt, history };
});

export class CodexThreadImport extends Context.Service<
  CodexThreadImport,
  Effect.Success<typeof makeCodexThreadImport>
>()("t3/project/CodexThreadImport") {}
export const CodexThreadImportLive = Layer.effect(CodexThreadImport, makeCodexThreadImport);
