import {
  CodexThreadError,
  CommandId,
  DEFAULT_MODEL,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ThreadId,
  TurnId,
  type CodexThreadsListInput,
  type CodexThreadsListResult,
  type CodexThreadsImportInput,
  type CodexThreadsImportResult,
  type OrchestrationThreadActivity,
  type ProviderEvent,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import {
  isUnsupportedHistoryMethod,
  type NativeThread,
  type NativeThreadItem,
  type NativeTurn,
  type makeThreadHistory,
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
import { projectActivityPayload } from "../orchestration/ActivityPayloadProjection.ts";
import { runtimeEventToActivities } from "../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { mapCodexHistoryItem } from "../provider/Layers/CodexAdapter.ts";
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
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { makeCodexWorktreeResolver } from "./CodexWorktreeResolver.ts";
import { CodexThreadClient } from "./CodexThreadClient.ts";

const ResumeCursor = Schema.Struct({ threadId: Schema.String });
/**
 * Stored beside the provider binding so later imports can recognize the native
 * conversation across Codex homes and tell whether it has moved on since.
 */
const HistoryImportMarker = Schema.Struct({
  nativeThreadId: Schema.String,
  homeIdentity: Schema.String,
  importedAt: Schema.String,
  lastActivityAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const ImportPayload = Schema.Struct({ codexHistoryImport: HistoryImportMarker });
const encodeMarker = Schema.encodeSync(Schema.fromJsonString(HistoryImportMarker));
const decodeCursor = Schema.decodeUnknownOption(ResumeCursor);
const decodeImport = Schema.decodeUnknownOption(ImportPayload);
const decodeThreadRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ threadId: ThreadId })),
);
const decodeTurnRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ turnId: Schema.String })),
);
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
const decodeOrigins = Schema.decodeUnknownEffect(Schema.Array(OriginRow));
const isRequestError = Schema.is(CodexAppServerRequestError);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmptyString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

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

/** Flatten a native user message into prompt text; non-text parts become short placeholders. */
function userMessageText(item: NativeThreadItem): string {
  if (!Array.isArray(item.content)) return nonEmptyString(item.text) ?? "";
  const parts: Array<string> = [];
  for (const part of item.content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    const text = nonEmptyString(part.text);
    if (part.type === "text" && text !== null) {
      parts.push(text);
      continue;
    }
    const location = nonEmptyString(part.path) ?? nonEmptyString(part.url);
    const name = nonEmptyString(part.name);
    if (part.type === "image" || part.type === "localImage")
      parts.push(location && !location.startsWith("data:") ? `Image: ${location}` : "[Image]");
    else if (part.type === "skill" || part.type === "mention")
      parts.push(`${part.type === "skill" ? "Skill" : "Mention"}: ${name ?? location ?? "?"}`);
    else if (text !== null) parts.push(text);
  }
  return parts.join("\n\n");
}

export interface CodexHistoryMaterialization {
  readonly messages: Array<{
    readonly messageId: MessageId;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly turnId: TurnId;
    readonly createdAt: string;
  }>;
  readonly activities: Array<OrchestrationThreadActivity>;
  readonly turnCount: number;
  /** Time of the last materialized item, or null when no turn was materialized. */
  readonly lastActivityAt: string | null;
}

/**
 * Turns native turns into the messages and activities T3 stores for live
 * turns. Codex records time per turn, not per item, so items are spread across
 * the turn's duration in native order; timestamps stay strictly increasing so
 * the timeline orders them exactly as Codex did.
 */
