/**
 * TrellisIdeaPromotion - turns a new-idea draft's first send into a thread
 * in a fresh Trellis idea.
 *
 * New-idea drafts belong to the hidden landing pad project. The first send
 * creates the idea, then dispatches the bootstrap with the thread moved into
 * the idea's project folder (Trellis refuses worktrees). An idea that does
 * not end up holding this thread is discarded, whether the send failed, was
 * interrupted, or lost a race with a duplicate send.
 *
 * @module trellis/TrellisIdeaPromotion
 */
import {
  isTrellisLandingPad,
  type OrchestrationCommand,
  type ProjectId,
  type ThreadId,
  type TrellisError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

type TurnStart = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

export interface IdeaPromotionDeps<E> {
  readonly createIdea: Effect.Effect<
    { readonly projectId: ProjectId; readonly trellisId: string },
    TrellisError
  >;
  readonly discardIdea: (trellisId: string) => Effect.Effect<void>;
  /** The project of an existing thread, or null when it does not exist. */
  readonly threadProjectId: (threadId: ThreadId) => Effect.Effect<ProjectId | null>;
  readonly dispatch: (command: TurnStart) => Effect.Effect<{ readonly sequence: number }, E>;
  readonly ideaError: (error: TrellisError) => E;
}

/**
 * Dispatches `command`, first promoting a landing-pad draft. The promotion
 * runs detached, so an interrupted request still finishes or cleans up.
 */
export const dispatchWithIdeaPromotion = <E>(
  command: TurnStart,
  deps: IdeaPromotionDeps<E>,
): Effect.Effect<{ readonly sequence: number }, E> => {
  const createThread = command.bootstrap?.createThread;
  if (createThread === undefined || !isTrellisLandingPad(createThread.projectId)) {
    return deps.dispatch(command);
  }
  const moveTo = (projectId: ProjectId): TurnStart => ({
    ...command,
    bootstrap: {
      createThread: { ...createThread, projectId, branch: null, worktreePath: null },
    },
  });
  const program = Effect.gen(function* () {
    // A retried send whose thread exists targets that thread's project and
    // fails as an ordinary duplicate, without creating a second idea.
    const existing = yield* deps.threadProjectId(command.threadId);
    if (existing !== null) return yield* deps.dispatch(moveTo(existing));
    return yield* Effect.uninterruptibleMask((restore) =>
      deps.createIdea.pipe(
        Effect.mapError(deps.ideaError),
        Effect.flatMap((idea) =>
          restore(deps.dispatch(moveTo(idea.projectId))).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : deps
                    .threadProjectId(command.threadId)
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
