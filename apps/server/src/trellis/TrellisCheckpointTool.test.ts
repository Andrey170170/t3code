import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2Run,
  ProviderInstanceId,
  ProviderSessionId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import type { TrellisCheckpointResult } from "./Trellis.ts";
import { makeTestTrellis, Trellis } from "./Trellis.ts";
import * as TrellisCheckpointTool from "./TrellisCheckpointTool.ts";
import {
  createThread,
  modelSelection,
  sendMessage,
  TrellisOrchestratorTestLayer,
  writeEvent,
} from "./TrellisOrchestrator.testkit.ts";
import * as TrellisRestore from "./TrellisRestore.ts";
import * as TrellisTurns from "./TrellisTurns.ts";

const WS = "/trellis/workspaces/ws-a/project";

/**
 * A Trellis with one dedicated workspace at `WS` that keeps the open turns
 * T3 reports (as Trellis does) and records checkpoints.
 */
function makeCheckpointTrellis(result: TrellisCheckpointResult | string) {
  const open = new Map<string, string>();
  const checkpoints: Array<{ name?: string | undefined; thread: string; interrupt: boolean }> = [];
  const trellis = makeTestTrellis({
    env: { root: "/trellis", bin: "trellis", shimDir: "/t3/trellis-shims" },
    resolve: () =>
      Effect.succeed({
        workspace: { id: "ws-a", kind: "dedicated", path: WS },
        project: null,
      } as never),
    reportTurn: ({ thread, turn, event }) =>
      Effect.sync(() => {
        if (event === "start") open.set(turn, thread);
        else open.delete(turn);
        return { restarted: [] };
      }),
    listTurns: () =>
      Effect.sync(() => [...open].map(([turn, thread]) => ({ workspace: "ws-a", thread, turn }))),
    checkpoint: ({ name, thread, interrupt }) =>
      Effect.suspend(() => {
        checkpoints.push({ name, thread, interrupt });
        return Effect.succeed(
          typeof result === "string"
            ? { ok: false as const, error: result, restarted: false, stopped: [] }
            : { ok: true as const, result },
        );
      }),
  });
  return { trellis, checkpoints, open };
}

/** Provider sessions the tool released (one live session runs in the workspace). */
const released: Array<string> = [];

