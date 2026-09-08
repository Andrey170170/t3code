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
  type CodexThreadsImportInput,
  type CodexThreadsHistoryInput,
  type CodexThreadsHistoryResult,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
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

  const list = Effect.fn("CodexThreadImport.list")(function* (input: CodexThreadsListInput) {
    const selectedProject = input.projectId ? yield* project(input.projectId) : undefined;
    const bindings = yield* directory.listBindings();
    return yield* client.withClient(input.providerInstanceId, (native) =>
      Effect.gen(function* () {
        // Omitting the project exposes other folders, including external worktrees.
        const page = yield* native.list({
          ...(selectedProject ? { cwd: selectedProject.workspaceRoot } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
          ...(input.search ? { searchTerm: input.search } : {}),
          archived: input.archived ?? false,
          limit: 50,
          sortDirection: "desc",
          sortKey: "updated_at",
        });
        const threads = yield* Effect.forEach(page.data, (thread) =>
          Effect.gen(function* () {
            const binding = yield* find(bindings, input.providerInstanceId, thread.id);
            return {
              id: thread.id,
              title: thread.name || thread.preview || "Codex conversation",
              cwd: thread.cwd,
              createdAt: DateTime.formatIso(DateTime.makeUnsafe(thread.createdAt * 1000)),
              updatedAt: DateTime.formatIso(DateTime.makeUnsafe(thread.updatedAt * 1000)),
              archived: thread.archived ?? input.archived ?? false,
              existingThreadId: Option.getOrNull(Option.map(binding, (entry) => entry.threadId)),
              historyAvailable:
                Option.isSome(binding) && Option.isSome(decodeImport(binding.value.runtimePayload)),
              historyUpgradeAvailable:
                Option.isSome(binding) &&
                Option.isNone(decodeImport(binding.value.runtimePayload)) &&
                (yield* hasLegacyMessages(binding.value.threadId)),
            };
          }),
        );
        return { threads, nextCursor: page.nextCursor ?? null };
      }),
    );
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
          const status = decodeStatus(thread.status);
          if (!upgrading && Option.isSome(status) && status.value.type === "active")
            return yield* fail(
              "This Codex conversation is active. Stop it in its original client before importing. T3 cannot take over an externally running conversation.",
            );
          const cwd = input.cwdOverride ?? thread.cwd;
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
            )
              return yield* fail(
                `This conversation belongs to '${cwd}'. Create or select a project rooted at that folder, or explicitly choose a workspace override.`,
              );
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
            worktreePath: null,
            createdAt: DateTime.formatIso(DateTime.makeUnsafe(thread.createdAt * 1000)),
            historyImport: true,
          });
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
