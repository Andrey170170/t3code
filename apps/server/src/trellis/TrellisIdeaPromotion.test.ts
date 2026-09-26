import {
  CommandId,
  MessageId,
  type OrchestrationCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TRELLIS_LANDING_PAD_PROJECT_ID,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect } from "vite-plus/test";

import { dispatchWithIdeaPromotion, type IdeaPromotionDeps } from "./TrellisIdeaPromotion.ts";

type TurnStart = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

const threadId = ThreadId.make("thread-1");
const ideaProject = ProjectId.make("project-idea");
const createdAt = "2026-01-01T00:00:00.000Z";
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };

const send: TurnStart = {
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-1"),
  threadId,
  message: { messageId: MessageId.make("m-1"), role: "user", text: "hi", attachments: [] },
  runtimeMode: "full-access",
  interactionMode: "default",
  bootstrap: {
    createThread: {
      projectId: TRELLIS_LANDING_PAD_PROJECT_ID,
      title: "New idea",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      createdAt,
    },
    prepareWorktree: { projectCwd: "/landing", baseBranch: "main" },
  },
  createdAt,
};

// `threads` is the read model's thread → project map; `dispatch` decides the outcome.
function harness(input: {
  readonly threads?: Map<ThreadId, ProjectId>;
  readonly dispatch?: (command: TurnStart) => Effect.Effect<{ sequence: number }, string>;
}) {
  const threads = input.threads ?? new Map<ThreadId, ProjectId>();
  const created: Array<string> = [];
  const discarded: Array<string> = [];
  const dispatched: Array<TurnStart> = [];
  const deps: IdeaPromotionDeps<string> = {
    createIdea: Effect.sync(() => {
      const trellisId = `idea-${created.length + 1}`;
      created.push(trellisId);
      return { projectId: ideaProject, trellisId };
    }),
    discardIdea: (trellisId) => Effect.sync(() => void discarded.push(trellisId)),
    threadProjectId: (id) => Effect.sync(() => threads.get(id) ?? null),
    dispatch: (command) =>
      Effect.suspend(() => {
        dispatched.push(command);
        return (
          input.dispatch?.(command) ??
          Effect.sync(() => {
            threads.set(threadId, command.bootstrap!.createThread!.projectId);
            return { sequence: 1 };
          })
        );
      }),
    ideaError: (error) => error.message,
  };
  return { deps, created, discarded, dispatched };
}

describe("dispatchWithIdeaPromotion", () => {
  it.effect("creates the idea on the first send and starts the thread there", () =>
    Effect.gen(function* () {
      const h = harness({});
      yield* dispatchWithIdeaPromotion(send, h.deps);
      expect(h.created).toEqual(["idea-1"]);
      expect(h.discarded).toEqual([]);
      expect(h.dispatched[0]?.bootstrap).toEqual({
        createThread: {
          ...send.bootstrap!.createThread!,
          projectId: ideaProject,
          branch: null,
          worktreePath: null,
        },
      });
    }),
  );

  it.effect("discards the idea when the send fails before its thread exists", () =>
    Effect.gen(function* () {
      const h = harness({ dispatch: () => Effect.fail("provider unavailable") });
      const error = yield* dispatchWithIdeaPromotion(send, h.deps).pipe(Effect.flip);
      expect(error).toBe("provider unavailable");
      expect(h.discarded).toEqual(["idea-1"]);
    }),
  );

  it.effect("keeps the idea when the thread was created before a later step failed", () =>
    Effect.gen(function* () {
      const threads = new Map<ThreadId, ProjectId>();
      const h = harness({
        threads,
        dispatch: (command) =>
          Effect.sync(() => threads.set(threadId, command.bootstrap!.createThread!.projectId)).pipe(
            Effect.andThen(Effect.fail("turn start failed")),
          ),
      });
      yield* dispatchWithIdeaPromotion(send, h.deps).pipe(Effect.flip);
      expect(h.discarded).toEqual([]);
    }),
  );

  it.effect("discards the loser of a duplicate send whose thread lives in another idea", () =>
    Effect.gen(function* () {
      const threads = new Map<ThreadId, ProjectId>();
      const h = harness({
        threads,
        dispatch: () =>
          Effect.sync(() => threads.set(threadId, ProjectId.make("project-other-idea"))).pipe(
            Effect.andThen(Effect.fail("thread already exists")),
          ),
      });
      yield* dispatchWithIdeaPromotion(send, h.deps).pipe(Effect.flip);
      expect(h.discarded).toEqual(["idea-1"]);
    }),
  );

  it.effect("sends a retry for an existing thread to its project without a new idea", () =>
    Effect.gen(function* () {
      const existing = ProjectId.make("project-existing");
      const h = harness({
        threads: new Map([[threadId, existing]]),
        dispatch: () => Effect.fail("thread already exists"),
      });
      const error = yield* dispatchWithIdeaPromotion(send, h.deps).pipe(Effect.flip);
      expect(error).toBe("thread already exists");
      expect(h.created).toEqual([]);
      expect(h.dispatched[0]?.bootstrap?.createThread?.projectId).toBe(existing);
    }),
  );

  it.effect("finishes the send when the request is interrupted mid-way", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const threads = new Map<ThreadId, ProjectId>();
      const h = harness({
        threads,
        dispatch: (command) =>
          Deferred.await(gate).pipe(
            Effect.andThen(
              Effect.sync(() => {
                threads.set(threadId, command.bootstrap!.createThread!.projectId);
                return { sequence: 1 };
              }),
            ),
            Effect.ensuring(Deferred.succeed(settled, undefined)),
          ),
      });
      const request = yield* Effect.forkChild(dispatchWithIdeaPromotion(send, h.deps));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(request);
      yield* Deferred.succeed(gate, undefined);
      yield* Deferred.await(settled);
      // Not cancelled half-way: the thread exists in its idea, which is kept.
      expect(threads.get(threadId)).toBe(ideaProject);
      expect(h.discarded).toEqual([]);
    }),
  );

  it.effect("passes other commands through untouched", () =>
    Effect.gen(function* () {
      const h = harness({});
      const plain: TurnStart = {
        ...send,
        bootstrap: {
          createThread: { ...send.bootstrap!.createThread!, projectId: ProjectId.make("p") },
        },
      };
      yield* dispatchWithIdeaPromotion(plain, h.deps);
      expect(h.created).toEqual([]);
      expect(h.dispatched).toEqual([plain]);
    }),
  );
});
