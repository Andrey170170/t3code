import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ThreadId,
  TrellisError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  ProjectionStoreThreadNotFoundError,
  ProjectionStoreV2,
} from "../orchestration-v2/ProjectionStore.ts";
import { TurnAdmission } from "../orchestration-v2/TurnAdmission.ts";
import { makeTestTrellis, Trellis, type TrellisProjectView } from "./Trellis.ts";
import { TrellisCatalog } from "./TrellisCatalog.ts";
import * as TrellisGraduation from "./TrellisGraduation.ts";
import {
  createThread,
  modelSelection,
  projectEvent,
  sendMessage,
  TrellisOrchestratorTestLayer,
  writeEvent,
} from "./TrellisOrchestrator.testkit.ts";
import * as TrellisRestore from "./TrellisRestore.ts";
import * as TrellisTurns from "./TrellisTurns.ts";

const IDEA = "/trellis/workspaces/ws-s/project/idea-1";
const PROJECT = "/trellis/workspaces/ws-new/project";

const view = (overrides: Partial<TrellisProjectView>): TrellisProjectView => ({
  id: "idea-1",
  kind: "idea",
  name: "Sketch",
  description: "",
  workspace_id: "ws-s",
  path: IDEA,
  updated_at: 0,
  deleted_at: null,
  graduated_to: null,
  workspaces: [],
  ...overrides,
});

/**
 * A Trellis with one idea at `IDEA` in the scratch workspace that keeps the
 * open turns T3 reports, refuses a graduation while another thread has one
 * open (as Trellis does), and graduates into "Demo" at `PROJECT`.
 */
function makeGraduationTrellis(options: { readonly refuse?: string } = {}) {
  const open = new Map<string, string>();
  const graduations: Array<{ base?: string | undefined; thread?: string | undefined }> = [];
  // Session releases and graduations, in order.
  const log: Array<string> = [];
  const project = view({ id: "prj-1", kind: "project", name: "Demo", path: PROJECT });
  const trellis = makeTestTrellis({
    env: { root: "/trellis", bin: "trellis", shimDir: "/t3/trellis-shims" },
    resolve: (target) =>
      Effect.succeed({
        workspace: target.startsWith(IDEA)
          ? { id: "ws-s", kind: "scratch", path: "/trellis/workspaces/ws-s/project" }
          : { id: "ws-new", kind: "dedicated", path: PROJECT },
        project: target.startsWith(IDEA) ? view({}) : project,
      } as never),
    reportTurn: ({ thread, turn, event }) =>
      Effect.sync(() => {
        if (event === "start") open.set(turn, thread);
        else open.delete(turn);
        return { restarted: [] };
      }),
    listTurns: () =>
      Effect.sync(() =>
        [...open].map(([turn, thread]) => ({ workspace: "ws-s", project: "idea-1", thread, turn })),
      ),
    graduate: ({ base, thread }) =>
      Effect.sync(() => {
        graduations.push({ base, thread });
        log.push("graduate");
        if (options.refuse !== undefined) {
          return { ok: false as const, error: options.refuse, turns: [] };
        }
        const others = [...open].filter(([, owner]) => owner !== thread);
        if (others.length > 0) {
          return {
            ok: false as const,
            error: `other threads are mid-turn in this idea: ${others.map(([, owner]) => owner).join(", ")}`,
            turns: others.map(([turn, owner]) => ({ thread: owner, turn })),
          };
        }
        return { ok: true as const, project };
      }),
  });
  return { trellis, graduations, open, log };
}

const NEW_PROJECT = ProjectId.make("project-demo");

