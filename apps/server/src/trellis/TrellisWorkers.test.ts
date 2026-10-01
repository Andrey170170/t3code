import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2DomainEvent,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import {
  makeTestTrellis,
  Trellis,
  type TrellisProjectView,
  type TrellisWorkspaceView,
} from "./Trellis.ts";
import { TrellisCatalog, workerRoots, workspaceEntries } from "./TrellisCatalog.ts";
import {
  createProject,
  createThread,
  sendMessage,
  TrellisOrchestratorTestLayer,
  writeEvent,
} from "./TrellisOrchestrator.testkit.ts";
import * as TrellisWorkers from "./TrellisWorkers.ts";

const LEAD_WS = "ws-a";
const pathOf = (workspace: string) => `/trellis/workspaces/${workspace}/project`;

/**
 * A Trellis with one dedicated project (`prj-1`, primary workspace `ws-a`)
 * that records forks, activities, discards and purge requests.
 */
function makeForkTrellis(input: { readonly checkpoints: ReadonlyArray<string> }) {
  const state = {
    workspaces: [
      {
        id: LEAD_WS,
        kind: "dedicated",
        name: "main",
        path: pathOf(LEAD_WS),
        deleted_at: null,
        project_id: "prj-1",
        created_at: 1,
        spawned_by: null,
      },
    ] as Array<TrellisWorkspaceView>,
    forks: [] as Array<{
      snapshot: string;
      thread: string | undefined;
      name: string | undefined;
      services: unknown;
    }>,
    activities: [] as Array<{ target: string; kind: string; data: unknown }>,
    purgeRequests: [] as Array<{ ids: ReadonlyArray<string>; reason?: string; thread?: string }>,
  };
  const trellis = makeTestTrellis({
    resolve: (target) =>
      Effect.succeed({
        workspace: state.workspaces.find((workspace) => target.startsWith(workspace.path))!,
        project: {
          id: "prj-1",
          kind: "project",
          workspace_id: LEAD_WS,
        } as TrellisProjectView,
      }),
    listSnapshots: () =>
      Effect.succeed([
        { id: "snap-origin", kind: "origin" },
        ...input.checkpoints.map((id) => ({ id, kind: "checkpoint" })),
        { id: "snap-turn", kind: "turn" },
      ] as never),
    fork: ({ snapshot, thread, name, services }) =>
      Effect.sync(() => {
        state.forks.push({ snapshot, thread, name, services });
        const id = `ws-fork${state.forks.length}`;
        const view: TrellisWorkspaceView = {
          id,
          kind: "dedicated",
          name: name ?? `fork-${state.forks.length}`,
          path: pathOf(id),
          deleted_at: null,
          project_id: "prj-1",
          created_at: 1 + state.forks.length,
          spawned_by: thread === undefined ? null : { thread, workspace: LEAD_WS },
          parent_snapshot: snapshot,
        };
        state.workspaces.push(view);
        return {
          ...view,
          warnings: ["9 workspaces are running (warn_running_workspaces is 8)"],
          ...(services === undefined || services === "none"
            ? {}
            : {
                services: [
                  { name: "web", state: "starting", previews: [{ port: 3000, url: "http://p" }] },
                ],
              }),
        };
      }),
    recordActivity: (activity) => Effect.sync(() => void state.activities.push(activity)),
    listWorkspaces: () => Effect.sync(() => state.workspaces),
    listTrash: Effect.sync(() => ({
      projects: [],
      workspaces: state.workspaces
        .filter((workspace) => workspace.deleted_at !== null)
        .map((workspace) => ({
          id: workspace.id,
          kind: workspace.kind,
          name: workspace.name,
          project_id: workspace.project_id ?? null,
          deleted_at: workspace.deleted_at,
          expires_at: null,
          unmerged: true,
          unmerged_reason: "uncommitted changes",
          purge_requested: state.purgeRequests.some((request) => request.ids.includes(workspace.id))
            ? { at: 5, reason: "failed experiment", thread: "lead" }
            : null,
        })),
    })),
    requestPurge: (request) =>
      Effect.sync(
        () =>
          void state.purgeRequests.push({
            ids: request.ids,
            ...(request.reason === undefined ? {} : { reason: request.reason }),
            ...(request.thread === undefined ? {} : { thread: request.thread }),
          }),
      ),
    trashWorkspace: (id) =>
      Effect.sync(() => {
        const workspace = state.workspaces.find((candidate) => candidate.id === id)!;
        Object.assign(workspace, { deleted_at: 10 });
      }),
  });
  return { trellis, state };
}

