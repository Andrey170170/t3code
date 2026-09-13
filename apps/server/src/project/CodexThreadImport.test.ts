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
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { GitVcsDriver, layer as gitLayer } from "../vcs/GitVcsDriver.ts";
import { ServerConfig } from "../config.ts";
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
  gitLayer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "codex-import-git-" })),
    Layer.provide(NodeServices.layer),
  ),
  SqlitePersistenceMemory,
  repository,
  ProviderSessionDirectoryLive.pipe(Layer.provide(repository)),
);
// One completed native turn: prompt, a shell command, and the final answer.
const oldTurn = {
  id: "turn-old",
  status: "completed",
  startedAt: 1_700_000_000,
  completedAt: 1_700_000_060,
  items: [
    { id: "item-user", type: "userMessage", content: [{ type: "text", text: "old question" }] },
    {
      id: "item-command",
      type: "commandExecution",
      command: "ls",
      commandActions: [],
      cwd: "/tmp",
      status: "completed",
      exitCode: 0,
    },
    { id: "item-answer", type: "agentMessage", text: "old answer", phase: "final_answer" },
  ],
};
const newTurn = {
  id: "turn-new",
  status: "completed",
  startedAt: 1_700_000_100,
  completedAt: 1_700_000_160,
  items: [
    { id: "new-user", type: "userMessage", content: [{ type: "text", text: "follow-up" }] },
    { id: "new-answer", type: "agentMessage", text: "live" },
  ],
};
const historyImports = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter(
    (command): command is Extract<OrchestrationCommand, { type: "thread.history.import" }> =>
      command.type === "thread.history.import",
  );

