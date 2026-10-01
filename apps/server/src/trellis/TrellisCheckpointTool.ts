/**
 * TrellisCheckpointTool - `trellis_checkpoint`, a turn-ending MCP tool.
 *
 * A Trellis checkpoint stops the whole workspace (every process in it, the
 * calling agent's provider included), snapshots it and restarts it. A
 * provider killed mid-turn fails its run, and V2 then holds the thread's
 * queue, so the tool ends the turns itself first: it interrupts the caller's
 * run and, with `interrupt`, the runs of the caller's own workers (decision
 * 4: an agent may end only the threads below it). Any other thread mid-turn
 * in the workspace refuses the call by name. Then, in the background:
 *
 * 1. queue each ended thread's continuation first in its queue, as a
 *    placeholder for the outcome, so ending a delegated worker's turn does
 *    not finalize its task; then interrupt, holding the queues (a queue the
 *    user paused stays paused, and gets its continuation afterwards);
 * 2. wait until those turns ended, and make Trellis's open turns T3's;
 * 3. holding T3's turn admission in the workspace, `POST /v1/checkpoint
 *    {target, name, thread}`, and if the workspace stopped release its
 *    provider sessions (their processes are gone), so a turn admitted as
 *    the checkpoint ends opens fresh ones;
 * 4. write the outcome into the continuations and resume the queues.
 *
 * Trellis's `interrupt` is never passed: T3 has ended the workers' turns
 * itself, so Trellis's own conflict check keeps refusing any other thread
 * that started a turn since the call was validated.
 *
 * The work runs detached from the MCP request, which the caller's interrupt
 * ends. Follows `t3_worktree_handoff` (WorktreeMcpService).
 *
 * @module trellis/TrellisCheckpointTool
 */
import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type RunId,
  ThreadId,
  TrellisCheckpointMcpFailure,
  type TrellisCheckpointMcpInput,
  type TrellisCheckpointMcpResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { queuedRunsInDeliveryOrder } from "../orchestration-v2/QueuedRunOrder.ts";
import { Trellis, type TrellisCheckpointOutcome, trellisRootOf } from "./Trellis.ts";
import { releaseSessionsWithin, TrellisRestoreGate } from "./TrellisRestore.ts";
import { TrellisTurns } from "./TrellisTurns.ts";

export class TrellisCheckpointTool extends Context.Service<
  TrellisCheckpointTool,
  {
    /**
     * Validates the call, ends the calling turn (and workers' turns with
     * `interrupt`) and starts the checkpoint; the result arrives as the
     * thread's next message.
     */
    readonly checkpoint: (
      scope: McpInvocationScope,
      input: TrellisCheckpointMcpInput,
    ) => Effect.Effect<TrellisCheckpointMcpResult, TrellisCheckpointMcpFailure>;
    /** Waits until no checkpoint started by this tool is still running (tests). */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/trellis/TrellisCheckpointTool") {}

/** How long a turn may take to end after its interrupt before the checkpoint proceeds. */
const TURN_END_TIMEOUT = "60 seconds";

const failure = (code: TrellisCheckpointMcpFailure["code"], message: string) =>
  new TrellisCheckpointMcpFailure({ code, message });

const quoted = (titles: ReadonlyArray<string>) => titles.map((title) => `"${title}"`).join(", ");

/** The threads below `ancestor` (its delegated workers, and theirs). */
function workersOf(
  ancestor: ThreadId,
  threads: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "id" | "lineage">>,
): ReadonlySet<ThreadId> {
  const workers = new Set<ThreadId>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const thread of threads) {
      const parent = thread.lineage.parentThreadId;
      if (
        thread.lineage.relationshipToParent === "subagent" &&
        parent !== null &&
        (parent === ancestor || workers.has(parent)) &&
        !workers.has(thread.id)
      ) {
        workers.add(thread.id);
        grew = true;
      }
    }
  }
  return workers;
}

/**
 * Provider processes and the MCP servers they start: T3 restarts those by
 * itself, so the agent is not told to.
 */
const PROVIDER_PROCESS = /--output-format stream-json|\bapp-server\b|\bmcp\b|-mcp\b|\/mcp\//;
const MAX_LISTED = 8;
const MAX_COMMAND = 160;