function toolLayer(fake: ReturnType<typeof makeCheckpointTrellis>) {
  released.length = 0;
  return TrellisCheckpointTool.layer.pipe(
    Layer.provide(
      Layer.mock(ProviderSessionManagerV2)({
        listLive: Effect.succeed([
          { providerSessionId: ProviderSessionId.make("session-ws"), cwd: WS },
        ]),
        release: ({ providerSessionId }) =>
          Effect.sync(() => void released.push(providerSessionId)),
      }),
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

/** A thread in the workspace with a turn going, admitted and reported to Trellis. */
const startTurn = (threadId: ThreadId, label: string) =>
  Effect.gen(function* () {
    yield* sendMessage(threadId, label);
    return yield* admitLatest(threadId);
  });

const admitLatest = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const run = (yield* projectionOf(threadId)).runs.at(-1)!;
    yield* (yield* TrellisTurns.TrellisTurns).start({ threadId, runId: run.id, cwd: WS });
    return run;
  });

/** What the provider does when its turn is interrupted. */
const settleInterrupted = (run: OrchestrationV2Run) =>
  writeEvent({
    id: `interrupted:${run.id}` as never,
    type: "run.updated",
    threadId: run.threadId,
    runId: run.id,
    providerInstanceId: run.providerInstanceId,
    occurredAt: run.requestedAt,
    payload: { ...run, status: "interrupted", completedAt: run.requestedAt },
  });

const continuationOf = (threadId: ThreadId) =>
  Effect.map(projectionOf(threadId), (projection) => ({
    text:
      projection.messages
        .filter((message) => message.role === "user" && message.text.startsWith("[trellis_"))
        .at(-1)?.text ?? "",
    runs: projection.runs.map((run) => run.status),
  }));

it.effect("ends the calling turn, checkpoints, and continues the thread with the result", () => {
  const fake = makeCheckpointTrellis({
    snapshot: { id: "snap-1" },
    checkpoint: true,
    stopped: [
      { pid: 7, cmd: "/home/me/.local/bin/claude --output-format stream-json --mcp-config x" },
      { pid: 8, cmd: "node /home/me/.npm/_npx/1/node_modules/.bin/playwright-mcp" },
      { pid: 42, cmd: "npm run dev" },
      { pid: 43, cmd: "curl -H 'Authorization: Bearer s3cret' http://localhost:3000" },
      { pid: 44, cmd: '/usr/local/bin/server --password s3cret --token="s3cret"' },
    ],
    interrupted: [],
    restarted: true,
  });
  return Effect.gen(function* () {
    const tool = yield* TrellisCheckpointTool.TrellisCheckpointTool;
    const lead = yield* createThread("lead", WS);
    const run = yield* startTurn(lead.threadId, "work");

    const result = yield* tool.checkpoint(scopeOf(lead.threadId), { name: "before-refactor" });
    assert.equal(result.status, "started");
    assert.deepEqual(fake.checkpoints, []);
    // The provider honours the interrupt; only then does the workspace stop.
    if ((yield* projectionOf(lead.threadId)).runs.at(-1)!.status !== "interrupted") {
      yield* settleInterrupted(run);
    }
    yield* tool.drain;

    assert.deepEqual(fake.checkpoints, [
      { name: "before-refactor", thread: lead.threadId, interrupt: false },
    ]);
    const next = yield* continuationOf(lead.threadId);
    assert.include(next.text, "Checkpoint snap-1");
    // Executables and pids only: arguments can carry credentials.
    assert.include(next.text, "`npm (pid 42)`, `curl (pid 43)`, `server (pid 44)`");
    assert.notInclude(next.text, "s3cret");
    assert.notInclude(next.text, "claude");
    assert.notInclude(next.text, "playwright-mcp");
    assert.deepEqual(next.runs, ["interrupted", "starting"]);
    // The stop ended the workspace's providers, so their sessions were released.
    assert.deepEqual(released, ["session-ws"]);
  }).pipe(Effect.provide(toolLayer(fake)));
});

it.effect("a second checkpoint of the workspace is refused while one is under way", () => {
  const fake = makeCheckpointTrellis({
    snapshot: { id: "snap-1" },
    checkpoint: true,
    stopped: [],
    interrupted: [],
    restarted: true,
  });
  return Effect.gen(function* () {
    const tool = yield* TrellisCheckpointTool.TrellisCheckpointTool;
    const lead = yield* createThread("lead", WS);
    const run = yield* startTurn(lead.threadId, "work");
    yield* tool.checkpoint(scopeOf(lead.threadId), {});
    const refusal = yield* tool.checkpoint(scopeOf(lead.threadId), {}).pipe(Effect.flip);
    assert.equal(refusal.code, "checkpoint_in_progress");
    if ((yield* projectionOf(lead.threadId)).runs.at(-1)!.status !== "interrupted") {
      yield* settleInterrupted(run);
    }
    yield* tool.drain;
    assert.equal(fake.checkpoints.length, 1);
  }).pipe(Effect.provide(toolLayer(fake)));
});

it.effect("the continuation says what the checkpoint did, not more", () => {
  const fake = makeCheckpointTrellis({
    checkpoint: false,
    stopped: [{ pid: 42, cmd: "npm run dev" }],
    interrupted: [],
    restarted: false,
  });
  return Effect.gen(function* () {
    const tool = yield* TrellisCheckpointTool.TrellisCheckpointTool;
    const lead = yield* createThread("lead", WS);
    const run = yield* startTurn(lead.threadId, "work");
    yield* tool.checkpoint(scopeOf(lead.threadId), { name: "survivors" });
    if ((yield* projectionOf(lead.threadId)).runs.at(-1)!.status !== "interrupted") {
      yield* settleInterrupted(run);
    }
    yield* tool.drain;
    const next = yield* continuationOf(lead.threadId);
    assert.include(
      next.text,
      'No checkpoint was taken ("survivors"): processes outlived the stop.',
    );
    assert.include(next.text, "stopped and not restarted");
    assert.notInclude(next.text, "unknown");
    // It stopped all the same: the sessions there are gone.
    assert.deepEqual(released, ["session-ws"]);
  }).pipe(Effect.provide(toolLayer(fake)));
});

it.effect("a failed checkpoint still continues the thread, with the reason", () => {
  const fake = makeCheckpointTrellis(
    "checkpoint failed: guarded commands did not end in time: deploy --password hunter2 --token='hunter2'",
  );
  return Effect.gen(function* () {
    const tool = yield* TrellisCheckpointTool.TrellisCheckpointTool;
    const lead = yield* createThread("lead", WS);
    const run = yield* startTurn(lead.threadId, "work");
    yield* tool.checkpoint(scopeOf(lead.threadId), {});
    if ((yield* projectionOf(lead.threadId)).runs.at(-1)!.status !== "interrupted") {
      yield* settleInterrupted(run);
    }
    yield* tool.drain;
    const next = yield* continuationOf(lead.threadId);
    assert.include(next.text, "The checkpoint failed: checkpoint failed: guarded commands");
    assert.include(next.text, "deploy --password [REDACTED] --token=[REDACTED]");
    assert.notInclude(next.text, "hunter2");
    assert.include(next.text, "Nothing was stopped.");
    // Refused before the stop: the workspace's live sessions are kept.
    assert.deepEqual(released, []);
  }).pipe(Effect.provide(toolLayer(fake)));
});

it.effect("a queue the user paused stays paused, and the thread still continues", () => {
  const fake = makeCheckpointTrellis({
    snapshot: { id: "snap-3" },
    checkpoint: true,
    stopped: [],
    interrupted: [],
    restarted: true,
  });
  return Effect.gen(function* () {
    const tool = yield* TrellisCheckpointTool.TrellisCheckpointTool;
    const orchestrator = yield* OrchestratorV2;
    const lead = yield* createThread("lead", WS);
    const run = yield* startTurn(lead.threadId, "work");
    // A message the user queued and paused.
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("lead:later"),
      threadId: lead.threadId,
      messageId: "lead:later" as never,
      text: "later",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "queue_after_active" },
    });
    const queued = (yield* projectionOf(lead.threadId)).runs.at(-1)!;
    yield* writeEvent({
      id: "lead:pause" as never,
      type: "run.updated",
      threadId: lead.threadId,
      runId: queued.id,
      providerInstanceId: queued.providerInstanceId,
      occurredAt: queued.requestedAt,
      payload: { ...queued, queueHeld: true },
    });
    yield* tool.checkpoint(scopeOf(lead.threadId), {});
    if (
      (yield* projectionOf(lead.threadId)).runs.find((r) => r.id === run.id)!.status !==
      "interrupted"
    ) {
      yield* settleInterrupted(run);
    }
    yield* tool.drain;
    const runs = (yield* projectionOf(lead.threadId)).runs;
    assert.isTrue(runs.find((r) => r.id === queued.id)!.queueHeld === true);
    const next = yield* continuationOf(lead.threadId);
    assert.include(next.text, "Checkpoint snap-3");
    assert.equal(runs.at(-1)!.status, "starting");
  }).pipe(Effect.provide(toolLayer(fake)));
});

