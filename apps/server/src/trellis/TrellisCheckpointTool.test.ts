import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2Run,
  ProviderInstanceId,
  ProviderSessionId,
  type ThreadId,
  TrellisError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
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
        return typeof result === "string"
          ? Effect.fail(new TrellisError({ message: result }))
          : Effect.succeed(result);
      }),
  });
  return { trellis, checkpoints, open };
}

function toolLayer(fake: ReturnType<typeof makeCheckpointTrellis>) {
  return TrellisCheckpointTool.layer.pipe(
    Layer.provideMerge(TrellisOrchestratorTestLayer),
    Layer.provideMerge(TrellisTurns.layer),
    Layer.provide(TrellisRestore.gateLayer),
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
    text: projection.messages.filter((message) => message.role === "user").at(-1)?.text ?? "",
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
    assert.include(next.text, "`npm run dev`, `curl -H 'Authorization: Bearer [REDACTED]'");
    assert.notInclude(next.text, "s3cret");
    assert.notInclude(next.text, "claude");
    assert.notInclude(next.text, "playwright-mcp");
    assert.deepEqual(next.runs, ["interrupted", "starting"]);
  }).pipe(Effect.provide(toolLayer(fake)));
});

it.effect("a failed checkpoint still continues the thread, with the reason", () => {
  const fake = makeCheckpointTrellis("checkpoint failed: guarded commands did not end in time");
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

    assert.deepEqual(fake.checkpoints, [
      { name: undefined, thread: lead.threadId, interrupt: true },
    ]);
    assert.include(
      (yield* continuationOf(lead.threadId)).text,
      'The turns of "Tests worker" were ended too',
    );
    const workerNext = yield* continuationOf(worker.id);
    assert.include(workerNext.text, 'Your turn was ended because "lead" took a checkpoint');
    assert.equal(workerNext.runs.at(-1), "starting");
  }).pipe(Effect.provide(toolLayer(fake)));
});
