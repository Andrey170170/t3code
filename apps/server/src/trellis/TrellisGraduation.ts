/**
 * TrellisGraduation - graduates a Trellis idea into a dedicated project and
 * moves its threads there: the `trellis_graduate` MCP tool, which ends the
 * calling turn, and the "Graduate" action.
 *
 * Trellis copies the idea's folder into a new workspace, so nothing may write
 * there meanwhile: the graduation is refused while another of the idea's
 * threads is mid-turn, naming it. The tool ends the caller's turn and, with
 * `interrupt`, the turns of the caller's own workers (decision 4: an agent
 * may end only the threads below it); the action ends none. Then, in the
 * background:
 *
 * 1. queue each ended thread's continuation first in its queue, as a
 *    placeholder for the outcome, and interrupt its run, holding the queue;
 * 2. wait until those turns ended, and make Trellis's open turns T3's;
 * 3. `POST /v1/projects/{idea}/graduate {base, name, thread}` (Trellis holds
 *    turn starts in the idea meanwhile and refuses them afterwards);
 * 4. create the new project's T3 project and move each of the idea's active
 *    threads there; a thread that started a turn after all is left to the
 *    catalog, which moves it once that turn has ended;
 * 5. continue each moved thread with where it now is (the placeholders get
 *    the outcome) and resume the queues.
 *
 * A graduation from the CLI (`trellis graduate`) is followed by the catalog
 * sync instead, without continuations.
 *
 * @module trellis/TrellisGraduation
 */
import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type RunId,
  ThreadId,
  type TrellisCreateResult,
  TrellisError,
  TrellisGraduateMcpFailure,
  type TrellisGraduateInput,
  type TrellisGraduateMcpInput,
  type TrellisGraduateMcpResult,
  type TrellisGraduateResult,
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
import { queuedRunsInDeliveryOrder } from "../orchestration-v2/QueuedRunOrder.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import { Trellis, trellisRootOf } from "./Trellis.ts";
import { TrellisCatalog } from "./TrellisCatalog.ts";
import { workersOf } from "./TrellisCheckpointTool.ts";
import { TrellisTurns } from "./TrellisTurns.ts";

export interface TrellisGraduationShape {
  /**
   * `trellis_graduate`: validates the call, ends the calling turn (and the
   * workers' turns with `interrupt`) and starts the graduation; the outcome
   * arrives as the thread's next message, in the new project.
   */
  readonly graduateFromTool: (
    scope: McpInvocationScope,
    input: TrellisGraduateMcpInput,
  ) => Effect.Effect<TrellisGraduateMcpResult, TrellisGraduateMcpFailure>;
  /** The "Graduate" action: graduates the idea behind a T3 project and waits for the moves. */
  readonly graduate: (
    input: TrellisGraduateInput,
  ) => Effect.Effect<TrellisGraduateResult, TrellisError>;
  /** Waits until no graduation started here is still running (tests). */
  readonly drain: Effect.Effect<void>;
}

export class TrellisGraduation extends Context.Service<TrellisGraduation, TrellisGraduationShape>()(
  "t3/trellis/TrellisGraduation",
) {}

/** How long a turn may take to end after its interrupt before the graduation proceeds. */
const TURN_END_TIMEOUT = "60 seconds";

const failure = (code: TrellisGraduateMcpFailure["code"], message: string) =>
  new TrellisGraduateMcpFailure({ code, message });

const quoted = (titles: ReadonlyArray<string>) => titles.map((title) => `"${title}"`).join(", ");

type Outcome =
  | {
      readonly ok: true;
      readonly project: TrellisCreateResult;
      /** Titles of the idea's threads left for the catalog to move. */
      readonly notMoved: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly error: string };

const ENVIRONMENT_NOTE =
  "Its files came along; packages and other changes to the environment made while it was an idea did not: `trellis changes --graduation` lists them, so reinstall what you need.";

/** The calling thread's continuation. */
function callerContinuation(outcome: Outcome, workers: ReadonlyArray<string>): string {
  const ended =
    workers.length === 0
      ? ""
      : ` The turns of ${quoted(workers)} were ended too; they continue on their own.`;
  if (!outcome.ok) {
    return `[trellis_graduate] The graduation failed: ${outcome.error}. This thread is still in the idea.${ended} Continue the task; call trellis_graduate again if you still want to graduate.`;
  }
  return `[trellis_graduate] The idea graduated into the project "${outcome.project.name}", its own Trellis workspace; this thread moved there and now works in ${outcome.project.workspaceRoot}. ${ENVIRONMENT_NOTE}${ended} Continue the task.`;
}