it.effect("a worker is told nothing stopped when the checkpoint was refused", () => {
  const fake = makeCheckpointTrellis("checkpoint failed: guarded commands did not end in time");
  return Effect.gen(function* () {
    const tool = yield* TrellisCheckpointTool.TrellisCheckpointTool;
    const orchestrator = yield* OrchestratorV2;
    const lead = yield* createThread("lead", WS);
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
    });
    const shell = yield* orchestrator.getShellSnapshot({ location: "active" });
    const worker = shell.threads.find((thread) => thread.lineage.parentThreadId === lead.threadId)!;
    const workerRun = yield* admitLatest(worker.id);
    yield* tool.checkpoint(scopeOf(lead.threadId), { interrupt: true });
    for (const [threadId, run] of [
      [lead.threadId, leadRun],
      [worker.id, workerRun],
    ] as const) {
      if (
        (yield* projectionOf(threadId)).runs.find((r) => r.id === run.id)!.status !== "interrupted"
      ) {
        yield* settleInterrupted(run);
      }
    }
    yield* tool.drain;
    assert.include(
      (yield* continuationOf(worker.id)).text,
      "which did not happen; nothing was stopped",
    );
  }).pipe(Effect.provide(toolLayer(fake)));
});

it.effect("refuses while a thread that is not a worker of the caller is mid-turn, by name", () => {
  const fake = makeCheckpointTrellis({
    checkpoint: true,
    stopped: [],
    interrupted: [],
    restarted: true,
  });
  return Effect.gen(function* () {
    const tool = yield* TrellisCheckpointTool.TrellisCheckpointTool;
    const lead = yield* createThread("lead", WS);
    const other = yield* createThread("other", WS);
    yield* startTurn(lead.threadId, "work");
    yield* startTurn(other.threadId, "other work");
    for (const interrupt of [false, true]) {
      const refusal = yield* tool
        .checkpoint(scopeOf(lead.threadId), { interrupt })
        .pipe(Effect.flip);
      assert.equal(refusal.code, "threads_running");
      assert.include(refusal.message, '"other" is mid-turn in this workspace');
      assert.include(refusal.message, "is not a worker of this thread");
    }
    // Nothing was ended or stopped.
    assert.deepEqual(fake.checkpoints, []);
    assert.equal((yield* projectionOf(lead.threadId)).runs.at(-1)!.status, "starting");
  }).pipe(Effect.provide(toolLayer(fake)));
});