/** A catalog whose sync gives each live workspace a T3 project, as the real sync does. */
function fakeCatalog(fake: ReturnType<typeof makeForkTrellis>) {
  return Layer.effect(
    TrellisCatalog,
    Effect.gen(function* () {
      const store = yield* ProjectStore.ProjectStoreV2;
      const ids = new Map<string, ProjectId>();
      const unused = () => Effect.die("unused catalog operation");
      const syncNow = Effect.gen(function* () {
        for (const workspace of fake.state.workspaces) {
          if (workspace.deleted_at !== null || ids.has(workspace.path)) continue;
          ids.set(workspace.path, yield* createProject(workspace.id, workspace.path));
        }
        return ids as ReadonlyMap<string, ProjectId>;
      }).pipe(Effect.provideService(ProjectStore.ProjectStoreV2, store), Effect.orDie);
      return TrellisCatalog.of({
        syncNow,
        discardFork: (id) => fake.trellis.trashWorkspace(id).pipe(Effect.as(true), Effect.orDie),
        start: unused,
        status: Effect.die("unused"),
        newIdea: unused,
        createIdeaForDraft: Effect.die("unused"),
        discardIdea: unused,
        prepareIdeaDraft: Effect.die("unused"),
        trashProject: unused,
        listTrash: Effect.die("unused"),
        restore: unused,
        emptyTrash: Effect.die("unused"),
        newProject: unused,
        find: unused,
        restoreConflicts: unused,
        checkProjectDelete: unused,
        listWorkspaces: unused,
        listCheckpoints: unused,
        forkWorkspace: unused,
        purge: unused,
      });
    }),
  );
}

const codex = ProviderInstanceId.make("codex");
const codexProvider: ServerProvider = {
  instanceId: codex,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-01T00:00:00.000Z",
  models: [{ slug: "gpt-5.4", name: "gpt-5.4", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};

function testLayer(fake: ReturnType<typeof makeForkTrellis>) {
  const workers = TrellisWorkers.layer.pipe(
    Layer.provide(fakeCatalog(fake)),
    Layer.provide(Layer.mock(OrchestrationEventStore)({})),
  );
  return OrchestratorMcpService.layer.pipe(
    Layer.provideMerge(workers),
    Layer.provide(Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codexProvider]) })),
    Layer.provide(
      Layer.succeed(
        ProviderAdapterRegistryV2,
        ProviderAdapterRegistryV2.of({
          list: () => Effect.succeed([codex]),
          get: () => Effect.succeed({ instanceId: codex } as unknown as ProviderAdapterV2Shape),
        }),
      ),
    ),
    Layer.provide(Layer.mock(ScheduledTaskService)({})),
    Layer.provideMerge(TrellisOrchestratorTestLayer),
    Layer.provide(Layer.succeed(Trellis, fake.trellis)),
    Layer.provide(NodeCrypto.layer),
  );
}

const scopeOf = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-test"),
  threadId,
  providerSessionId: ProviderSessionId.make("session-test"),
  providerInstanceId: codex,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

/** A lead in the project's primary workspace, mid-turn. */
const startLead = Effect.gen(function* () {
  const lead = yield* createThread("lead", pathOf(LEAD_WS));
  yield* sendMessage(lead.threadId, "work");
  return lead;
});

const delegate = (
  lead: ThreadId,
  workspace: NonNullable<
    Parameters<
      OrchestratorMcpService.OrchestratorMcpService["Service"]["delegateTask"]
    >[1]["workspace"]
  >,
) =>
  Effect.flatMap(OrchestratorMcpService.OrchestratorMcpService, (service) =>
    service.delegateTask(scopeOf(lead), { task: "Add the parser", title: "Parser", workspace }),
  );

const threadOf = (threadId: ThreadId) =>
  Effect.flatMap(OrchestratorV2, (orchestrator) => orchestrator.getThreadProjection(threadId));