/** The continuation of a worker whose turn the graduation ended. */
function workerContinuation(lead: string, outcome: Outcome): string {
  return outcome.ok
    ? `[trellis_graduate] Your turn was ended because "${lead}" graduated this idea into the project "${outcome.project.name}"; this thread moved there and now works in ${outcome.project.workspaceRoot}. ${ENVIRONMENT_NOTE} Continue where you left off.`
    : `[trellis_graduate] Your turn was ended because "${lead}" was graduating this idea, which did not happen; nothing moved. Continue where you left off.`;
}

/** The note to a thread of the idea that was idle when it moved. */
function movedNote(project: TrellisCreateResult): string {
  return `[trellis_graduate] This idea graduated into the project "${project.name}", its own Trellis workspace; this thread moved there and now works in ${project.workspaceRoot}. ${ENVIRONMENT_NOTE} Nothing else is needed now; reply briefly and wait for the next message.`;
}

const STOPPED: Outcome = { ok: false, error: "the graduation stopped unexpectedly" };

/** Stands in for a continuation until the graduation's outcome replaces it. */
const PENDING_CONTINUATION =
  "[trellis_graduate] This idea is graduating into its own project; the outcome replaces this message.";

interface StartInput {
  readonly ideaProjectId: ProjectId;
  /** The thread that called the tool; null for the action. */
  readonly caller: OrchestrationV2ThreadShell | null;
  readonly shell: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly base: string | undefined;
  readonly name: string | undefined;
  readonly interrupt: boolean;
}