export function materializeCodexTurns(input: {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly nativeThreadId: string;
  readonly turns: ReadonlyArray<NativeTurn>;
  /** Fallback clock for turns without native timestamps, in epoch milliseconds. */
  readonly startMs: number;
}): CodexHistoryMaterialization {
  const messages: CodexHistoryMaterialization["messages"] = [];
  const activities: Array<OrchestrationThreadActivity> = [];
  // Last emitted time; the first item may land exactly on the thread's start.
  let clock = input.startMs - 1;
  for (const turn of input.turns) {
    const startedMs = typeof turn.startedAt === "number" ? turn.startedAt * 1000 : null;
    const completedMs = typeof turn.completedAt === "number" ? turn.completedAt * 1000 : null;
    const start = Math.max(startedMs ?? 0, clock + 1);
    const span = completedMs !== null && completedMs > start ? completedMs - start : 0;
    const count = turn.items.length;
    turn.items.forEach((item, index) => {
      const spread = span > 0 ? Math.round((span * index) / Math.max(count - 1, 1)) : index;
      clock = Math.max(start + spread, clock + 1);
      const createdAt = DateTime.formatIso(DateTime.makeUnsafe(clock));
      const turnId = TurnId.make(turn.id);
      if (item.type === "userMessage" || item.type === "agentMessage") {
        const text =
          item.type === "userMessage" ? userMessageText(item) : nonEmptyString(item.text);
        if (!text) return;
        messages.push({
          messageId: MessageId.make(`history:${item.id}`),
          role: item.type === "userMessage" ? "user" : "assistant",
          text,
          turnId,
          createdAt,
        });
        return;
      }
      const event: ProviderEvent = {
        id: EventId.make(`history:${item.id}`),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: input.providerInstanceId,
        threadId: input.threadId,
        createdAt,
        method: "item/completed",
        turnId,
        itemId: ProviderItemId.make(item.id),
        payload: { threadId: input.nativeThreadId, turnId: turn.id, item, completedAtMs: clock },
      };
      const runtimeEvent = mapCodexHistoryItem(event, input.threadId);
      if (!runtimeEvent) return;
      for (const activity of runtimeEventToActivities(runtimeEvent)) {
        activities.push(projectActivityPayload(activity));
      }
    });
    if (count === 0) clock = start;
  }
  return {
    messages,
    activities,
    turnCount: input.turns.length,
    lastActivityAt:
      input.turns.length === 0 ? null : DateTime.formatIso(DateTime.makeUnsafe(clock)),
  };
}