it.effect("spawns a worker in a fork of the latest checkpoint, in the fork's own project", () => {
  const fake = makeForkTrellis({ checkpoints: ["snap-old", "snap-new"] });
  return Effect.gen(function* () {
    const lead = yield* startLead;
    const result = yield* delegate(lead.threadId, {
      fork: { from: "latest", name: "parser", services: ["web"] },
    });

    // Forked from the newest checkpoint, spawned by the lead, services passed through.
    assert.deepEqual(fake.state.forks, [
      { snapshot: "snap-new", thread: lead.threadId, name: "parser", services: ["web"] },
    ]);
    assert.equal(result.fork?.workspaceId, "ws-fork1");
    assert.equal(result.fork?.snapshot, "snap-new");
    assert.deepEqual(result.fork?.warnings, [
      "9 workspaces are running (warn_running_workspaces is 8)",
    ]);
    assert.deepEqual(result.fork?.services, [
      { name: "web", state: "starting", previews: [{ port: 3000, url: "http://p" }] },
    ]);

    // The child works in the fork's project, a worker of the lead, told where it is.
    const child = yield* threadOf(result.childThreadId);
    // The fake sync names each workspace's project `<ws>-project`.
    assert.equal(child.thread.projectId, "ws-fork1-project");
    assert.notEqual(child.thread.projectId, lead.projectId);
    assert.isNull(child.thread.worktreePath);
    assert.equal(child.thread.lineage.relationshipToParent, "subagent");
    const prompt = child.messages.find((message) => message.role === "user")?.text ?? "";
    assert.include(
      prompt,
      '[Trellis worker] You work in your own Trellis fork "parser" (ws-fork1)',
    );
    assert.include(prompt, "Add the parser");

    // Its project is a worker fork, which clients keep out of the sidebar.
    assert.deepEqual(
      workerRoots([
        {
          kind: "project",
          name: "Demo",
          path: pathOf(LEAD_WS),
          workspace_id: LEAD_WS,
          deleted_at: null,
          graduated_to: null,
          workspaces: fake.state.workspaces,
        } as unknown as TrellisProjectView,
      ]),
      [pathOf("ws-fork1")],
    );
  }).pipe(Effect.provide(testLayer(fake)));
});

it.effect(
  "a retried spawn with the same clientRequestId reports its fork and forks nothing new",
  () => {
    const fake = makeForkTrellis({ checkpoints: ["snap-1"] });
    return Effect.gen(function* () {
      const lead = yield* startLead;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const spawn = service.delegateTask(scopeOf(lead.threadId), {
        task: "Add the parser",
        clientRequestId: "spawn-parser",
        workspace: { fork: { from: "latest", name: "parser" } },
      });
      const first = yield* spawn;
      const retried = yield* spawn;
      assert.equal(fake.state.forks.length, 1);
      assert.equal(retried.childThreadId, first.childThreadId);
      assert.equal(retried.fork?.workspaceId, first.fork?.workspaceId);
      assert.equal(retried.fork?.snapshot, "snap-1");
    }).pipe(Effect.provide(testLayer(fake)));
  },
);

it.effect(
  "spawns from an earlier checkpoint by id, and refuses one that is not a checkpoint",
  () => {
    const fake = makeForkTrellis({ checkpoints: ["snap-old", "snap-new"] });
    return Effect.gen(function* () {
      const lead = yield* startLead;
      const result = yield* delegate(lead.threadId, { fork: { from: "snap-old" } });
      assert.equal(result.fork?.snapshot, "snap-old");
      assert.equal(fake.state.forks[0]?.snapshot, "snap-old");
      assert.isUndefined(fake.state.forks[0]?.services);

      const refusal = yield* delegate(lead.threadId, { fork: { from: "snap-turn" } }).pipe(
        Effect.flip,
      );
      assert.equal(refusal.code, "invalid_request");
      assert.include(refusal.message, "snap-turn is not a checkpoint of this workspace");
      assert.equal(fake.state.forks.length, 1);
    }).pipe(Effect.provide(testLayer(fake)));
  },
);

it.effect(
  "refuses a fork spawn when the workspace has no checkpoint, naming trellis_checkpoint",
  () => {
    const fake = makeForkTrellis({ checkpoints: [] });
    return Effect.gen(function* () {
      const lead = yield* startLead;
      const refusal = yield* delegate(lead.threadId, { fork: { from: "latest" } }).pipe(
        Effect.flip,
      );
      assert.equal(refusal.code, "invalid_request");
      assert.include(refusal.message, "no checkpoint yet");
      assert.include(refusal.message, "Call trellis_checkpoint first");
      // Nothing was forked and no child was created.
      assert.deepEqual(fake.state.forks, []);
      assert.deepEqual((yield* threadOf(lead.threadId)).subagents, []);
    }).pipe(Effect.provide(testLayer(fake)));
  },
);