const make = Effect.gen(function* () {
  const trellisOption = yield* Effect.serviceOption(Trellis);
  const turnsOption = yield* Effect.serviceOption(TrellisTurns);
  const catalogOption = yield* Effect.serviceOption(TrellisCatalog);
  const threads = yield* ThreadManagementService;
  const projects = yield* ProjectStoreV2;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;
  // Ideas graduating now (by Trellis id), and the graduations themselves.
  const inFlight = new Map<string, Deferred.Deferred<Outcome>>();

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const commandId = (operation: string) =>
    Effect.map(uuid, (id) => CommandId.make(`command:trellis-graduate:${operation}:${id}`));

  /**
   * Validates a graduation and starts it: returns once the turns it ends are
   * being ended, with the workers it interrupts and the outcome to await.
   */
  const start = Effect.fn("TrellisGraduation.start")(function* (input: StartInput) {
    if (
      Option.isNone(trellisOption) ||
      Option.isNone(turnsOption) ||
      Option.isNone(catalogOption)
    ) {
      return yield* failure("not_an_idea", "Trellis is not available on this server.");
    }
    const trellis = trellisOption.value;
    const turns = turnsOption.value;
    const catalog = catalogOption.value;
    const unavailable = (error: { readonly message: string }) =>
      failure("trellis_unavailable", `Trellis could not be asked: ${error.message}`);

    const ideaProject = yield* projects.get(input.ideaProjectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError((error) => failure("operation_failed", error.message)),
    );
    const notAnIdea = failure(
      "not_an_idea",
      "This thread does not work in a Trellis idea, so there is nothing to graduate.",
    );
    if (ideaProject === undefined || ideaProject.deletedAt !== null) return yield* notAnIdea;
    const root = yield* trellis.canonicalPath(ideaProject.workspaceRoot);
    if (trellisRootOf(yield* trellis.expectedRoots, root) === null) return yield* notAnIdea;
    const resolved = yield* trellis.resolve(root).pipe(Effect.mapError(unavailable));
    const idea = resolved.project;
    if (idea === null || idea.kind !== "idea" || resolved.workspace.kind !== "scratch") {
      return yield* failure(
        "not_an_idea",
        "This is a Trellis project already; only ideas graduate.",
      );
    }
    if (idea.graduated_to !== null) {
      return yield* failure(
        "graduation_in_progress",
        "This idea has graduated already; its threads move into the project shortly.",
      );
    }
    if (inFlight.has(idea.id)) {
      return yield* failure("graduation_in_progress", "This idea is already graduating.");
    }

    // The idea's other threads mid-turn, as T3 and Trellis each see them.
    const caller = input.caller;
    const ideaThreads = input.shell.filter((thread) => thread.projectId === input.ideaProjectId);
    const titles = new Map(input.shell.map((thread) => [thread.id, thread.title]));
    const nameOf = (thread: ThreadId) => titles.get(thread) ?? thread;
    const running = new Map<ThreadId, RunId | null>();
    for (const thread of ideaThreads) {
      if (thread.id !== caller?.id && thread.activeRunId !== null) {
        running.set(thread.id, thread.activeRunId);
      }
    }
    for (const turn of yield* trellis.listTurns(root).pipe(Effect.mapError(unavailable))) {
      if (turn.project !== idea.id) continue;
      const thread = ThreadId.make(turn.thread);
      if (thread !== caller?.id && !running.has(thread)) running.set(thread, null);
    }
    const workers = caller === null ? new Set<ThreadId>() : workersOf(caller.id, input.shell);
    const others = [...running.keys()];
    const notWorkers = others.filter((thread) => !workers.has(thread));
    if (notWorkers.length > 0 || (others.length > 0 && !input.interrupt)) {
      const one = others.length === 1;
      const reason =
        caller === null
          ? `Wait until ${one ? "it finishes" : "they finish"} or stop ${one ? "it" : "them"}, then graduate the idea.`
          : notWorkers.length > 0
            ? `${quoted(notWorkers.map(nameOf))} ${notWorkers.length === 1 ? "is not a worker" : "are not workers"} of this thread, so the graduation cannot end ${notWorkers.length === 1 ? "its turn" : "their turns"}. Wait until ${one ? "it finishes" : "they finish"} or ask the user, then call trellis_graduate again.`
            : `${one ? "It is your worker" : "They are your workers"}: pass interrupt: true to end ${one ? "its turn" : "their turns"} too; ${one ? "it continues" : "they continue"} in the new project.`;
      return yield* failure(
        "threads_running",
        `${quoted(others.map(nameOf))} ${one ? "is" : "are"} mid-turn in this idea, and the graduation copies its folder. ${reason}`,
      );
    }

    // Reserved in the same step as the check; released here unless the graduation started.
    const done = Deferred.makeUnsafe<Outcome>();
    inFlight.set(idea.id, done);
    let launched = false;
    const unreserve = Effect.sync(() => {
      if (launched) return;
      inFlight.delete(idea.id);
      Deferred.doneUnsafe(done, Exit.succeed({ ok: false, error: "it did not start" }));
    });
    return yield* Effect.gen(function* () {
      // Workers with a turn T3 runs; a stale Trellis row goes with the resynchronization.
      const interrupted = others.filter((thread) => running.get(thread) != null);
      const ending = [
        ...(caller === null || caller.activeRunId === null
          ? []
          : [{ threadId: caller.id, runId: caller.activeRunId }]),
        ...interrupted.flatMap((threadId) => {
          const runId = running.get(threadId);
          return runId == null ? [] : [{ threadId, runId }];
        }),
      ];
      const interruptedRuns: Array<RunId> = ending.map((entry) => entry.runId);
      const dispatched = yield* Deferred.make<void>();

      const failedQuietly =
        (what: string, threadId: ThreadId) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logWarning(`trellis graduation could not ${what}`, { threadId, cause }),
            ),
          );
      const send = (threadId: ThreadId, projectId: ProjectId, text: string) =>
        Effect.gen(function* () {
          const id = yield* uuid;
          return yield* threads.sendToThread({
            projectId,
            commandId: CommandId.make(`command:trellis-graduate:continuation:${id}`),
            threadId,
            messageId: MessageId.make(`message:trellis-graduate:continuation:${id}`),
            text,
            attachments: [],
            mode: "queue",
            createdBy: "agent",
            creationSource: "mcp",
          });
        });
      // Where a thread is now: it moves during the graduation.
      const projectOf = (threadId: ThreadId) =>
        threads.getThreadShell(threadId).pipe(
          Effect.map((shell) => shell?.projectId ?? input.ideaProjectId),
          Effect.orElseSucceed(() => input.ideaProjectId),
        );

      /** Queues the thread's continuation behind its running turn, first in its queue. */
      const queueContinuation = (threadId: ThreadId, text: string) =>
        Effect.gen(function* () {
          const sent = yield* send(threadId, input.ideaProjectId, text);
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

      /** Interrupts the thread's turn running now, holding its queue. */
      const interruptRun = (threadId: ThreadId) =>
        Effect.gen(function* () {
          const runId = (yield* threads.getThreadShell(threadId))?.activeRunId ?? null;
          if (runId === null) return;
          interruptedRuns.push(runId);
          yield* threads.dispatch({
            type: "run.interrupt",
            commandId: yield* commandId("interrupt"),
            threadId,
            runId,
            reason: "Interrupted for a Trellis graduation",
            holdQueue: true,
            keepDelegatedCompletions: true,
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

      const awaitEnded = Effect.suspend(() => turns.awaitEnded(interruptedRuns)).pipe(
        Effect.timeoutOption(TURN_END_TIMEOUT),
        Effect.asVoid,
      );

      /** Moves the idea's active threads into the new project. */
      const moveThreads = (to: ProjectId) =>
        Effect.gen(function* () {
          const current = yield* threads.getShellSnapshot({ location: "active" });
          const moved: Array<OrchestrationV2ThreadShell> = [];
          const notMoved: Array<string> = [];
          for (const thread of current.threads) {
            if (thread.projectId !== input.ideaProjectId) continue;
            const result = yield* threads
              .dispatch({
                type: "thread.project.move",
                commandId: yield* commandId("move"),
                threadId: thread.id,
                projectId: to,
                expectedProjectId: input.ideaProjectId,
              })
              .pipe(Effect.result);
            // The catalog may have followed the graduation first.
            const there =
              result._tag === "Success" ||
              (yield* threads.getThreadShell(thread.id).pipe(Effect.orElseSucceed(() => null)))
                ?.projectId === to;
            if (there) {
              moved.push(thread);
              continue;
            }
            yield* Effect.logWarning("trellis graduation left a thread for the catalog", {
              threadId: thread.id,
              detail:
                result._tag === "Failure"
                  ? (userFacingDispatchErrorMessage(result.failure) ?? result.failure.message)
                  : undefined,
            });
            notMoved.push(thread.title);
          }
          return { moved, notMoved };
        });

      const run = Effect.gen(function* () {
        // A queue the user paused stays paused; such a thread gets its
        // continuation afterwards (an idle thread starts it at once).
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
                Effect.logWarning("trellis graduation could not queue a continuation", {
                  threadId,
                  cause,
                }).pipe(Effect.as(undefined)),
              ),
            ),
          );
        }
        for (const { threadId } of ending) {
          yield* interruptRun(threadId).pipe(failedQuietly("interrupt a run", threadId));
        }
        yield* Deferred.succeed(dispatched, undefined);
        // Trellis must see those turns ended, or it refuses them; stale ones go too.
        yield* awaitEnded;
        yield* turns.reconcile;

        const graduated = yield* trellis
          .graduate({
            id: idea.id,
            base: input.base,
            name: input.name,
            thread: caller?.id,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.succeed({ ok: false as const, error: error.message, turns: [] }),
            ),
          );
        let outcome: Outcome;
        let moved: ReadonlyArray<OrchestrationV2ThreadShell> = [];
        if (!graduated.ok) {
          let reason = graduated.error;
          for (const [id, title] of titles) reason = reason.replaceAll(id, `"${title}"`);
          outcome = { ok: false, error: reason };
        } else {
          const created = yield* catalog.projectFor(graduated.project).pipe(Effect.result);
          if (created._tag === "Failure") {
            // Trellis graduated it: the catalog creates the project and moves
            // the threads on its next sync.
            outcome = {
              ok: false,
              error: `the idea graduated, but its T3 project could not be created yet (${created.failure.message}); its threads move there shortly`,
            };
          } else {
            const result = yield* moveThreads(created.success.projectId);
            moved = result.moved;
            outcome = { ok: true, project: created.success, notMoved: result.notMoved };
          }
        }

        // A run whose interrupt did not land settles shortly.
        yield* awaitEnded;
        const callerText = callerContinuation(outcome, interrupted.map(nameOf));
        const continued = new Set<ThreadId>();
        for (const threadId of new Set(ending.map((entry) => entry.threadId))) {
          continued.add(threadId);
          const text =
            threadId === caller?.id
              ? callerText
              : workerContinuation(caller?.title ?? "the user", outcome);
          const placeholder = pending.get(threadId);
          const projectId = yield* projectOf(threadId);
          if (placeholder === undefined) {
            yield* send(threadId, projectId, text).pipe(
              failedQuietly("continue the thread", threadId),
            );
            if (!paused.has(threadId)) {
              yield* resumeQueue(threadId).pipe(failedQuietly("resume the queue", threadId));
            }
            continue;
          }
          // A placeholder promoted before its queue was held cannot be edited; send the outcome then.
          yield* Effect.gen(function* () {
            yield* threads.dispatch({
              type: "queued-run.edit",
              commandId: yield* commandId("result"),
              threadId,
              runId: placeholder,
              text,
            });
          }).pipe(
            Effect.catchCause(() => send(threadId, projectId, text)),
            failedQuietly("write the outcome into the continuation", threadId),
          );
          yield* resumeQueue(threadId).pipe(failedQuietly("resume the queue", threadId));
        }
        // The idea's other threads learn where they are now.
        if (outcome.ok) {
          for (const thread of moved) {
            if (continued.has(thread.id)) continue;
            yield* send(thread.id, outcome.project.projectId, movedNote(outcome.project)).pipe(
              failedQuietly("tell a moved thread where it is", thread.id),
            );
          }
        }
        return outcome;
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => inFlight.delete(idea.id)).pipe(
            Effect.andThen(Deferred.succeed(done, Exit.isSuccess(exit) ? exit.value : STOPPED)),
            Effect.andThen(Deferred.succeed(dispatched, undefined)),
          ),
        ),
      );
      // Detached: the caller's interrupt ends the MCP request that started it.
      yield* Effect.uninterruptible(
        Effect.forkIn(run, scope).pipe(Effect.andThen(Effect.sync(() => (launched = true)))),
      );
      yield* Deferred.await(dispatched);
      return { interrupting: interrupted.map(nameOf), done };
    }).pipe(Effect.onExit(() => unreserve));
  });

  const graduateFromTool: TrellisGraduationShape["graduateFromTool"] = Effect.fn(
    "TrellisGraduation.graduateFromTool",
  )(function* (callScope, input) {
    if (!callScope.capabilities.has("orchestration")) {
      return yield* failure("capability_denied", "This credential cannot control threads.");
    }
    const shell = yield* threads
      .getShellSnapshot({ location: "active" })
      .pipe(Effect.mapError((error) => failure("operation_failed", error.message)));
    const caller = shell.threads.find((thread) => thread.id === callScope.threadId);
    if (caller === undefined || caller.deletedAt !== null) {
      return yield* failure("thread_not_found", "The calling thread was not found.");
    }
    const started = yield* start({
      ideaProjectId: caller.projectId,
      caller,
      shell: shell.threads,
      base: input.base,
      name: input.name,
      interrupt: input.interrupt === true,
    });
    return {
      status: "started",
      interrupting: started.interrupting,
      note: "The graduation is under way and this turn is being ended; stop here. Its outcome arrives as your next message, in the new project.",
    } satisfies TrellisGraduateMcpResult;
  });

  const graduate: TrellisGraduationShape["graduate"] = Effect.fn("TrellisGraduation.graduate")(
    function* (input) {
      const asError = (error: { readonly message: string }) =>
        new TrellisError({ message: error.message });
      const shell = yield* threads
        .getShellSnapshot({ location: "active" })
        .pipe(Effect.mapError(asError));
      const started = yield* start({
        ideaProjectId: input.projectId,
        caller: null,
        shell: shell.threads,
        base: input.base,
        name: input.name,
        interrupt: false,
      }).pipe(Effect.mapError(asError));
      const outcome = yield* Deferred.await(started.done);
      if (!outcome.ok) {
        return yield* new TrellisError({ message: `The graduation failed: ${outcome.error}.` });
      }
      return {
        projectId: outcome.project.projectId,
        workspaceRoot: outcome.project.workspaceRoot,
        name: outcome.project.name,
        notMoved: outcome.notMoved,
      } satisfies TrellisGraduateResult;
    },
  );

  const drain = Effect.suspend(() =>
    Effect.forEach([...inFlight.values()], Deferred.await, { discard: true }),
  );

  return TrellisGraduation.of({ graduateFromTool, graduate, drain });
});

export const layer = Layer.effect(TrellisGraduation, make);
