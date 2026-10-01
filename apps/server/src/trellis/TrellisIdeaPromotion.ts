/**
 * TrellisIdeaPromotion - turns a new-idea draft's first send into a thread
 * in a fresh Trellis idea.
 *
 * New-idea drafts belong to the hidden landing pad project. The first send,
 * serialized per thread, re-reads the thread: if it already left the landing
 * pad (a retry or a duplicate send), the send goes to where it is. Otherwise
 * it creates the idea and its T3 project and then sends into it:
 *
 * - `launch` (the web's first send creates the thread together with its first
 *   message) launches the thread directly in the idea's project;
 * - `dispatchMessage` (a thread created earlier in the landing pad) moves the
 *   thread with `thread.project.move`, then dispatches the message.
 *
 * Cleanup re-reads the committed thread: the idea is discarded only when the
 * thread did not end up in it. Once the thread is in the idea, the idea stays
 * whatever happened to the message, and a retry takes the first branch. The
 * promotion runs detached, so an interrupted request still finishes or cleans
 * up.
 *
 * @module trellis/TrellisIdeaPromotion
 */
import {
  CommandId,
  isTrellisLandingPad,
  type ProjectId,
  type ThreadId,
  TrellisError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { makeKeyedSerialExecutor } from "../orchestration-v2/KeyedSerialExecutor.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import { TrellisCatalog } from "./TrellisCatalog.ts";

export interface IdeaPromotionDeps {
  readonly createIdea: Effect.Effect<
    { readonly projectId: ProjectId; readonly trellisId: string },
    TrellisError
  >;
  readonly discardIdea: (trellisId: string) => Effect.Effect<void>;
  /** The project of an existing thread, or null when it does not exist. */
  readonly threadProjectId: (threadId: ThreadId) => Effect.Effect<ProjectId | null>;
}

/**
 * Runs `send` with the project the thread's first send belongs in, creating
 * the idea when the thread is new or still in the landing pad. `existing` is
 * the thread's project before the send (null for a thread not created yet).
 */
export const promoteIdeaDraft = <A, E, R>(input: {
  readonly threadId: ThreadId;
  readonly deps: IdeaPromotionDeps;
  readonly send: (projectId: ProjectId, existing: ProjectId | null) => Effect.Effect<A, E, R>;
  readonly ideaError: (error: TrellisError) => E;
}): Effect.Effect<A, E, R> => {
  const { deps } = input;
  const program = Effect.gen(function* () {
    const existing = yield* deps.threadProjectId(input.threadId);
    if (existing !== null && !isTrellisLandingPad(existing)) {
      return yield* input.send(existing, existing);
    }
    return yield* Effect.uninterruptibleMask((restore) =>
      deps.createIdea.pipe(
        Effect.mapError(input.ideaError),
        Effect.flatMap((idea) =>
          restore(input.send(idea.projectId, existing)).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : deps
                    .threadProjectId(input.threadId)
                    .pipe(
                      Effect.flatMap((projectId) =>
                        projectId === idea.projectId
                          ? Effect.void
                          : deps.discardIdea(idea.trellisId),
                      ),
                    ),
            ),
          ),
        ),
      ),
    );
  });
  return Effect.forkDetach(program).pipe(Effect.flatMap(Fiber.join));
};

export class TrellisIdeaPromotion extends Context.Service<
  TrellisIdeaPromotion,
  {
    /**
     * Launches a new thread; a launch into the landing pad goes into a new
     * idea instead. `launch` receives the project to launch in.
     */
    readonly launch: <A, E, R>(input: {
      readonly threadId: ThreadId | undefined;
      readonly projectId: ProjectId;
      readonly launch: (projectId: ProjectId) => Effect.Effect<A, E, R>;
    }) => Effect.Effect<A, E | TrellisError, R>;
    /** Dispatches a message, first moving a landing-pad thread into a new idea. */
    readonly dispatchMessage: <A, E, R>(input: {
      readonly threadId: ThreadId;
      readonly commandId: CommandId;
      readonly dispatch: Effect.Effect<A, E, R>;
    }) => Effect.Effect<A, E | TrellisError, R>;
  }
>()("t3/trellis/TrellisIdeaPromotion") {}

export const make = Effect.gen(function* () {
  const catalog = yield* TrellisCatalog;
  const orchestrator = yield* OrchestratorV2;
  const threadLocks = yield* makeKeyedSerialExecutor<ThreadId>();

  const threadProjectId = (threadId: ThreadId) =>
    orchestrator.getThreadShell(threadId).pipe(
      Effect.map((shell) => shell?.projectId ?? null),
      Effect.orElseSucceed(() => null),
    );
  const deps: IdeaPromotionDeps = {
    createIdea: catalog.createIdeaForDraft,
    discardIdea: catalog.discardIdea,
    threadProjectId,
  };
  const ideaError = (error: TrellisError) =>
    new TrellisError({ message: `Could not create the Trellis idea: ${error.message}` });

  const moveThread = (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly from: ProjectId;
    readonly to: ProjectId;
  }) =>
    orchestrator
      .dispatch({
        type: "thread.project.move",
        commandId: CommandId.make(`${input.commandId}:trellis-idea-move`),
        threadId: input.threadId,
        projectId: input.to,
        expectedProjectId: input.from,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new TrellisError({
              message: `Could not move the thread into its idea: ${
                userFacingDispatchErrorMessage(error) ?? error.message
              }`,
            }),
        ),
      );

  return TrellisIdeaPromotion.of({
    launch: <A, E, R>(input: {
      readonly threadId: ThreadId | undefined;
      readonly projectId: ProjectId;
      readonly launch: (projectId: ProjectId) => Effect.Effect<A, E, R>;
    }): Effect.Effect<A, E | TrellisError, R> => {
      if (!isTrellisLandingPad(input.projectId)) return input.launch(input.projectId);
      const threadId = input.threadId;
      if (threadId === undefined) {
        return Effect.fail(
          new TrellisError({ message: "A new idea's first message needs a thread id." }),
        );
      }
      return threadLocks.withLock(
        threadId,
        promoteIdeaDraft<A, E | TrellisError, R>({
          threadId,
          deps,
          send: (projectId) => input.launch(projectId),
          ideaError,
        }),
      );
    },
    dispatchMessage: <A, E, R>(input: {
      readonly threadId: ThreadId;
      readonly commandId: CommandId;
      readonly dispatch: Effect.Effect<A, E, R>;
    }): Effect.Effect<A, E | TrellisError, R> =>
      threadProjectId(input.threadId).pipe(
        Effect.flatMap((current) =>
          current === null || !isTrellisLandingPad(current)
            ? input.dispatch
            : threadLocks.withLock(
                input.threadId,
                promoteIdeaDraft<A, E | TrellisError, R>({
                  threadId: input.threadId,
                  deps,
                  send: (projectId, existing) =>
                    existing === null || existing === projectId
                      ? input.dispatch
                      : moveThread({
                          commandId: input.commandId,
                          threadId: input.threadId,
                          from: existing,
                          to: projectId,
                        }).pipe(Effect.andThen(input.dispatch)),
                  ideaError,
                }),
              ),
        ),
      ),
  });
});

export const layer = Layer.effect(TrellisIdeaPromotion, make);