function graduationLayer(fake: ReturnType<typeof makeGraduationTrellis>) {
  return TrellisGraduation.layer.pipe(
    Layer.provide(
      Layer.mock(ProviderSessionManagerV2)({
        release: ({ providerSessionId }) =>
          Effect.sync(() => void fake.log.push(`release ${providerSessionId}`)),
      }),
    ),
    // The catalog makes the new project's T3 project.
    Layer.provide(
      Layer.unwrap(
        Effect.map(Effect.context<ProjectStore.ProjectStoreV2>(), (context) =>
          Layer.mock(TrellisCatalog)({
            projectFor: (item) =>
              projectEvent("project.created", NEW_PROJECT, item.path).pipe(
                Effect.as({ projectId: NEW_PROJECT, workspaceRoot: item.path, name: item.name }),
                Effect.provide(context),
                Effect.orDie,
              ),
          }),
        ),
      ),
    ),
    Layer.provideMerge(TrellisOrchestratorTestLayer),
    Layer.provideMerge(TrellisTurns.layer),
    Layer.provideMerge(TrellisRestore.gateLayer),
    Layer.provide(Layer.succeed(Trellis, fake.trellis)),
    Layer.provide(NodeCrypto.layer),
  );
}

const scopeOf = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-test"),
  threadId,
  providerSessionId: ProviderSessionId.make("session-test"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const projectionOf = (threadId: ThreadId) =>
  Effect.flatMap(OrchestratorV2, (orchestrator) => orchestrator.getThreadProjection(threadId));

/** Another thread in the same idea project. */
const createThreadIn = (name: string, projectId: ProjectId) =>
  Effect.flatMap(OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${name}:create`),
      threadId: ThreadId.make(name),
      projectId,
      title: name,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    }),
  ).pipe(Effect.as(ThreadId.make(name)));

/** A turn going in the idea, admitted and reported to Trellis. */
const startTurn = (threadId: ThreadId, label: string) =>
  Effect.gen(function* () {
    yield* sendMessage(threadId, label);
    const run = (yield* projectionOf(threadId)).runs.at(-1)!;
    yield* (yield* TrellisTurns.TrellisTurns).start({ threadId, runId: run.id, cwd: IDEA });
    return run;
  });

/** What the provider does when its turn is interrupted. */
const settleInterrupted = (run: OrchestrationV2Run) =>
  Effect.gen(function* () {
    const current = (yield* projectionOf(run.threadId)).runs.find((r) => r.id === run.id)!;
    if (current.status === "interrupted") return;
    yield* writeEvent({
      id: `interrupted:${run.id}` as never,
      type: "run.updated",
      threadId: run.threadId,
      runId: run.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: run.requestedAt,
      payload: { ...run, status: "interrupted", completedAt: run.requestedAt },
    });
  });

/** What the provider does when its turn completes. */
const settleCompleted = (run: OrchestrationV2Run) =>
  writeEvent({
    id: `completed:${run.id}` as never,
    type: "run.updated",
    threadId: run.threadId,
    runId: run.id,
    providerInstanceId: run.providerInstanceId,
    occurredAt: run.requestedAt,
    payload: { ...run, status: "completed", completedAt: run.requestedAt },
  });

const continuationOf = (threadId: ThreadId) =>
  Effect.map(
    projectionOf(threadId),
    (projection) =>
      projection.messages.findLast(
        (message) => message.role === "user" && message.text.startsWith("[trellis_"),
      )?.text ?? "",
  );

it.effect("a tool call graduates the idea and continues each thread in the project", () => {
  const fake = makeGraduationTrellis();
  return Effect.gen(function* () {
    const graduation = yield* TrellisGraduation.TrellisGraduation;
    const lead = yield* createThread("lead", IDEA);
    const idle = yield* createThreadIn("idle", lead.projectId);
    const run = yield* startTurn(lead.threadId, "work");

    const result = yield* graduation.graduateFromTool(scopeOf(lead.threadId), { base: "dev" });
    assert.equal(result.status, "started");
    // Nothing graduates until the caller's turn has ended.
    assert.deepEqual(fake.graduations, []);
    yield* settleInterrupted(run);
    yield* graduation.drain;

    assert.deepEqual(fake.graduations, [{ base: "dev", thread: lead.threadId }]);
    const leadProjection = yield* projectionOf(lead.threadId);
    // The same thread, now in the project, in a new workspace assignment.
    assert.equal(leadProjection.thread.projectId, NEW_PROJECT);
    assert.equal(leadProjection.thread.workspaceAssignment, 1);
    assert.equal((yield* projectionOf(idle)).thread.projectId, NEW_PROJECT);
    const leadText = yield* continuationOf(lead.threadId);
    assert.include(leadText, 'graduated into the project "Demo"');
    assert.include(leadText, `now works in ${PROJECT}`);
    assert.include(leadText, "trellis changes --graduation");
    // An idle thread only moves: no message, no turn.
    const idleProjection = yield* projectionOf(idle);
    assert.deepEqual(idleProjection.messages, []);
    assert.deepEqual(idleProjection.runs, []);
    // The moved thread with history shows the move without a turn.
    assert.isTrue(
      leadProjection.turnItems.some(
        (item) => item.type === "system_notice" && item.message.startsWith("Moved to the project"),
      ),
    );
    // The caller's continuation runs next, in the project.
    assert.deepEqual(
      leadProjection.runs.map((candidate) => candidate.status),
      ["interrupted", "starting"],
    );
  }).pipe(Effect.provide(graduationLayer(fake)));
});

it.effect("refuses while a thread that is not the caller's worker is mid-turn, by name", () => {
  const fake = makeGraduationTrellis();
  return Effect.gen(function* () {
    const graduation = yield* TrellisGraduation.TrellisGraduation;
    const lead = yield* createThread("lead", IDEA);
    const other = yield* createThreadIn("other", lead.projectId);
    yield* startTurn(lead.threadId, "work");
    yield* startTurn(other, "other work");
    for (const interrupt of [false, true]) {
      const refusal = yield* graduation
        .graduateFromTool(scopeOf(lead.threadId), { interrupt })
        .pipe(Effect.flip);
      assert.equal(refusal.code, "threads_running");
      assert.include(refusal.message, '"other" is mid-turn in this idea');
      assert.include(refusal.message, "is not a worker of this thread");
    }
    assert.deepEqual(fake.graduations, []);
    assert.equal((yield* projectionOf(lead.threadId)).runs.at(-1)!.status, "starting");
  }).pipe(Effect.provide(graduationLayer(fake)));
});

it.effect("with interrupt, ends the caller's worker, and both continue in the project", () => {
  const fake = makeGraduationTrellis();
  return Effect.gen(function* () {
    const graduation = yield* TrellisGraduation.TrellisGraduation;
    const orchestrator = yield* OrchestratorV2;
    const lead = yield* createThread("lead", IDEA);
    const leadRun = yield* startTurn(lead.threadId, "work");
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "mcp",
      commandId: CommandId.make("lead:delegate"),
      parentThreadId: lead.threadId,
      parentRunId: leadRun.id,
      parentNodeId: leadRun.rootNodeId!,
      task: "Write the tests",
      title: "Tests worker",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
    });
    const shell = yield* orchestrator.getShellSnapshot({ location: "active" });
    const worker = shell.threads.find((thread) => thread.lineage.parentThreadId === lead.threadId)!;
    const workerRun = (yield* projectionOf(worker.id)).runs.at(-1)!;
    yield* (yield* TrellisTurns.TrellisTurns).start({
      threadId: worker.id,
      runId: workerRun.id,
      cwd: IDEA,
    });

    const refusal = yield* graduation
      .graduateFromTool(scopeOf(lead.threadId), {})
      .pipe(Effect.flip);
    assert.include(refusal.message, "pass interrupt: true");

    const result = yield* graduation.graduateFromTool(scopeOf(lead.threadId), {
      interrupt: true,
    });
    assert.deepEqual(result.interrupting, ["Tests worker"]);
    yield* settleInterrupted(leadRun);
    yield* settleInterrupted(workerRun);
    yield* graduation.drain;

    assert.equal(fake.graduations.length, 1);
    assert.equal((yield* projectionOf(worker.id)).thread.projectId, NEW_PROJECT);
    assert.include(yield* continuationOf(worker.id), 'Your turn was ended because "lead"');
    assert.include(
      yield* continuationOf(lead.threadId),
      'The turns of "Tests worker" were ended too',
    );
  }).pipe(Effect.provide(graduationLayer(fake)));
});

it.effect("a graduation Trellis refuses continues the caller where it was, with the reason", () => {
  const fake = makeGraduationTrellis({ refuse: "other threads are mid-turn in this idea: idle" });
  return Effect.gen(function* () {
    const graduation = yield* TrellisGraduation.TrellisGraduation;
    const lead = yield* createThread("lead", IDEA);
    yield* createThreadIn("idle", lead.projectId);
    const run = yield* startTurn(lead.threadId, "work");
    yield* graduation.graduateFromTool(scopeOf(lead.threadId), {});
    yield* settleInterrupted(run);
    yield* graduation.drain;
    const text = yield* continuationOf(lead.threadId);
    // Thread ids in Trellis's reason are named by their titles.
    assert.include(text, 'The graduation failed: other threads are mid-turn in this idea: "idle"');
    assert.equal((yield* projectionOf(lead.threadId)).thread.projectId, lead.projectId);
  }).pipe(Effect.provide(graduationLayer(fake)));
});

it.effect("the Graduate action moves the idea's idle threads without turns", () => {
  const fake = makeGraduationTrellis();
  return Effect.gen(function* () {
    const graduation = yield* TrellisGraduation.TrellisGraduation;
    const first = yield* createThread("first", IDEA);
    const second = yield* createThreadIn("second", first.projectId);
    const result = yield* graduation.graduate({ projectId: first.projectId, base: "dev" });
    assert.deepEqual(result, {
      projectId: NEW_PROJECT,
      workspaceRoot: PROJECT,
      name: "Demo",
      notMoved: [],
    });
    assert.deepEqual(fake.graduations, [{ base: "dev", thread: undefined }]);
    for (const threadId of [first.threadId, second]) {
      assert.equal((yield* projectionOf(threadId)).thread.projectId, NEW_PROJECT);
      // Idle threads only move: no turn is started for them.
      assert.deepEqual((yield* projectionOf(threadId)).runs, []);
    }
    // A running thread refuses the action by name instead.
    const busy = yield* createThread("busy", IDEA);
    yield* startTurn(busy.threadId, "work");
    yield* createThreadIn("busy-sibling", busy.projectId);
    const refusal = yield* graduation.graduate({ projectId: busy.projectId }).pipe(Effect.flip);
    assert.instanceOf(refusal, TrellisError);
    assert.include(refusal.message, '"busy" is mid-turn in this idea');
  }).pipe(Effect.provide(graduationLayer(fake)));
});

it.effect(
  "a turn starting in an idea that graduated elsewhere is refused, naming the project",
  () => {
    const trellis = makeTestTrellis({
      env: { root: "/trellis", bin: "trellis", shimDir: "/t3/trellis-shims" },
      reportTurn: () => Effect.succeed({ restarted: [], graduatedTo: "prj-cli" }),
      getProject: () => Effect.succeed(view({ id: "prj-cli", kind: "project", name: "Spike" })),
    });
    return Effect.gen(function* () {
      // The admission seam the server wires over V2.
      const admission = yield* Effect.gen(function* () {
        return yield* TurnAdmission;
      }).pipe(
        Effect.provide(
          Layer.fresh(TrellisRestore.layer).pipe(
            // A thread with no rollback.
            Layer.provide(
              Layer.mock(ProjectionStoreV2)({
                getThread: (threadId) =>
                  Effect.fail(new ProjectionStoreThreadNotFoundError({ threadId })),
              }),
            ),
          ),
        ),
      );
      const refusal = yield* admission
        .start({ threadId: ThreadId.make("late"), runId: RunId.make("run-late"), cwd: IDEA })
        .pipe(Effect.flip);
      assert.include(refusal.message, 'graduated into the project "Spike"');
      assert.include(refusal.message, "Send your message again");
      // Nothing was left open in Trellis for that run.
      yield* (yield* TrellisTurns.TrellisTurns).awaitEnded([RunId.make("run-late")]);
    }).pipe(
      Effect.provide(
        TrellisOrchestratorTestLayer.pipe(
          Layer.provideMerge(TrellisTurns.layer),
          Layer.provideMerge(TrellisRestore.gateLayer),
          Layer.provideMerge(Layer.succeed(Trellis, trellis)),
        ),
      ),
    );
  },
);

it.effect("refuses while a fork in the idea has not run yet, by name", () => {
  const fake = makeGraduationTrellis();
  return Effect.gen(function* () {
    const graduation = yield* TrellisGraduation.TrellisGraduation;
    const source = yield* createThread("source", IDEA);
    const fork = yield* createThreadIn("unforked", source.projectId);
    // A fork of the source, created but never sent a message.
    const thread = (yield* projectionOf(fork)).thread;
    yield* writeEvent({
      id: "unforked:forked" as never,
      type: "thread.metadata-updated",
      threadId: fork,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: thread.createdAt,
      payload: {
        ...thread,
        forkedFrom: { type: "run", threadId: source.threadId, runId: RunId.make("run-source") },
      },
    });
    const refusal = yield* graduation.graduate({ projectId: source.projectId }).pipe(Effect.flip);
    assert.include(refusal.message, '"unforked" is a fork that has not run yet');
    assert.deepEqual(fake.graduations, []);
  }).pipe(Effect.provide(graduationLayer(fake)));
});

/** Background work left by a thread's settled turn, as the provider reports it. */
const withBackgroundTask = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projection = yield* projectionOf(threadId);
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === projection.thread.activeProviderThreadId,
    )!;
    yield* writeEvent({
      id: `${threadId}:background` as never,
      type: "provider-thread.updated",
      threadId,
      driver: providerThread.driver,
      occurredAt: providerThread.updatedAt,
      payload: {
        ...providerThread,
        pendingBackgroundTasks: [
          { taskId: "bash-1", kind: "command", description: "npm run watch" },
        ],
      },
    });
  });

it.effect("an idle thread's background work refuses the graduation, by name", () => {
  const fake = makeGraduationTrellis();
  return Effect.gen(function* () {
    const graduation = yield* TrellisGraduation.TrellisGraduation;
    const first = yield* createThread("first", IDEA);
    const watcher = yield* createThreadIn("watcher", first.projectId);
    const run = yield* startTurn(watcher, "start a watcher in the background");
    yield* settleCompleted(run);
    yield* withBackgroundTask(watcher);
    const refusal = yield* graduation.graduate({ projectId: first.projectId }).pipe(Effect.flip);
    assert.include(refusal.message, '"watcher" is mid-turn in this idea');
    assert.deepEqual(fake.graduations, []);
  }).pipe(Effect.provide(graduationLayer(fake)));
});

it.effect("the caller's own session and background work stop before the copy", () => {
  const fake = makeGraduationTrellis();
  return Effect.gen(function* () {
    const graduation = yield* TrellisGraduation.TrellisGraduation;
    const lead = yield* createThread("lead", IDEA);
    const run = yield* startTurn(lead.threadId, "work");
    yield* withBackgroundTask(lead.threadId);
    // A session of its own (not shared), live in the idea.
    const now = run.requestedAt;
    yield* writeEvent({
      id: "lead:session" as never,
      type: "provider-session.attached",
      threadId: lead.threadId,
      driver: "codex" as never,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: {
        id: ProviderSessionId.make("session-lead-own"),
        driver: "codex" as never,
        providerInstanceId: modelSelection.instanceId,
        status: "ready",
        cwd: IDEA,
        model: modelSelection.model,
        capabilities: {
          ...CodexProviderCapabilitiesV2,
          sessions: {
            ...CodexProviderCapabilitiesV2.sessions,
            supportsMultipleProviderThreadsPerSession: false,
          },
        },
        createdAt: now,
        updatedAt: now,
        lastError: null,
        sessionKey: "ws-s",
      },
    });
    yield* graduation.graduateFromTool(scopeOf(lead.threadId), {});
    yield* settleInterrupted(run);
    yield* graduation.drain;
    assert.deepEqual(fake.log, ["release session-lead-own", "graduate"]);
    assert.include(
      yield* continuationOf(lead.threadId),
      "Background tasks you had running were stopped",
    );
  }).pipe(Effect.provide(graduationLayer(fake)));
});