it.effect("posts a completed worker's result as its fork's summary", () => {
  const fake = makeForkTrellis({ checkpoints: ["snap-1"] });
  return Effect.gen(function* () {
    const workers = yield* TrellisWorkers.TrellisWorkers;
    const lead = yield* startLead;
    const forked = yield* delegate(lead.threadId, { fork: { from: "latest" } });
    const inParent = yield* delegate(lead.threadId, "parent");

    const completed = (childThreadId: ThreadId, result: string) =>
      Effect.gen(function* () {
        const task = (yield* threadOf(lead.threadId)).subagents.find(
          (candidate) => candidate.childThreadId === childThreadId,
        )!;
        const now = yield* DateTime.now;
        return {
          type: "subagent.updated",
          threadId: lead.threadId,
          payload: { ...task, status: "completed", result, completedAt: now },
        } as unknown as OrchestrationV2DomainEvent;
      });
    const event = yield* completed(
      forked.childThreadId,
      "Parser on bookmark parser; installed ripgrep.",
    );
    yield* workers.handle(event);
    // A repeated event posts nothing more; a worker sharing its lead's folder posts nothing.
    yield* workers.handle(event);
    yield* workers.handle(yield* completed(inParent.childThreadId, "Read the docs."));

    assert.deepEqual(fake.state.activities, [
      {
        target: pathOf("ws-fork1"),
        kind: "summary",
        data: {
          text: "Parser on bookmark parser; installed ripgrep.",
          thread: forked.childThreadId,
        },
      },
    ]);
  }).pipe(Effect.provide(testLayer(fake)));
});

it.effect("archiving a lead cancels and archives its workers, and their forks stay", () => {
  const fake = makeForkTrellis({ checkpoints: ["snap-1"] });
  return Effect.gen(function* () {
    const workers = yield* TrellisWorkers.TrellisWorkers;
    const orchestrator = yield* OrchestratorV2;
    const lead = yield* startLead;
    const forked = yield* delegate(lead.threadId, { fork: { from: "latest" } });
    const inParent = yield* delegate(lead.threadId, "parent");
    const workerRun = (yield* threadOf(forked.childThreadId)).runs.at(-1)!;
    assert.equal(workerRun.status, "starting");

    // The lead's turn ends; its workers keep going until the lead is archived.
    const leadRun = (yield* threadOf(lead.threadId)).runs.at(-1)!;
    yield* writeEvent({
      id: `completed:${leadRun.id}` as never,
      type: "run.updated",
      threadId: lead.threadId,
      runId: leadRun.id,
      providerInstanceId: leadRun.providerInstanceId,
      occurredAt: leadRun.requestedAt,
      payload: { ...leadRun, status: "completed", completedAt: leadRun.requestedAt },
    });
    const archived = yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("lead:archive"),
      threadId: lead.threadId,
    });
    for (const stored of archived.storedEvents) yield* workers.handle(stored.event);

    for (const childThreadId of [forked.childThreadId, inParent.childThreadId]) {
      const child = yield* threadOf(childThreadId);
      assert.isNotNull(child.thread.archivedAt, `${childThreadId} archived`);
    }
    const run = (yield* threadOf(forked.childThreadId)).runs.find((r) => r.id === workerRun.id)!;
    assert.oneOf(run.status, ["interrupted", "cancelled", "interrupting"]);
    // The fork itself was not discarded.
    assert.isNull(
      fake.state.workspaces.find((workspace) => workspace.id === "ws-fork1")!.deleted_at,
    );
  }).pipe(Effect.provide(testLayer(fake)));
});

