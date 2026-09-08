import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CodexThreadError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { makeThreadHistory, type NativeThread } from "effect-codex-app-server/thread-history";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { CodexImportTitle } from "./CodexImportTitle.ts";
import { CodexThreadClient } from "./CodexThreadClient.ts";
import { findNativeBinding, makeCodexThreadImport } from "./CodexThreadImport.ts";

const instanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project");
const repository = ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistenceMemory));
const testLayer = Layer.mergeAll(
  NodeServices.layer,
  SqlitePersistenceMemory,
  repository,
  ProviderSessionDirectoryLive.pipe(Layer.provide(repository)),
);
const historicalItem = {
  turnId: "turn-old",
  item: { id: "item-fence", type: "agentMessage", text: "old answer", phase: "final_answer" },
};
const olderItem = {
  turnId: "turn-old",
  item: { id: "item-user", type: "userMessage", content: [{ type: "text", text: "old question" }] },
};

const makeHarness = (
  options: {
    active?: boolean;
    cwd?: string;
    nativeId?: string;
    nativeName?: string;
    archived?: boolean;
    historyLength?: number;
    existingThread?: OrchestrationThreadShell;
    catalog?: ReadonlyArray<NativeThread>;
  } = {},
) => {
  const commands: Array<OrchestrationCommand> = [];
  const titleRequests: Array<{
    threadId: ThreadId;
    cwd: string;
    expectedTitle: string;
    context: string;
  }> = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  let newItemAppeared = false;
  const native = makeThreadHistory({
    request: (method, params) =>
      Effect.sync(() => {
        requests.push({ method, params });
        if (method === "thread/list") return { data: options.catalog ?? [], nextCursor: null };
        if (method === "thread/search")
          return {
            data: (options.catalog ?? []).map((thread) => ({
              thread,
              snippet: "Found in message",
            })),
            nextCursor: null,
          };
        if (method === "thread/read" || method === "thread/unarchive")
          return {
            thread: {
              id: options.nativeId ?? "native-1",
              path: options.archived
                ? "/home/.codex/archived_sessions/thread.jsonl"
                : "/home/.codex/sessions/thread.jsonl",
              cwd: options.cwd ?? "/tmp",
              modelProvider: "openai",
              preview: "My native thread",
              ...(options.nativeName !== undefined ? { name: options.nativeName } : {}),
              createdAt: 1_700_000_000,
              updatedAt: 1_700_000_001,
              status: { type: options.active ? "active" : "idle" },
            },
          };
        if (method === "thread/items/list") {
          const cursor = (params as { cursor?: string }).cursor;
          if (options.historyLength !== undefined) {
            const offset = Number(cursor ?? 0);
            const end = Math.min(
              offset + (params as { limit: number }).limit,
              options.historyLength,
            );
            return {
              data: Array.from({ length: end - offset }, (_, index) => ({
                turnId: `turn-${index + offset}`,
                item: {
                  id: `item-${index + offset}`,
                  type: "agentMessage",
                  text: `answer ${index + offset}`,
                },
              })),
              nextCursor: end < options.historyLength ? String(end) : null,
            };
          }
          if (cursor === "before-fence") return { data: [olderItem], nextCursor: null };
          return {
            data: [
              newItemAppeared
                ? {
                    turnId: "new-turn",
                    item: { id: "new-item", type: "agentMessage", text: "live" },
                  }
                : historicalItem,
            ],
            nextCursor: "before-fence",
          };
        }
        return { data: [], nextCursor: null };
      }),
  });
  const services = Layer.mergeAll(
    Layer.mock(CodexImportTitle)({
      schedule: (input) =>
        Effect.sync(() => {
          titleRequests.push(input);
        }),
    }),
    Layer.succeed(
      CodexThreadClient,
      CodexThreadClient.of({
        withClient: (_id, use) => use(native),
        resolveNativeHomeIdentity: () => Effect.succeed("shared-home"),
      }),
    ),
    Layer.mock(ProjectionSnapshotQuery)({
      getProjectShellById: () =>
        Effect.succeed(
          Option.some({
            id: projectId,
            title: "Project",
            workspaceRoot: "/tmp",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        ),
      getShellSnapshot: () =>
        Effect.succeed({
          projects: [],
          threads: [],
          snapshotSequence: 0,
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      getThreadShellById: () => Effect.succeed(Option.fromUndefinedOr(options.existingThread)),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
    }),
  );
  return {
    services,
    commands,
    titleRequests,
    requests,
    appendLiveItem: () => {
      newItemAppeared = true;
    },
  };
};

it.layer(testLayer)("Codex native imports", (it) => {
  it.effect("requests a title only for fresh imports without a meaningful native title", () =>
    Effect.gen(function* () {
      for (const [nativeId, nativeName, expectedCount] of [
        ["unnamed", undefined, 1],
        ["named", "Trace attention circuits", 0],
        ["placeholder", "New thread", 1],
      ] as const) {
        const harness = makeHarness({
          nativeId,
          ...(nativeName === undefined ? {} : { nativeName }),
        });
        const importer = yield* makeCodexThreadImport.pipe(Effect.provide(harness.services));
        yield* importer.adopt({
          providerInstanceId: instanceId,
          nativeThreadId: nativeId,
          projectId,
        });
        expect(harness.titleRequests).toHaveLength(expectedCount);
        if (expectedCount)
          expect(harness.titleRequests[0]).toMatchObject({
            context: "My native thread",
            expectedTitle: nativeName ?? "My native thread",
            cwd: "/tmp",
          });
      }
    }),
  );

  it.effect("keeps interrupted native adoptions selectable for retry", () =>
    Effect.gen(function* () {
      const nativeThread = {
        id: "interrupted-native",
        cwd: "/tmp",
        modelProvider: "openai",
        preview: "Interrupted",
        createdAt: 1,
        updatedAt: 2,
        threadSource: "user",
      };
      const harness = makeHarness({ catalog: [nativeThread], nativeId: nativeThread.id });
      const importer = yield* makeCodexThreadImport.pipe(Effect.provide(harness.services));
      // The harness records thread.create without projecting it, reproducing a
      // binding that survived interruption before the projection was installed.
      yield* importer.adopt({
        providerInstanceId: instanceId,
        nativeThreadId: nativeThread.id,
        projectId,
      });
      const listed = yield* importer.list({ providerInstanceId: instanceId });
      expect(listed.threads[0]?.existingThreadId).toBeNull();
      expect(listed.projects[0]?.importableCount).toBe(1);
      const retried = yield* importer.adopt({
        providerInstanceId: instanceId,
        nativeThreadId: nativeThread.id,
        projectId,
      });
      expect(retried.alreadyImported).toBe(false);
    }),
  );

  it.effect(
    "uses real T3 prompt provenance for agent and mixed origins, excluding import previews",
    () =>
      Effect.gen(function* () {
        const nativeThread = {
          id: "task-native",
          cwd: "/tmp",
          modelProvider: "openai",
          preview: "Task",
          createdAt: 1,
          updatedAt: 2,
          threadSource: "user",
        };
        const harness = makeHarness({ catalog: [nativeThread] });
        const directory = yield* ProviderSessionDirectory;
        const taskId = ThreadId.make("task-thread");
        yield* directory.upsert({
          threadId: taskId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          status: "stopped",
          resumeCursor: { threadId: nativeThread.id },
          runtimePayload: {},
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,role,text,is_streaming,created_at,updated_at,agent_origin_json) VALUES ('task-prompt',${taskId},'user','Do task',0,'2026-01-01','2026-01-01','{"threadId":"agent-parent","operationId":"task"}')`;
        yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('import:synthetic',${taskId},'user','preview',0,'2025-01-01','2025-01-01')`;
        const importer = yield* makeCodexThreadImport.pipe(Effect.provide(harness.services));
        const agent = yield* importer.list({ providerInstanceId: instanceId });
        expect(agent.threads[0]?.origin).toBe("agent");
        expect(agent.projects[0]?.agentCount).toBe(1);
        yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('human-followup',${taskId},'user','Please adjust',0,'2026-01-02','2026-01-02')`;
        const mixed = yield* importer.list({ providerInstanceId: instanceId, origin: "mixed" });
        expect(mixed.threads[0]?.origin).toBe("mixed");
        expect(mixed.projects[0]?.mixedCount).toBe(1);
      }),
  );

  it.effect(
    "catalog counts only roots, exposes all providers, and caches metadata across pages",
    () =>
      Effect.gen(function* () {
        const roots = Array.from({ length: 51 }, (_, index) => ({
          id: `root-${index}`,
          cwd: "/tmp",
          modelProvider: "custom",
          preview: `Root ${index}`,
          createdAt: 1,
          updatedAt: 2,
          threadSource: "user",
        }));
        const harness = makeHarness({
          catalog: [
            ...roots,
            { ...roots[0]!, id: "child", threadSource: "subagent", parentThreadId: "root-0" },
            { ...roots[0]!, id: "guardian", threadSource: "guardian_review" },
          ],
        });
        const importer = yield* makeCodexThreadImport.pipe(Effect.provide(harness.services));
        const first = yield* importer.list({ providerInstanceId: instanceId });
        expect(first.totalCount).toBe(51);
        expect(first.projects[0]).toMatchObject({ cwd: "/tmp", totalCount: 51, humanCount: 51 });
        expect(first.threads[0]).toMatchObject({ id: "root-0", childCount: 1, origin: "human" });
        expect(first.threads).toHaveLength(50);
        const second = yield* importer.list({
          providerInstanceId: instanceId,
          cursor: first.nextCursor!,
        });
        expect(second.threads).toHaveLength(1);
        expect(second.nextCursor).toBeNull();
        expect(harness.requests.filter(({ method }) => method === "thread/list")).toHaveLength(1);
        expect(harness.requests.some(({ method }) => method === "thread/read")).toBe(false);
        const search = yield* importer.list({
          providerInstanceId: instanceId,
          search: "message",
          searchScope: "messages",
        });
        expect(search.threads[0]?.matchPreview).toBe("Found in message");
        expect(search.messageSearchSupported).toBe(true);
        const wrongFilter = yield* importer
          .list({ providerInstanceId: instanceId, cursor: first.nextCursor!, origin: "agent" })
          .pipe(Effect.result);
        expect(wrongFilter._tag).toBe("Failure");
        yield* importer.list({ providerInstanceId: instanceId, refresh: true });
        const stalePage = yield* importer
          .list({ providerInstanceId: instanceId, cursor: first.nextCursor! })
          .pipe(Effect.result);
        expect(stalePage._tag).toBe("Failure");
      }),
  );

  it.effect(
    "persists native identity and a rich history fence across runtime updates and restart",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const importer = yield* makeCodexThreadImport.pipe(Effect.provide(harness.services));
        const result = yield* importer.adopt({
          projectId,
          providerInstanceId: instanceId,
          nativeThreadId: "native-1",
        });
        expect(result.alreadyImported).toBe(false);
        expect(harness.commands.map((command) => command.type)).toEqual(["thread.create"]);
        const directory = yield* ProviderSessionDirectory;
        expect(Option.getOrThrow(yield* directory.getBinding(result.threadId))).toMatchObject({
          resumeCursor: { threadId: "native-1" },
          runtimePayload: { cwd: "/tmp" },
          status: "stopped",
        });
        harness.appendLiveItem();
        yield* directory.upsert({
          threadId: result.threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          status: "running",
          runtimePayload: { cwd: "/tmp", pid: 42 },
        });
        const restarted = yield* makeCodexThreadImport.pipe(Effect.provide(harness.services));
        const page = yield* restarted.history({ threadId: result.threadId });
        expect(page.items).toEqual([historicalItem, olderItem]);
        expect(page.nextCursor).toBeNull();
        expect(
          harness.requests.filter((request) => request.method === "thread/items/list"),
        ).toEqual([
          {
            method: "thread/items/list",
            params: { threadId: "native-1", limit: 1, sortDirection: "desc" },
          },
          {
            method: "thread/items/list",
            params: {
              threadId: "native-1",
              cursor: "before-fence",
              limit: 49,
              sortDirection: "desc",
            },
          },
        ]);
      }),
  );

  it.effect("reads every item through bounded native pages without a total-history cap", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ nativeId: "native-long", historyLength: 1205 });
      const importer = yield* makeCodexThreadImport.pipe(Effect.provide(harness.services));
      const adopted = yield* importer.adopt({
        projectId,
        providerInstanceId: instanceId,
        nativeThreadId: "native-long",
      });
      const ids: Array<unknown> = [];
      let cursor: string | undefined;
      do {
        const page = yield* importer.history({
          threadId: adopted.threadId,
          ...(cursor ? { cursor } : {}),
        });
        expect(page.items.length).toBeLessThanOrEqual(50);
        ids.push(...page.items.map((entry) => entry.item.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(ids).toEqual(Array.from({ length: 1205 }, (_, index) => `item-${index}`));
    }),
  );

  it.effect(
    "restores an archived native thread only after validating and fencing its history",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({ nativeId: "native-archived", archived: true });
        const importer = yield* makeCodexThreadImport.pipe(Effect.provide(harness.services));
        yield* importer.adopt({
          projectId,
          providerInstanceId: instanceId,
          nativeThreadId: "native-archived",
          archived: true,
        });
        expect(harness.requests.map((request) => request.method)).toEqual([
          "thread/read",
          "thread/items/list",
          "thread/unarchive",
        ]);
        expect(harness.commands).toHaveLength(1);
      }),
  );

  it.effect(
    "upgrades a legacy import without altering its running binding or repeating managed turns",
    () =>
      Effect.gen(function* () {
        const id = ThreadId.make("import:codex:native-upgrade");
        const existingThread: OrchestrationThreadShell = {
          id,
          projectId,
          title: "Old import",
          modelSelection: { instanceId, model: "default" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          session: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        };
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES (${`${id}:000000`},${id},'user','legacy preview',0,'2026-01-01','2026-01-01')`;
        yield* sql`INSERT INTO projection_turns (thread_id,turn_id,state,requested_at,checkpoint_files_json) VALUES (${id},'new-turn','running','2026-01-02','[]')`;
        const directory = yield* ProviderSessionDirectory;
        const binding = {
          threadId: id,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          status: "running" as const,
          runtimeMode: "full-access" as const,
          resumeCursor: { threadId: "native-upgrade" },
          runtimePayload: { cwd: "/tmp", pid: 77 },
        };
        yield* directory.upsert(binding);
        const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        const staleRuntime = Option.getOrThrow(
          yield* runtimeRepository.getByThreadId({ threadId: id }),
        );
        const harness = makeHarness({ nativeId: "native-upgrade", existingThread });
        harness.appendLiveItem();
        const importer = yield* makeCodexThreadImport.pipe(Effect.provide(harness.services));
        expect(
          yield* importer.adopt({
            projectId,
            providerInstanceId: ProviderInstanceId.make("codex-alias"),
            nativeThreadId: "native-upgrade",
          }),
        ).toEqual({ threadId: id, alreadyImported: true });
        expect(harness.commands).toEqual([]);
        expect(harness.titleRequests).toEqual([]);
        expect(Option.getOrThrow(yield* directory.getBinding(id))).toMatchObject(binding);
        const page = yield* importer.history({ threadId: id });
        expect(page.boundary?.replacesLegacyMessages).toBe(true);
        expect(page.items).toEqual([olderItem]);
        expect(
          yield* sql`SELECT text FROM projection_thread_messages WHERE thread_id = ${id}`,
        ).toEqual([{ text: "legacy preview" }]);
        // A runtime upsert may have read its payload before the metadata install.
        yield* runtimeRepository.upsert(staleRuntime);
        expect((yield* importer.history({ threadId: id })).items).toEqual([olderItem]);
      }),
  );

  it.effect("matches arbitrary T3 ids across instances sharing the native home", () =>
    Effect.gen(function* () {
      const binding = {
        threadId: ThreadId.make("normal-random-t3-id"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex-alias"),
        resumeCursor: { threadId: "native-1" },
      };
      expect(
        Option.getOrThrow(
          yield* findNativeBinding([binding], instanceId, "native-1", () =>
            Effect.succeed("shared"),
          ),
        ).threadId,
      ).toBe(binding.threadId);
      expect(
        Option.isNone(
          yield* findNativeBinding([binding], instanceId, "native-1", (id) => Effect.succeed(id)),
        ),
      ).toBe(true);
    }),
  );

  it.effect("rejects active threads and mismatched workspaces before recording a binding", () =>
    Effect.gen(function* () {
      for (const options of [{ active: true }, { cwd: "/" }]) {
        const harness = makeHarness(options);
        const importer = yield* makeCodexThreadImport.pipe(Effect.provide(harness.services));
        const result = yield* importer
          .adopt({
            projectId,
            providerInstanceId: instanceId,
            nativeThreadId: `reject-${options.active ? "active" : "cwd"}`,
          })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(CodexThreadError);
        expect(harness.commands).toEqual([]);
        expect(harness.requests.some((request) => request.method === "thread/items/list")).toBe(
          false,
        );
      }
    }),
  );
});