it.effect("with interrupt, ends the caller's worker too and continues both", () => {
  const fake = makeCheckpointTrellis({
    snapshot: { id: "snap-2" },
    checkpoint: true,
    stopped: [],
    interrupted: ["worker"],
    restarted: true,
  });
  return Effect.gen(function* () {
    const tool = yield* TrellisCheckpointTool.TrellisCheckpointTool;
    const orchestrator = yield* OrchestratorV2;
    const lead = yield* createThread("lead", WS);
    const leadRun = yield* startTurn(lead.threadId, "work");
    // The lead delegates a task: a worker thread with its own turn here.
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
    const workerRun = yield* admitLatest(worker.id);

    const refusal = yield* tool.checkpoint(scopeOf(lead.threadId), {}).pipe(Effect.flip);
    assert.equal(refusal.code, "threads_running");
    assert.include(refusal.message, "pass interrupt: true");

    const result = yield* tool.checkpoint(scopeOf(lead.threadId), { interrupt: true });
    assert.deepEqual(result.interrupting, ["Tests worker"]);
    for (const [threadId, run] of [
      [lead.threadId, leadRun],
      [worker.id, workerRun],
    ] as const) {
      if (
        (yield* projectionOf(threadId)).runs.find((r) => r.id === run.id)!.status !== "interrupted"
      ) {
        yield* settleInterrupted(run);
      }
    }
    yield* tool.drain;

    // The workers' turns were ended by T3; Trellis is never asked to interrupt.
    assert.deepEqual(fake.checkpoints, [
      { name: undefined, thread: lead.threadId, interrupt: false },
    ]);
    assert.include(
      (yield* continuationOf(lead.threadId)).text,
      'The turns of "Tests worker" were ended too',
    );
    // The worker's task was not finalized by the interrupt: its later result still reaches the lead.
    const leadProjection = yield* projectionOf(lead.threadId);
    assert.isFalse(
      leadProjection.contextTransfers.some(
        (transfer) => transfer.type === "subagent_result" && transfer.sourceThreadId === worker.id,
      ),
    );
    const workerNext = yield* continuationOf(worker.id);
    assert.include(workerNext.text, 'Your turn was ended because "lead" took a checkpoint');
    assert.equal(workerNext.runs.at(-1), "starting");

    // The worker finishes its continued turn: its result reaches the lead.
    const continued = (yield* projectionOf(worker.id)).runs.at(-1)!;
    const eventSink = yield* EventSinkV2;
    // The orchestrator's finalization of the task, awaited as its event (the
    // stream reads from the sequence before the write, so no event is missed).
    const finalized = yield* eventSink
      .stream({
        threadId: lead.threadId,
        afterSequence: yield* eventSink.latestSequence({ threadId: lead.threadId }),
        eventType: "subagent.updated",
      })
      .pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.childThreadId === worker.id &&
            stored.event.payload.status === "completed",
        ),
        Stream.runHead,
        Effect.forkChild,
      );
    yield* writeEvent({
      id: `completed:${continued.id}` as never,
      type: "run.updated",
      threadId: worker.id,
      runId: continued.id,
      providerInstanceId: continued.providerInstanceId,
      occurredAt: continued.requestedAt,
      payload: {
        ...continued,
        status: "completed",
        startedAt: continued.requestedAt,
        completedAt: continued.requestedAt,
      },
    });
    assert.isTrue(Option.isSome(yield* Fiber.join(finalized)));
    // Its completion is owed to the lead (delivered once the lead is idle), not disposed.
    const task = (yield* projectionOf(lead.threadId)).subagents.find(
      (candidate) => candidate.childThreadId === worker.id,
    );
    assert.equal(task?.status, "completed");
    assert.oneOf(task?.completionDelivery?.state, ["pending", "claimed", "delivered"]);
  }).pipe(Effect.provide(toolLayer(fake)));
});