it.effect("discarding a fork is refused while its worker runs, then files a purge request", () => {
  const fake = makeForkTrellis({ checkpoints: ["snap-1"] });
  return Effect.gen(function* () {
    const workers = yield* TrellisWorkers.TrellisWorkers;
    const lead = yield* startLead;
    const forked = yield* delegate(lead.threadId, { fork: { from: "latest", name: "parser" } });

    const busy = yield* workers
      .discardFork(scopeOf(lead.threadId), { fork: "parser" })
      .pipe(Effect.flip);
    assert.equal(busy.code, "threads_running");
    assert.include(busy.message, '"Parser" is still working in parser');
    assert.isNull(
      fake.state.workspaces.find((workspace) => workspace.id === "ws-fork1")!.deleted_at,
    );

    // The worker finishes.
    const run = (yield* threadOf(forked.childThreadId)).runs.at(-1)!;
    yield* writeEvent({
      id: `completed:${run.id}` as never,
      type: "run.updated",
      threadId: forked.childThreadId,
      runId: run.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: run.requestedAt,
      payload: { ...run, status: "completed", completedAt: run.requestedAt },
    });

    const discarded = yield* workers.discardFork(scopeOf(lead.threadId), { fork: "ws-fork1" });
    assert.deepEqual(discarded, {
      workspaceId: "ws-fork1",
      name: "parser",
      discarded: true,
      unmerged: true,
      unmergedReason: "uncommitted changes",
      expiresAt: null,
      purgeRequested: false,
    });

    // Already in the trash: only the purge request is filed.
    const requested = yield* workers.discardFork(scopeOf(lead.threadId), {
      fork: "parser",
      requestPurge: true,
      reason: "failed experiment",
    });
    assert.isFalse(requested.discarded);
    assert.isTrue(requested.purgeRequested);
    assert.deepEqual(fake.state.purgeRequests, [
      { ids: ["ws-fork1"], reason: "failed experiment", thread: lead.threadId },
    ]);

    // The lead's own workspace is never discarded through the tool.
    const own = yield* workers
      .discardFork(scopeOf(lead.threadId), { fork: LEAD_WS })
      .pipe(Effect.flip);
    assert.equal(own.code, "fork_not_found");
  }).pipe(Effect.provide(testLayer(fake)));
});

it("lists a project's workspaces with workers, discarded forks and their trash state", () => {
  const workspaces: Array<TrellisWorkspaceView> = [
    {
      id: "ws-a",
      kind: "dedicated",
      name: "main",
      path: pathOf("ws-a"),
      deleted_at: null,
      project_id: "prj-1",
      created_at: 1,
      running: true,
      spawned_by: null,
    },
    {
      id: "ws-w",
      kind: "dedicated",
      name: "parser",
      path: pathOf("ws-w"),
      deleted_at: null,
      project_id: "prj-1",
      created_at: 3,
      running: false,
      spawned_by: { thread: "lead", workspace: "ws-a" },
    },
    {
      id: "ws-l",
      kind: "dedicated",
      name: "try-b",
      path: pathOf("ws-l"),
      deleted_at: null,
      project_id: "prj-1",
      created_at: 2,
      checkpointing: true,
      spawned_by: null,
    },
    {
      id: "ws-d",
      kind: "dedicated",
      name: "old",
      path: pathOf("ws-d"),
      deleted_at: 50,
      project_id: "prj-1",
      created_at: 0,
      spawned_by: { thread: "lead", workspace: "ws-a" },
    },
    {
      id: "ws-x",
      kind: "dedicated",
      name: "other",
      path: pathOf("ws-x"),
      deleted_at: null,
      project_id: "prj-2",
      created_at: 0,
      spawned_by: null,
    },
  ];
  const entries = workspaceEntries({
    trellisProjectId: "prj-1",
    primaryWorkspaceId: "ws-a",
    workspaces,
    trash: {
      projects: [],
      workspaces: [
        {
          id: "ws-d",
          kind: "dedicated",
          name: "old",
          project_id: "prj-1",
          deleted_at: 50,
          expires_at: null,
          unmerged: true,
          unmerged_reason: "commits missing from the parent",
          purge_requested: { at: 60, reason: "dead end", thread: "lead" },
        },
      ],
    },
    projectIds: new Map([[pathOf("ws-w"), "p-w" as ProjectId]]),
    titles: new Map([["lead", "Lead thread"]]),
  });
  assert.deepEqual(
    entries.map((entry) => [entry.id, entry.kind, entry.state, entry.spawnedBy?.title ?? null]),
    [
      ["ws-a", "primary", "running", null],
      ["ws-l", "fork", "checkpointing", null],
      ["ws-w", "fork", "stopped", "Lead thread"],
      ["ws-d", "fork", "discarded", "Lead thread"],
    ],
  );
  const worker = entries.find((entry) => entry.id === "ws-w")!;
  assert.equal(worker.projectId, "p-w");
  const discarded = entries.find((entry) => entry.id === "ws-d")!;
  assert.isTrue(discarded.unmerged);
  assert.equal(discarded.unmergedReason, "commits missing from the parent");
  assert.isNull(discarded.expiresAt);
  assert.deepEqual(discarded.purgeRequested, { at: 60, reason: "dead end", by: "Lead thread" });
});