export const makeCodexThreadImport = Effect.gen(function* () {
  const client = yield* CodexThreadClient;
  const titles = yield* CodexImportTitle;
  const directory = yield* ProviderSessionDirectory;
  const snapshots = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  const worktrees = yield* makeCodexWorktreeResolver(yield* GitVcsDriver);
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
  const projectedTurnIds = Effect.fn("CodexThreadImport.projectedTurnIds")(function* (
    threadId: ThreadId,
  ) {
    const rows = yield* decodeTurnRows(
      yield* sql`SELECT turn_id AS "turnId" FROM projection_turns WHERE thread_id = ${threadId} AND turn_id IS NOT NULL`,
    );
    return new Set(rows.map((row) => row.turnId));
  });
  const writeMarker = (threadId: ThreadId, marker: typeof HistoryImportMarker.Type) =>
    sql`UPDATE provider_session_runtime
      SET runtime_payload_json = json_set(CASE WHEN json_valid(runtime_payload_json) AND json_type(runtime_payload_json) = 'object' THEN runtime_payload_json ELSE '{}' END, '$.codexHistoryImport', json(${encodeMarker(marker)}))
      WHERE thread_id = ${threadId}`;
  const readAllTurns = Effect.fn("CodexThreadImport.readAllTurns")(function* (
    native: ReturnType<typeof makeThreadHistory>,
    threadId: string,
  ) {
    const turns: Array<NativeTurn> = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 1_000; pageNumber++) {
      const page = yield* native.turns({
        threadId,
        itemsView: "full",
        sortDirection: "asc",
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      turns.push(...page.data);
      if (!page.nextCursor) return turns;
      if (seen.has(page.nextCursor))
        return yield* fail("Codex returned a non-advancing history cursor. Try again.");
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return yield* fail("This conversation is too long to import.");
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
    if (input.refresh && !input.cursor) yield* worktrees.invalidate;
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
      String(input.hideImported ?? false),
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
    const projectedRows =
      boundThreadIds.length === 0
        ? []
        : yield* decodeThreadRows(
            yield* sql`SELECT thread_id AS "threadId" FROM projection_threads WHERE deleted_at IS NULL AND ${sql.in("thread_id", boundThreadIds)}`,
          );
    const projected = new Set(projectedRows.map((row) => row.threadId));
    // Imports made before turns were materialized are empty shells; offer them
    // for an update so their history can be backfilled.
    const withTurnsRows =
      boundThreadIds.length === 0
        ? []
        : yield* decodeThreadRows(
            yield* sql`SELECT DISTINCT thread_id AS "threadId" FROM projection_turns WHERE ${sql.in("thread_id", boundThreadIds)}`,
          );
    const withTurns = new Set(withTurnsRows.map((row) => row.threadId));
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
    const rootThreads = topLevelCodexThreads(catalog.threads);
    const identities = yield* worktrees.resolveCatalog({
      threads: rootThreads.map(({ thread }) => thread),
      codexHome: home.startsWith("codex:home:") ? home.slice("codex:home:".length) : home,
      projectRoots: [
        ...snapshot.projects.map((entry) => entry.workspaceRoot),
        ...(selectedProject ? [selectedProject.workspaceRoot] : []),
        ...(cwd ? [cwd] : []),
      ],
    });
    const workspaceHints = new Map(
      yield* Effect.forEach(
        [...new Set(rootThreads.map(({ thread }) => thread.cwd))],
        (sourceCwd) =>
          Effect.gen(function* () {
            const identity = identities.get(sourceCwd);
            const known = projectsByCwd.get(normalizeProjectPathForComparison(sourceCwd));
            const ownerIdentity = known ? identities.get(known.workspaceRoot) : undefined;
            const projectCwd =
              identity?.projectCwd ??
              ownerIdentity?.projectCwd ??
              known?.workspaceRoot ??
              sourceCwd;
            const checkouts =
              identity?.checkouts ??
              ownerIdentity?.checkouts ??
              ((yield* worktrees.existingDirectory(projectCwd))
                ? [{ cwd: projectCwd, branch: null, isMain: true }]
                : []);
            return [
              sourceCwd,
              {
                projectCwd,
                worktreePath: identity
                  ? identity.worktreePath
                  : sourceCwd !== projectCwd
                    ? sourceCwd
                    : null,
                worktreeBranch: identity?.worktreeBranch ?? null,
                worktreeMissing:
                  identity?.worktreeMissing ?? (yield* worktrees.missingDirectory(sourceCwd)),
                checkouts,
              },
            ] as const;
          }),
        { concurrency: 4 },
      ),
    );
    const canonicalFilter = (value: string) =>
      identities.get(value)?.projectCwd ?? workspaceHints.get(value)?.projectCwd ?? value;
    const searchResult =
      search && input.searchScope === "messages" ? catalog.searches.get(search) : undefined;
    const lowerSearch = search.toLocaleLowerCase();
    const rows = rootThreads
      .map(({ thread, childCount }) => {
        const binding = byNative.get(thread.id);
        const origin = classifyCodexOrigin(
          thread,
          binding ? origins.get(binding.threadId) : undefined,
        );
        const marker = binding
          ? Option.getOrUndefined(decodeImport(binding.runtimePayload))?.codexHistoryImport
          : undefined;
        // A stopped import binding without a projected thread is an interrupted
        // adoption: offer it again instead of pointing at a missing thread.
        const retryableImport =
          marker !== undefined && binding?.status === "stopped" && !projected.has(binding.threadId);
        const existingThreadId = retryableImport ? null : (binding?.threadId ?? null);
        const lastActivityAt = marker?.lastActivityAt ? Date.parse(marker.lastActivityAt) : NaN;
        return {
          id: thread.id,
          sourceIdentity: encodeIdentity([home, thread.id]),
          origin,
          childCount,
          title: thread.name || thread.preview || "Codex conversation",
          cwd: thread.cwd,
          projectCwd: workspaceHints.get(thread.cwd)!.projectCwd,
          worktreePath: workspaceHints.get(thread.cwd)!.worktreePath,
          worktreeBranch: workspaceHints.get(thread.cwd)!.worktreeBranch,
          worktreeMissing: workspaceHints.get(thread.cwd)!.worktreeMissing,
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(thread.createdAt * 1000)),
          updatedAt: DateTime.formatIso(DateTime.makeUnsafe(thread.updatedAt * 1000)),
          archived: thread.archived ?? input.archived ?? false,
          existingThreadId,
          updateAvailable:
            existingThreadId !== null &&
            (!withTurns.has(existingThreadId) ||
              (Number.isFinite(lastActivityAt) && thread.updatedAt * 1000 > lastActivityAt)),
          ...(searchResult?.matches.has(thread.id)
            ? { matchPreview: searchResult.matches.get(thread.id)! }
            : {}),
        };
      })
      .filter(
        (row) =>
          (!input.hideImported || row.existingThreadId === null || row.updateAvailable) &&
          (!input.origin || row.origin === input.origin) &&
          (!search ||
            (searchResult
              ? searchResult.matches.has(row.id)
              : `${row.title} ${row.cwd} ${row.projectCwd} ${row.worktreeBranch ?? ""}`
                  .toLocaleLowerCase()
                  .includes(lowerSearch))),
      );
    const groups = new Map<string, CodexThreadsListResult["projects"][number]>();
    for (const row of rows) {
      const pathKey = normalizeProjectPathForComparison(row.projectCwd);
      const known = projectsByCwd.get(pathKey);
      const group = groups.get(pathKey) ?? {
        cwd: row.projectCwd,
        checkouts: workspaceHints.get(row.cwd)!.checkouts,
        title:
          known?.title ??
          row.projectCwd.split(/[\\/]/).findLast((part) => part.length > 0) ??
          row.projectCwd,
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
          group.importableCount + (row.existingThreadId === null || row.updateAvailable ? 1 : 0),
        [`${row.origin}Count`]: group[`${row.origin}Count`] + 1,
      });
    }
    const filtered = rows.filter((row) => {
      const pathKey = normalizeProjectPathForComparison(row.projectCwd);
      return (
        (cwd === undefined ||
          pathKey === normalizeProjectPathForComparison(canonicalFilter(cwd))) &&
        (!selectedProject ||
          pathKey ===
            normalizeProjectPathForComparison(canonicalFilter(selectedProject.workspaceRoot)) ||
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

  /**
   * Import a native conversation as a T3 thread with its complete history, or
   * append the turns Codex recorded since a previous import of the same
   * conversation. Turns already projected (imported earlier or run through T3)
   * are skipped, so repeating an import is safe.
   */
  const adopt = Effect.fn("CodexThreadImport.adopt")(
    function* (
      input: CodexThreadsImportInput,
    ): Effect.fn.Return<CodexThreadsImportResult, unknown> {
      const selectedProject = yield* project(input.projectId);
      const bindings = yield* directory.listBindings();
      const existing = yield* find(bindings, input.providerInstanceId, input.nativeThreadId);
      const existingThread = Option.isSome(existing)
        ? yield* snapshots.getThreadShellById(existing.value.threadId)
        : Option.none<never>();
      if (Option.isSome(existing) && Option.isNone(existingThread)) {
        // A stopped imported binding with no projection is a retry after interruption.
        if (
          Option.isNone(decodeImport(existing.value.runtimePayload)) ||
          existing.value.status !== "stopped"
        )
          return yield* fail(
            "This Codex conversation already has a T3 binding but its thread is unavailable. Restore that thread before importing again.",
          );
      }
      if (Option.isSome(existingThread) && existingThread.value.archivedAt !== null)
        return yield* fail(
          "This conversation is archived in T3 Code. Unarchive it before importing new turns.",
        );
      const updating = Option.isSome(existingThread);
      return yield* client.withClient(input.providerInstanceId, (native) =>
        Effect.gen(function* () {
          const thread = yield* native.read(input.nativeThreadId);
          if (isCodexChild(thread))
            return yield* fail(
              "Subagent and review conversations belong to their parent and cannot be imported independently.",
            );
          const status = decodeStatus(thread.status);
          if (Option.isSome(status) && status.value.type === "active")
            return yield* fail(
              "This Codex conversation is active. Stop it in its original client before importing. T3 cannot take over an externally running conversation.",
            );
          const cwd = input.cwdOverride ?? thread.cwd;
          let worktreePath: string | null = null;
          let worktreeBranch: string | null = null;
          if (!updating) {
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
              const sourceIdentity = yield* worktrees.resolveFresh(cwd);
              const targetIdentity = yield* worktrees.resolveFresh(selectedProject.workspaceRoot);
              const sameDirectory =
                (yield* fs.realPath(cwd)) === (yield* fs.realPath(selectedProject.workspaceRoot));
              if (
                !sameDirectory &&
                (!sourceIdentity ||
                  !targetIdentity ||
                  sourceIdentity.gitCommonDir !== targetIdentity.gitCommonDir)
              )
                return yield* fail(
                  `The selected checkout '${cwd}' does not belong to this project's Git repository. Choose an existing checkout of the same repository.`,
                );
              worktreeBranch = sourceIdentity?.worktreeBranch ?? null;
              worktreePath = cwd;
            }
          }
          // Codex rejects resuming archived sessions. The rollout path lets a
          // retry see that a previous interrupted adoption already restored it.
          const archived =
            typeof thread.path === "string"
              ? /(?:^|[\\/])archived_sessions[\\/]/.test(thread.path)
              : (thread.archived ?? input.archived ?? false);
          // Codex 0.153 read(includeTurns:false) can report createdAt as updatedAt.
          // Discovery metadata carries the correct activity time without loading history.
          const activityCatalog = yield* readCodexCatalog(native, archived, {
            cwd: thread.cwd,
            targetIds: [thread.id],
          }).pipe(Effect.orElseSucceed(() => null));
          const sourceActivity = activityCatalog?.threads.find(
            (entry) => entry.id === thread.id,
          )?.updatedAt;
          const threadId =
            Option.getOrUndefined(existing)?.threadId ??
            ThreadId.make(`import:${input.providerInstanceId}:${thread.id}`);
          const projectedTurns = updating ? yield* projectedTurnIds(threadId) : new Set<string>();
          const turns = (yield* readAllTurns(native, thread.id)).filter(
            (turn) => !projectedTurns.has(turn.id),
          );
          const history = materializeCodexTurns({
            threadId,
            providerInstanceId: input.providerInstanceId,
            nativeThreadId: thread.id,
            turns,
            startMs: thread.createdAt * 1000,
          });
          if (archived && !updating) yield* native.unarchive(thread.id);
          const importedAt = DateTime.formatIso(yield* DateTime.now);
          const homeIdentity = yield* client.resolveNativeHomeIdentity(input.providerInstanceId);
          const lastActivityAt = [
            sourceActivity === undefined ? null : sourceActivity * 1000,
            history.lastActivityAt === null ? null : Date.parse(history.lastActivityAt),
          ].reduce<number | null>(
            (latest, value) =>
              value !== null && (latest === null || value > latest) ? value : latest,
            null,
          );
          const marker = {
            nativeThreadId: thread.id,
            homeIdentity,
            importedAt,
            lastActivityAt:
              lastActivityAt === null
                ? null
                : DateTime.formatIso(DateTime.makeUnsafe(lastActivityAt)),
          };
          if (!updating) {
            // Install the cursor before the thread becomes visible; insert-ignore
            // keeps a concurrent live session's newer binding.
            yield* directory.upsert(
              {
                threadId,
                provider: ProviderDriverKind.make("codex"),
                providerInstanceId: input.providerInstanceId,
                status: "stopped",
                runtimeMode: DEFAULT_RUNTIME_MODE,
                resumeCursor: { threadId: thread.id },
                runtimePayload: { cwd, codexHistoryImport: marker },
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
              branch: worktreeBranch,
              worktreePath,
              createdAt: DateTime.formatIso(DateTime.makeUnsafe(thread.createdAt * 1000)),
              historyImport: true,
            });
          }
          if (history.messages.length > 0) {
            yield* engine.dispatch({
              type: "thread.history.import",
              commandId: CommandId.make(yield* crypto.randomUUIDv4),
              threadId,
              messages: history.messages,
              activities: history.activities,
            });
          }
          yield* writeMarker(threadId, marker);
          if (!updating && needsCodexImportTitle(thread.name)) {
            yield* titles.schedule({
              threadId,
              cwd,
              expectedTitle: thread.name || thread.preview || "Imported Codex conversation",
              context: thread.preview.slice(0, 4000),
            });
          }
          return { threadId, importedTurnCount: history.turnCount };
        }),
      );
    },
    lock.withPermit,
    Effect.mapError(toError),
  );

  return { list, adopt };
});

export class CodexThreadImport extends Context.Service<
  CodexThreadImport,
  Effect.Success<typeof makeCodexThreadImport>
>()("t3/project/CodexThreadImport") {}
export const CodexThreadImportLive = Layer.effect(CodexThreadImport, makeCodexThreadImport);