const makeHarness = (
  options: {
    active?: boolean;
    cwd?: string;
    projectRoot?: string;
    nativeId?: string;
    nativeName?: string;
    readUpdatedAt?: number;
    archived?: boolean;
    /** Generate this many single-message turns, served in native pages of 100. */
    turnCount?: number;
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
  let newTurnAppeared = false;
  const native = makeThreadHistory({
    request: (method, params) =>
      Effect.sync(() => {
        requests.push({ method, params });
        if (method === "thread/list")
          return {
            data: options.catalog ?? [
              {
                id: options.nativeId ?? "native-1",
                cwd: options.cwd ?? "/tmp",
                modelProvider: "openai",
                preview: "My native thread",
                createdAt: 1_700_000_000,
                updatedAt: 1_700_000_001,
              },
            ],
            nextCursor: null,
          };
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
              updatedAt: options.readUpdatedAt ?? 1_700_000_001,
              status: { type: options.active ? "active" : "idle" },
            },
          };
        if (method === "thread/turns/list") {
          if (options.turnCount !== undefined) {
            const { cursor, limit } = params as { cursor?: string; limit: number };
            const offset = Number(cursor ?? 0);
            const end = Math.min(offset + limit, options.turnCount);
            return {
              data: Array.from({ length: end - offset }, (_, index) => ({
                id: `turn-${index + offset}`,
                status: "completed",
                items: [
                  {
                    id: `item-${index + offset}`,
                    type: "agentMessage",
                    text: `answer ${index + offset}`,
                  },
                ],
              })),
              nextCursor: end < options.turnCount ? String(end) : null,
            };
          }
          return { data: newTurnAppeared ? [oldTurn, newTurn] : [oldTurn], nextCursor: null };
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
            workspaceRoot: options.projectRoot ?? "/tmp",
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
    appendLiveTurn: () => {
      newTurnAppeared = true;
    },
  };
};

const makeExistingThread = (id: ThreadId, archivedAt: string | null = null) =>
  ({
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
    archivedAt,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pullRequests: [],
  }) satisfies OrchestrationThreadShell;

it.layer(testLayer)("Codex native imports", (it) => {
  it.effect("imports complete native turns as messages and activities", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const importer = yield* makeCodexThreadImport.pipe(Effect.provide(harness.services));
      const result = yield* importer.adopt({
        projectId,
        providerInstanceId: instanceId,
        nativeThreadId: "native-1",
      });
      expect(result).toEqual({
        threadId: ThreadId.make("import:codex:native-1"),
        importedTurnCount: 1,
      });
      expect(harness.commands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.history.import",
      ]);
      const history = historyImports(harness.commands)[0]!;
      // Items spread across the turn's native duration in their original order.
      expect(history.messages).toEqual([
        {
          messageId: "history:item-user",
          role: "user",
          text: "old question",
          turnId: "turn-old",
          createdAt: "2023-11-14T22:13:20.000Z",
        },
        {
          messageId: "history:item-answer",
          role: "assistant",
          text: "old answer",
          turnId: "turn-old",
          createdAt: "2023-11-14T22:14:20.000Z",
        },
      ]);
      expect(history.activities).toHaveLength(1);
      expect(history.activities?.[0]).toMatchObject({
        turnId: "turn-old",
        createdAt: "2023-11-14T22:13:50.000Z",
      });
      expect(harness.requests.filter(({ method }) => method === "thread/turns/list")).toEqual([
        {
          method: "thread/turns/list",
          params: { threadId: "native-1", itemsView: "full", sortDirection: "asc", limit: 100 },
        },
      ]);
      const directory = yield* ProviderSessionDirectory;
      expect(Option.getOrThrow(yield* directory.getBinding(result.threadId))).toMatchObject({
        resumeCursor: { threadId: "native-1" },
        runtimePayload: {
          cwd: "/tmp",
          codexHistoryImport: { lastActivityAt: "2023-11-14T22:14:20.000Z" },
        },
        status: "stopped",
      });
      // Runtime writes with stale payloads keep the import marker.
      yield* directory.upsert({
        threadId: result.threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: instanceId,
        status: "running",
        runtimePayload: { cwd: "/tmp", pid: 42 },
      });
      expect(
        Option.getOrThrow(yield* directory.getBinding(result.threadId)).runtimePayload,
      ).toMatchObject({
        pid: 42,
        codexHistoryImport: { lastActivityAt: "2023-11-14T22:14:20.000Z" },
      });
    }),
  );

  it.effect("appends only turns that are not yet projected when importing again", () =>
    Effect.gen(function* () {
      const id = ThreadId.make("import:codex:native-update");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_turns (thread_id,turn_id,state,requested_at,checkpoint_files_json) VALUES (${id},'turn-old','completed','2026-01-02','[]')`;
      const directory = yield* ProviderSessionDirectory;
      const binding = {
        threadId: id,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: instanceId,
        status: "stopped" as const,
        runtimeMode: "full-access" as const,
        resumeCursor: { threadId: "native-update" },
        runtimePayload: {
          cwd: "/tmp",
          codexHistoryImport: {
            nativeThreadId: "native-update",
            homeIdentity: "shared-home",
            importedAt: "2026-01-01T00:00:00.000Z",
            lastActivityAt: "2023-11-14T22:14:20.000Z",
          },
        },
      };
      yield* directory.upsert(binding);
      const harness = makeHarness({
        nativeId: "native-update",
        existingThread: makeExistingThread(id),
      });
      harness.appendLiveTurn();
      const importer = yield* makeCodexThreadImport.pipe(Effect.provide(harness.services));
      expect(
        yield* importer.adopt({
          projectId,
          providerInstanceId: ProviderInstanceId.make("codex-alias"),
          nativeThreadId: "native-update",
        }),
      ).toEqual({ threadId: id, importedTurnCount: 1 });
      expect(harness.commands.map((command) => command.type)).toEqual(["thread.history.import"]);
      expect(historyImports(harness.commands)[0]?.messages.map((m) => m.messageId)).toEqual([
        "history:new-user",
        "history:new-answer",
      ]);
      expect(harness.titleRequests).toEqual([]);
      expect(Option.getOrThrow(yield* directory.getBinding(id))).toMatchObject({
        ...binding,
        runtimePayload: {
          cwd: "/tmp",
          codexHistoryImport: { lastActivityAt: "2023-11-14T22:16:00.000Z" },
        },
      });
    }),
  );

  it.effect("reads every turn through bounded native pages", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ nativeId: "native-long", turnCount: 250 });
      const importer = yield* makeCodexThreadImport.pipe(Effect.provide(harness.services));
      const adopted = yield* importer.adopt({
        projectId,
        providerInstanceId: instanceId,
        nativeThreadId: "native-long",
      });
      expect(adopted.importedTurnCount).toBe(250);
      expect(
        harness.requests
          .filter(({ method }) => method === "thread/turns/list")
          .map(({ params }) => (params as { cursor?: string }).cursor),
      ).toEqual([undefined, "100", "200"]);
      expect(historyImports(harness.commands)[0]?.messages.map((m) => m.text)).toEqual(
        Array.from({ length: 250 }, (_, index) => `answer ${index}`),
      );
    }),
  );

  it.effect(
    "uses fresh list activity when native read(false) incorrectly returns creation time",
    () =>
      Effect.gen(function* () {
        const recent = "2026-09-08T17:00:00.000Z";
        const harness = makeHarness({
          nativeId: "read-lags",
          readUpdatedAt: 1_700_000_000,
          catalog: [
            {
              id: "read-lags",
              cwd: "/tmp",
              modelProvider: "openai",
              preview: "Recent update",
              createdAt: 1_700_000_000,
              updatedAt: Date.parse(recent) / 1000,
            },
          ],
        });
        const importer = yield* makeCodexThreadImport.pipe(Effect.provide(harness.services));
        const imported = yield* importer.adopt({
          providerInstanceId: instanceId,
          nativeThreadId: "read-lags",
          projectId,
        });
        const directory = yield* ProviderSessionDirectory;
        expect(
          Option.getOrThrow(yield* directory.getBinding(imported.threadId)).runtimePayload,
        ).toMatchObject({ codexHistoryImport: { lastActivityAt: recent } });
        expect(harness.requests.filter(({ method }) => method === "thread/read")).toEqual([
          { method: "thread/read", params: { threadId: "read-lags", includeTurns: false } },
        ]);
        expect(
          harness.requests.find(({ method }) => method === "thread/list")?.params,
        ).toMatchObject({ cwd: "/tmp" });
        // Without catalog metadata the imported turns still date the conversation.
        const absent = makeHarness({ nativeId: "activity-unknown", catalog: [] });
        const other = yield* makeCodexThreadImport.pipe(Effect.provide(absent.services));
        const result = yield* other.adopt({
          providerInstanceId: instanceId,
          nativeThreadId: "activity-unknown",
          projectId,
        });
        expect(
          Option.getOrThrow(yield* directory.getBinding(result.threadId)).runtimePayload,
        ).toMatchObject({
          codexHistoryImport: {
            nativeThreadId: "activity-unknown",
            lastActivityAt: "2023-11-14T22:14:20.000Z",
          },
        });
      }),
  );

  it.effect(
    "hides completed imports before project counts and pagination while retaining update and retry rows",
    () =>
      Effect.gen(function* () {
        const ids = [
          "done-0",
          "done-1",
          "done-2",
          "updated",
          "empty",
          "retry",
          ...Array.from({ length: 51 }, (_, index) => `new-${index}`),
        ];
        const catalog = ids.map((id) => ({
          id,
          cwd: "/tmp",
          modelProvider: "openai",
          preview: id,
          createdAt: 1_700_000_000,
          updatedAt: 1_700_000_100,
          threadSource: "user",
        }));
        const directory = yield* ProviderSessionDirectory;
        const sql = yield* SqlClient.SqlClient;
        for (const nativeId of ids.slice(0, 6)) {
          // Shells imported before turns were materialized have no turn rows.
          if (nativeId !== "empty")
            yield* sql`INSERT INTO projection_turns (thread_id,turn_id,state,requested_at,checkpoint_files_json) VALUES (${`bound-${nativeId}`},${`turn-${nativeId}`},'completed','2026-01-02','[]')`;
          yield* directory.upsert({
            threadId: ThreadId.make(`bound-${nativeId}`),
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: instanceId,
            status: nativeId === "retry" ? "stopped" : "running",
            resumeCursor: { threadId: nativeId },
            runtimePayload: {
              codexHistoryImport: {
                nativeThreadId: nativeId,
                importedAt: "2026-01-01T00:00:00.000Z",
                homeIdentity: "shared-home",
                lastActivityAt:
                  nativeId === "updated" ? "2023-11-14T22:13:20.000Z" : "2023-11-14T22:15:00.000Z",
              },
            },
          });
        }
        const harness = makeHarness({ catalog });
        const importer = yield* makeCodexThreadImport.pipe(Effect.provide(harness.services));
        const first = yield* importer.list({ providerInstanceId: instanceId, hideImported: true });
        expect(first.totalCount).toBe(54);
        expect(first.projects[0]).toMatchObject({ totalCount: 54, importableCount: 54 });
        expect(first.threads.some((thread) => thread.id.startsWith("done-"))).toBe(false);
        for (const id of ["updated", "empty"])
          expect(first.threads.find((thread) => thread.id === id)).toMatchObject({
            existingThreadId: `bound-${id}`,
            updateAvailable: true,
          });
        expect(first.threads.find((thread) => thread.id === "retry")?.existingThreadId).toBeNull();
        expect(first.threads).toHaveLength(50);
        const second = yield* importer.list({
          providerInstanceId: instanceId,
          hideImported: true,
          cursor: first.nextCursor!,
        });
        expect(second.threads).toHaveLength(4);
        expect(second.nextCursor).toBeNull();
        expect(
          (yield* importer
            .list({ providerInstanceId: instanceId, cursor: first.nextCursor! })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const all = yield* importer.list({ providerInstanceId: instanceId });
        expect(all.totalCount).toBe(57);
        expect(all.threads.find((thread) => thread.id === "done-0")).toMatchObject({
          existingThreadId: "bound-done-0",
          updateAvailable: false,
        });
      }),
  );

  it.effect(
    "groups unseen Git worktrees into the main project and preserves their runtime checkout",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const git = yield* GitVcsDriver;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "codex-import-worktrees-" });
        const main = path.join(root, "main");
        const linked = path.join(root, "linked");
        const detached = path.join(root, "detached");
        yield* fs.makeDirectory(main);
        const run = (args: string[]) =>
          git.execute({ operation: "CodexThreadImport.test", cwd: main, args });
        yield* run(["init"]);
        yield* run([
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "initial",
        ]);
        yield* run(["worktree", "add", "-b", "feature/work", linked]);
        yield* run(["worktree", "add", "--detach", detached]);
        const catalog = [main, linked, detached].map((cwd, index) => ({
          id: `native-worktree-${index}`,
          cwd,
          modelProvider: "openai",
          preview: "Worktree conversation",
          createdAt: 1,
          updatedAt: 2,
          threadSource: "user",
        }));
        const harness = makeHarness({
          catalog,
          cwd: linked,
          projectRoot: main,
          nativeId: "native-worktree-1",
        });
        const importer = yield* makeCodexThreadImport.pipe(Effect.provide(harness.services));
        const listed = yield* importer.list({ providerInstanceId: instanceId, projectId });
        expect(listed.totalCount).toBe(3);
        expect(listed.projects).toHaveLength(1);
        expect(listed.projects[0]).toMatchObject({ cwd: main, totalCount: 3 });
        expect(listed.threads.find((thread) => thread.cwd === linked)).toMatchObject({
          projectCwd: main,
          worktreePath: linked,
          worktreeBranch: "feature/work",
        });
        expect(listed.projects[0]?.checkouts).toHaveLength(3);
        const fromLinked = yield* importer.list({ providerInstanceId: instanceId, cwd: linked });
        expect(fromLinked.threads).toHaveLength(3);
        yield* importer.adopt({
          providerInstanceId: instanceId,
          nativeThreadId: "native-worktree-1",
          projectId,
        });
        expect(harness.commands[0]).toMatchObject({
          type: "thread.create",
          projectId,
          worktreePath: linked,
          branch: "feature/work",
        });
        const directory = yield* ProviderSessionDirectory;
        expect(
          Option.getOrThrow(
            yield* directory.getBinding(ThreadId.make("import:codex:native-worktree-1")),
          ),
        ).toMatchObject({ runtimePayload: { cwd: linked } });
        yield* fs.remove(linked, { recursive: true });
        const missing = makeHarness({
          cwd: linked,
          projectRoot: main,
          nativeId: "native-missing-worktree",
        });
        const missingImporter = yield* makeCodexThreadImport.pipe(Effect.provide(missing.services));
        expect(
          (yield* missingImporter
            .adopt({
              providerInstanceId: instanceId,
              nativeThreadId: "native-missing-worktree",
              projectId,
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(missing.commands).toHaveLength(0);
        const clone = path.join(root, "clone");
        yield* run(["clone", main, clone]);
        expect(
          (yield* missingImporter
            .adopt({
              providerInstanceId: instanceId,
              nativeThreadId: "native-missing-worktree",
              projectId,
              cwdOverride: clone,
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(missing.commands).toHaveLength(0);
        yield* missingImporter.adopt({
          providerInstanceId: instanceId,
          nativeThreadId: "native-missing-worktree",
          projectId,
          cwdOverride: detached,
        });
        expect(missing.commands[0]).toMatchObject({
          type: "thread.create",
          worktreePath: detached,
          branch: null,
        });
      }),
  );

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
      const first = yield* importer.adopt({
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
      expect(retried).toEqual({ threadId: first.threadId, importedTurnCount: 1 });
      expect(harness.commands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.history.import",
        "thread.create",
        "thread.history.import",
      ]);
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

  it.effect("restores an archived native thread only after reading its history", () =>
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
        "thread/list",
        "thread/turns/list",
        "thread/unarchive",
      ]);
      expect(harness.commands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.history.import",
      ]);
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

  it.effect("rejects active, mismatched, and archived targets before reading history", () =>
    Effect.gen(function* () {
      const archivedId = ThreadId.make("import:codex:reject-archived");
      const directory = yield* ProviderSessionDirectory;
      yield* directory.upsert({
        threadId: archivedId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: instanceId,
        status: "stopped",
        resumeCursor: { threadId: "reject-archived" },
        runtimePayload: {},
      });
      for (const [nativeThreadId, options] of [
        ["reject-active", { active: true }],
        ["reject-cwd", { cwd: "/" }],
        [
          "reject-archived",
          {
            nativeId: "reject-archived",
            existingThread: makeExistingThread(archivedId, "2026-02-01T00:00:00.000Z"),
          },
        ],
      ] as const) {
        const harness = makeHarness(options);
        const importer = yield* makeCodexThreadImport.pipe(Effect.provide(harness.services));
        const result = yield* importer
          .adopt({ projectId, providerInstanceId: instanceId, nativeThreadId })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(CodexThreadError);
        expect(harness.commands).toEqual([]);
        expect(harness.requests.some((request) => request.method === "thread/turns/list")).toBe(
          false,
        );
      }
    }),
  );
});