/** A stopped command as the agent sees it: credentials redacted, long ones cut. */
function shownCommand(cmd: string): string {
  const redacted = cmd
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/giu, "$1 [REDACTED]")
    .replace(/((?:token|secret|password|api[_-]?key)=)[^\s"',;]+/giu, "$1[REDACTED]");
  return redacted.length > MAX_COMMAND ? `${redacted.slice(0, MAX_COMMAND)}…` : redacted;
}

/** The message continuing the calling thread with the checkpoint's outcome. */
function callerContinuation(
  outcome: TrellisCheckpointOutcome,
  input: {
    readonly name: string | undefined;
    readonly workers: ReadonlyArray<string>;
    /** Thread titles by id, to name the threads in a refusal. */
    readonly titles: ReadonlyMap<string, string>;
  },
): string {
  const workers =
    input.workers.length === 0
      ? ""
      : ` The turns of ${quoted(input.workers)} were ended too; they continue on their own.`;
  if (!outcome.ok) {
    let reason = outcome.error;
    for (const [id, title] of input.titles) reason = reason.replaceAll(id, `"${title}"`);
    const restarted = outcome.restarted
      ? " The workspace was stopped and restarted anyway, ending the processes that ran in it."
      : " Nothing was stopped.";
    return `[trellis_checkpoint] The checkpoint failed: ${reason}.${restarted}${workers} Continue the task; call trellis_checkpoint again if you still need a checkpoint.`;
  }
  const result = outcome.result;
  const snapshot = result.snapshot?.id ?? "unknown";
  const commands = result.stopped
    .map((proc) => proc.cmd)
    .filter((cmd) => !PROVIDER_PROCESS.test(cmd))
    .map(shownCommand);
  const listed = commands
    .slice(0, MAX_LISTED)
    .map((cmd) => `\`${cmd}\``)
    .join(", ");
  const more = commands.length > MAX_LISTED ? ` and ${commands.length - MAX_LISTED} more` : "";
  const stopped =
    commands.length === 0
      ? "Nothing else was running in it."
      : `These processes were stopped; restart any you still need: ${listed}${more}.`;
  return `[trellis_checkpoint] Checkpoint ${snapshot}${input.name === undefined ? "" : ` ("${input.name}")`} taken. The workspace was stopped and restarted. ${stopped}${workers} Continue the task.`;
}

/** Stands in for a continuation until the checkpoint's outcome replaces it. */
const PENDING_CONTINUATION =
  "[trellis_checkpoint] A checkpoint of this workspace is under way; its result replaces this message.";

/** The message continuing a worker whose turn the checkpoint ended. */
function workerContinuation(lead: string, outcome: TrellisCheckpointOutcome): string {
  const stopped = outcome.ok || outcome.restarted;
  return stopped
    ? `[trellis_checkpoint] Your turn was ended because "${lead}" took a checkpoint of this workspace, which stopped and restarted it; processes you had running have ended. Continue where you left off.`
    : `[trellis_checkpoint] Your turn was ended because "${lead}" was taking a checkpoint of this workspace, which did not happen; nothing was stopped. Continue where you left off.`;
}

const make = Effect.gen(function* () {
  const trellisOption = yield* Effect.serviceOption(Trellis);
  const turnsOption = yield* Effect.serviceOption(TrellisTurns);
  const gateOption = yield* Effect.serviceOption(TrellisRestoreGate);
  const threads = yield* ThreadManagementService;
  const projects = yield* ProjectStoreV2;
  const sessions = yield* ProviderSessionManagerV2;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;
  // Workspaces with a checkpoint under way, and the checkpoints themselves.
  const inFlight = new Map<string, Deferred.Deferred<void>>();

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const commandId = (operation: string) =>
    Effect.map(uuid, (id) => CommandId.make(`command:mcp:trellis-checkpoint:${operation}:${id}`));

  const checkpoint: TrellisCheckpointTool["Service"]["checkpoint"] = Effect.fn(
    "TrellisCheckpointTool.checkpoint",
  )(function* (callScope, input) {
    if (!callScope.capabilities.has("orchestration")) {
      return yield* failure("capability_denied", "This credential cannot control threads.");
    }
    if (Option.isNone(trellisOption) || Option.isNone(turnsOption) || Option.isNone(gateOption)) {
      return yield* failure("not_a_trellis_workspace", "Trellis is not available on this server.");
    }
    const trellis = trellisOption.value;
    const turns = turnsOption.value;
    const gate = gateOption.value;
    const unavailable = (error: { readonly message: string }) =>
      failure("trellis_unavailable", `Trellis could not be asked: ${error.message}`);
    const failed = (error: { readonly message: string }) =>
      failure("operation_failed", error.message);

    const shell = yield* threads
      .getShellSnapshot({ location: "active" })
      .pipe(Effect.mapError(failed));
    const caller = shell.threads.find((thread) => thread.id === callScope.threadId);
    if (caller === undefined || caller.deletedAt !== null) {
      return yield* failure("thread_not_found", "The calling thread was not found.");
    }
    const roots = new Map<ProjectId, string | undefined>();
    const folderOf = (thread: OrchestrationV2ThreadShell) =>
      Effect.gen(function* () {
        if (!roots.has(thread.projectId)) {
          const project = yield* projects.get(thread.projectId).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.orElseSucceed(() => undefined),
          );
          roots.set(thread.projectId, project?.workspaceRoot);
        }
        const folder = thread.worktreePath ?? roots.get(thread.projectId);
        return folder === undefined ? undefined : yield* trellis.canonicalPath(folder);
      });

    const cwd = yield* folderOf(caller);
    if (cwd === undefined || trellisRootOf(yield* trellis.expectedRoots, cwd) === null) {
      return yield* failure(
        "not_a_trellis_workspace",
        "This thread does not work in a Trellis project, so there is nothing to checkpoint.",
      );
    }
    const resolved = yield* trellis.resolve(cwd).pipe(Effect.mapError(unavailable));
    if (resolved.workspace.kind !== "dedicated") {
      return yield* failure(
        "not_a_trellis_workspace",
        "This thread works in an idea, which shares the scratch workspace and takes no checkpoints. Graduate the idea into its own project first.",
      );
    }
    const workspace = resolved.workspace.id;
    const directory = yield* trellis.canonicalPath(resolved.workspace.path);
    if (inFlight.has(workspace)) {
      return yield* failure(
        "checkpoint_in_progress",
        "A checkpoint of this workspace is already under way.",
      );
    }
    // Reserved in the same step as the check; released here unless the checkpoint started.
    const done = Deferred.makeUnsafe<void>();
    inFlight.set(workspace, done);
    let launched = false;
    const unreserve = Effect.sync(() => {
      if (launched) return;
      inFlight.delete(workspace);
      Deferred.doneUnsafe(done, Exit.void);
    });
    return yield* Effect.gen(function* () {
      // Other threads mid-turn here, as T3 and Trellis each see them.
      const within = (path: string | undefined) =>
        path !== undefined && (path === directory || path.startsWith(`${directory}/`));
      const titles = new Map(shell.threads.map((thread) => [thread.id, thread.title]));
      const running = new Map<ThreadId, RunId | null>();
      for (const thread of shell.threads) {
        if (thread.id === caller.id || thread.activeRunId === null) continue;
        if (within(yield* folderOf(thread))) running.set(thread.id, thread.activeRunId);
      }
      for (const turn of yield* trellis.listTurns(cwd).pipe(Effect.mapError(unavailable))) {
        const thread = ThreadId.make(turn.thread);
        if (thread !== caller.id && !running.has(thread)) running.set(thread, null);
      }
      const workers = workersOf(caller.id, shell.threads);
      const nameOf = (thread: ThreadId) => titles.get(thread) ?? thread;
      const others = [...running.keys()];
      const notWorkers = others.filter((thread) => !workers.has(thread));
      if (notWorkers.length > 0 || (others.length > 0 && input.interrupt !== true)) {
        const one = others.length === 1;
        const reason =
          notWorkers.length > 0
            ? `${quoted(notWorkers.map(nameOf))} ${notWorkers.length === 1 ? "is not a worker" : "are not workers"} of this thread, so the checkpoint cannot end ${notWorkers.length === 1 ? "its turn" : "their turns"}. Wait until ${one ? "it finishes" : "they finish"} or ask the user, then call trellis_checkpoint again.`
            : `${one ? "It is your worker" : "They are your workers"}: pass interrupt: true to end ${one ? "its turn" : "their turns"} too; ${one ? "it continues" : "they continue"} after the restart.`;
        return yield* failure(
          "threads_running",
          `${quoted(others.map(nameOf))} ${one ? "is" : "are"} mid-turn in this workspace, and a checkpoint stops everything in it. ${reason}`,
        );
      }

      // Workers with a turn T3 runs; a stale Trellis row goes with the resynchronization.
      const interrupted = others.filter((thread) => running.get(thread) != null);
      const ending = [
        ...(caller.activeRunId === null
          ? []
          : [{ threadId: caller.id, runId: caller.activeRunId }]),
        ...interrupted.flatMap((threadId) => {
          const runId = running.get(threadId);
          return runId == null ? [] : [{ threadId, runId }];
        }),
      ];
      const dispatched = yield* Deferred.make<void>();

      const failedQuietly =
        (what: string, threadId: ThreadId) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logWarning(`trellis_checkpoint could not ${what}`, { threadId, cause }),
            ),
          );
      const send = (threadId: ThreadId, projectId: ProjectId, text: string) =>
        Effect.gen(function* () {
          const id = yield* uuid;
          return yield* threads.sendToThread({
            projectId,
            commandId: CommandId.make(`command:mcp:trellis-checkpoint:continuation:${id}`),
            threadId,
            messageId: MessageId.make(`message:mcp:trellis-checkpoint:continuation:${id}`),
            text,
            attachments: [],
            mode: "queue",
            createdBy: "agent",
            creationSource: "mcp",
          });
        });
      const projectOf = (threadId: ThreadId) =>
        shell.threads.find((thread) => thread.id === threadId)?.projectId ?? caller.projectId;

      /**
       * Queues `threadId`'s continuation behind its running turn, first in its
       * queue. A delegated worker with a queued message stays working, so the
       * interrupt does not finalize its task and its later result still reaches
       * its lead.
       */
      const queueContinuation = (threadId: ThreadId, text: string) =>
        Effect.gen(function* () {
          const sent = yield* send(threadId, projectOf(threadId), text);
          if (sent.delivery !== "queued") return undefined;
          const records = yield* threads.getThreadRecords(threadId, ["runs", "messages"]);
          const first = queuedRunsInDeliveryOrder(records)[0];
          if (first !== undefined && first.id !== sent.run.id) {
            yield* threads.dispatch({
              type: "queued-run.reorder",
              commandId: yield* commandId("reorder"),
              threadId,
              runId: sent.run.id,
              beforeRunId: first.id,
            });
          }
          return sent.run.id;
        });

      const interruptRun = ({ threadId, runId }: { threadId: ThreadId; runId: RunId }) =>
        Effect.gen(function* () {
          yield* threads.dispatch({
            type: "run.interrupt",
            commandId: yield* commandId("interrupt"),
            threadId,
            runId,
            reason: "A Trellis checkpoint stops the workspace.",
            // The continuation (and anything queued) waits for the checkpoint.
            holdQueue: true,
          });
        });

      const resumeQueue = (threadId: ThreadId) =>
        Effect.gen(function* () {
          const records = yield* threads.getThreadRecords(threadId, ["runs"]);
          if (records.runs.some((run) => run.status === "queued" && run.queueHeld === true)) {
            yield* threads.dispatch({
              type: "queue.resume",
              commandId: yield* commandId("resume"),
              threadId,
            });
          }
        });

      const awaitEnded = turns
        .awaitEnded(ending.map((entry) => entry.runId))
        .pipe(Effect.timeoutOption(TURN_END_TIMEOUT), Effect.asVoid);

      const run = Effect.gen(function* () {
        // A queue the user paused stays paused: such a thread gets its
        // continuation after the checkpoint (an idle thread starts it at
        // once), and its held messages keep a delegated task open meanwhile.
        const paused = new Set<ThreadId>();
        for (const { threadId } of ending) {
          const records = yield* threads
            .getThreadRecords(threadId, ["runs"])
            .pipe(Effect.orElseSucceed(() => ({ runs: [] })));
          if (records.runs.some((run) => run.status === "queued" && run.queueHeld === true)) {
            paused.add(threadId);
          }
        }
        // Continuations first, so ending the turns finalizes nothing.
        const pending = new Map<ThreadId, RunId | undefined>();
        for (const { threadId } of ending) {
          if (paused.has(threadId)) continue;
          pending.set(
            threadId,
            yield* queueContinuation(threadId, PENDING_CONTINUATION).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("trellis_checkpoint could not queue a continuation", {
                  threadId,
                  cause,
                }).pipe(Effect.as(undefined)),
              ),
            ),
          );
        }
        for (const entry of ending) {
          yield* interruptRun(entry).pipe(failedQuietly("interrupt a run", entry.threadId));
        }
        yield* Deferred.succeed(dispatched, undefined);
        // Trellis must see those turns ended, or it refuses them; stale ones go too.
        yield* awaitEnded;
        yield* turns.reconcile;
        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            // Turns admitted as the checkpoint ends wait until the sessions are released.
            yield* gate.hold([directory]);
            const seen = gate.releases(directory);
            const outcome: TrellisCheckpointOutcome = yield* trellis
              .checkpoint({
                target: directory,
                name: input.name,
                thread: caller.id,
                interrupt: false,
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.succeed({ ok: false as const, error: error.message, restarted: false }),
                ),
              );
            // Only a workspace that stopped lost its processes; a refusal keeps them.
            if (outcome.ok ? outcome.result.restarted : outcome.restarted) {
              yield* gate.releaseOnce(
                directory,
                seen,
                releaseSessionsWithin(
                  sessions,
                  directory,
                  "The workspace restarted for a Trellis checkpoint.",
                ),
              );
            }
            return outcome;
          }),
        );
        // A run whose interrupt did not land died with the stop; it settles shortly.
        yield* awaitEnded;
        const callerText = callerContinuation(outcome, {
          name: input.name,
          workers: interrupted.map(nameOf),
          titles,
        });
        for (const threadId of new Set([caller.id, ...interrupted])) {
          const text =
            threadId === caller.id ? callerText : workerContinuation(caller.title, outcome);
          const placeholder = pending.get(threadId);
          if (placeholder === undefined) {
            yield* send(threadId, projectOf(threadId), text).pipe(
              failedQuietly("continue the thread", threadId),
            );
            continue;
          }
          yield* Effect.gen(function* () {
            yield* threads.dispatch({
              type: "queued-run.edit",
              commandId: yield* commandId("result"),
              threadId,
              runId: placeholder,
              text,
            });
          }).pipe(failedQuietly("write the outcome into the continuation", threadId));
          // Everything held here was queued (unpaused) before the interrupt held it.
          yield* resumeQueue(threadId).pipe(failedQuietly("resume the queue", threadId));
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => inFlight.delete(workspace)).pipe(
            Effect.andThen(Deferred.succeed(done, undefined)),
            Effect.andThen(Deferred.succeed(dispatched, undefined)),
          ),
        ),
      );
      // Detached: the caller's interrupt ends the MCP request that started it.
      yield* Effect.uninterruptible(
        Effect.forkIn(run, scope).pipe(Effect.andThen(Effect.sync(() => (launched = true)))),
      );
      yield* Deferred.await(dispatched);

      return {
        status: "started",
        interrupting: interrupted.map(nameOf),
        note: "The checkpoint is under way and this turn is being ended; stop here. Its result arrives as your next message, after the workspace restarted.",
      } satisfies TrellisCheckpointMcpResult;
    }).pipe(Effect.onExit(() => unreserve));
  });

  const drain = Effect.suspend(() =>
    Effect.forEach([...inFlight.values()], Deferred.await, { discard: true }),
  );

  return TrellisCheckpointTool.of({ checkpoint, drain });
});

export const layer = Layer.effect(TrellisCheckpointTool, make);
