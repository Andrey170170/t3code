import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EventId,
  ProjectId,
  ThreadId,
  TRELLIS_LANDING_PAD_PROJECT_ID,
  TrellisError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { OrchestratorProjectionError, OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { TrellisCatalog } from "./TrellisCatalog.ts";
import * as TrellisIdeaPromotion from "./TrellisIdeaPromotion.ts";
import {
  createProject,
  modelSelection,
  projectEvent,
  sendMessage,
  TrellisOrchestratorTestLayer,
  writeEvent,
} from "./TrellisOrchestrator.testkit.ts";

// The first send of a new-idea draft creates the idea and its project; the
// idea is discarded only when the thread did not end up in it.

const ideas = {
  created: [] as Array<string>,
  discarded: [] as Array<string>,
};

/** Each idea gets its own project at `/trellis/workspaces/ws-scratch/project/<id>`. */
const FakeCatalog = Layer.effect(
  TrellisCatalog,
  Effect.gen(function* () {
    const store = yield* ProjectStore.ProjectStoreV2;
    const unused = () => Effect.die("unused catalog operation");
    return TrellisCatalog.of({
      createIdeaForDraft: Effect.gen(function* () {
        const trellisId = `idea-${ideas.created.length + 1}`;
        ideas.created.push(trellisId);
        // Lets concurrent sends interleave here if they are not serialized.
        yield* Effect.yieldNow;
        const workspaceRoot = `/trellis/workspaces/ws-scratch/project/${trellisId}`;
        const projectId = yield* createProject(trellisId, workspaceRoot).pipe(
          Effect.provideService(ProjectStore.ProjectStoreV2, store),
          Effect.orDie,
        );
        return { projectId, workspaceRoot, name: trellisId, trellisId };
      }),
      discardIdea: (trellisId) => Effect.sync(() => void ideas.discarded.push(trellisId)),
      start: unused,
      syncNow: Effect.die("unused"),
      status: Effect.die("unused"),
      newIdea: unused,
      restoreConflicts: unused,
      prepareIdeaDraft: Effect.die("unused"),
      trashProject: unused,
      listTrash: Effect.die("unused"),
      restore: unused,
      emptyTrash: Effect.die("unused"),
      newProject: unused,
      find: unused,
      checkProjectDelete: unused,
      listWorkspaces: unused,
      listCheckpoints: unused,
      forkWorkspace: unused,
      purge: unused,
      discardFork: unused,
      projectFor: unused,
      listBases: Effect.die("unused catalog operation"),
      details: Effect.die("unused catalog operation"),
      buildBase: () => Effect.die("unused catalog operation"),
    });
  }),
);

/** Set to make thread reads fail, as a projection read error would. */
const shellReads = { failing: false };
const FlakyOrchestrator = Layer.effect(
  OrchestratorV2,
  Effect.map(OrchestratorV2, (orchestrator) =>
    OrchestratorV2.of({
      ...orchestrator,
      getThreadShell: (threadId) =>
        shellReads.failing
          ? Effect.fail(new OrchestratorProjectionError({ threadId }))
          : orchestrator.getThreadShell(threadId),
    }),
  ),
);

const TestLayer = TrellisIdeaPromotion.layer.pipe(
  Layer.provide(FlakyOrchestrator),
  Layer.provideMerge(FakeCatalog),
  Layer.provideMerge(TrellisOrchestratorTestLayer),
);

const landingPad = projectEvent(
  "project.created",
  TRELLIS_LANDING_PAD_PROJECT_ID,
  "/t3/state/trellis-landing-pad",
);

/** Launches the thread as the web's first send does: create, then the message. */
const createIn = (threadId: ThreadId, projectId: ProjectId) =>
  Effect.flatMap(OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId,
      title: "New idea",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    }),
  );

const projectOf = (threadId: ThreadId) =>
  Effect.flatMap(OrchestratorV2, (orchestrator) => orchestrator.getThreadShell(threadId)).pipe(
    Effect.map((shell) => shell?.projectId ?? null),
  );

const reset = Effect.sync(() => {
  ideas.created.length = 0;
  ideas.discarded.length = 0;
});

it.layer(TestLayer)("TrellisIdeaPromotion", (it) => {
  it.effect("launches the first send into a new idea", () =>
    Effect.gen(function* () {
      yield* reset;
      const promotion = yield* TrellisIdeaPromotion.TrellisIdeaPromotion;
      const threadId = ThreadId.make("idea-launch");
      yield* promotion.launch({
        threadId,
        projectId: TRELLIS_LANDING_PAD_PROJECT_ID,
        launch: (projectId) => createIn(threadId, projectId),
      });
      assert.deepEqual(ideas.created, ["idea-1"]);
      assert.equal(yield* projectOf(threadId), ProjectId.make("idea-1-project"));
      assert.deepEqual(ideas.discarded, []);
    }),
  );

  it.effect("discards the idea when the launch fails before the thread exists", () =>
    Effect.gen(function* () {
      yield* reset;
      const promotion = yield* TrellisIdeaPromotion.TrellisIdeaPromotion;
      const error = yield* promotion
        .launch({
          threadId: ThreadId.make("idea-launch-failed"),
          projectId: TRELLIS_LANDING_PAD_PROJECT_ID,
          launch: () => Effect.fail("provider unavailable"),
        })
        .pipe(Effect.flip);
      assert.equal(error, "provider unavailable");
      assert.deepEqual(ideas.discarded, ["idea-1"]);
    }),
  );

  it.effect(
    "keeps the idea when the message fails after the thread exists, and a retry sends",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const promotion = yield* TrellisIdeaPromotion.TrellisIdeaPromotion;
        const threadId = ThreadId.make("idea-message-failed");
        const launched: Array<ProjectId> = [];
        yield* promotion
          .launch({
            threadId,
            projectId: TRELLIS_LANDING_PAD_PROJECT_ID,
            launch: (projectId) =>
              createIn(threadId, projectId).pipe(Effect.andThen(Effect.fail("message failed"))),
          })
          .pipe(Effect.flip);
        assert.deepEqual(ideas.discarded, []);

        yield* promotion.launch({
          threadId,
          projectId: TRELLIS_LANDING_PAD_PROJECT_ID,
          launch: (projectId) => Effect.sync(() => void launched.push(projectId)),
        });
        assert.deepEqual(ideas.created, ["idea-1"]);
        assert.deepEqual(launched, [ProjectId.make("idea-1-project")]);
      }),
  );

  it.effect("creates one idea for concurrent first sends", () =>
    Effect.gen(function* () {
      yield* reset;
      const promotion = yield* TrellisIdeaPromotion.TrellisIdeaPromotion;
      const threadId = ThreadId.make("idea-concurrent");
      const send = promotion
        .launch({
          threadId,
          projectId: TRELLIS_LANDING_PAD_PROJECT_ID,
          launch: (projectId) => createIn(threadId, projectId),
        })
        .pipe(Effect.result);
      yield* Effect.all([send, send, send], { concurrency: "unbounded" });
      assert.deepEqual(ideas.created, ["idea-1"]);
      assert.deepEqual(ideas.discarded, []);
      assert.equal(yield* projectOf(threadId), ProjectId.make("idea-1-project"));
    }),
  );

  it.effect(
    "finishes the send when the request is interrupted mid-way, and a retry waits for it",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const promotion = yield* TrellisIdeaPromotion.TrellisIdeaPromotion;
        const threadId = ThreadId.make("idea-interrupted");
        const gate = yield* Deferred.make<void>();
        const settled = yield* Deferred.make<void>();
        const request = yield* Effect.forkChild(
          promotion.launch({
            threadId,
            projectId: TRELLIS_LANDING_PAD_PROJECT_ID,
            launch: (projectId) =>
              Deferred.await(gate).pipe(
                Effect.andThen(createIn(threadId, projectId)),
                Effect.ensuring(Deferred.succeed(settled, undefined)),
              ),
          }),
        );
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(request);
        // A retry while the interrupted promotion is still pending must not
        // create a second idea.
        const retry = yield* Effect.forkChild(
          promotion
            .launch({
              threadId,
              projectId: TRELLIS_LANDING_PAD_PROJECT_ID,
              launch: (projectId) => createIn(threadId, projectId),
            })
            .pipe(Effect.result),
        );
        // Lets the retry run as far as it can before the first launch resumes.
        yield* Effect.repeat(Effect.yieldNow, { times: 20 });
        yield* Deferred.succeed(gate, undefined);
        yield* Deferred.await(settled);
        yield* Fiber.join(retry);
        assert.equal(yield* projectOf(threadId), ProjectId.make("idea-1-project"));
        assert.deepEqual(ideas.created, ["idea-1"]);
        assert.deepEqual(ideas.discarded, []);
      }),
  );

  it.effect("moves a landing-pad thread into its idea before the first message", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* landingPad;
      const promotion = yield* TrellisIdeaPromotion.TrellisIdeaPromotion;
      const threadId = ThreadId.make("idea-move");
      yield* createIn(threadId, TRELLIS_LANDING_PAD_PROJECT_ID);
      yield* promotion.dispatchMessage({
        threadId,
        commandId: CommandId.make("idea-move:message"),
        dispatch: sendMessage(threadId, "first"),
      });
      assert.equal(yield* projectOf(threadId), ProjectId.make("idea-1-project"));
      assert.deepEqual(ideas.discarded, []);
    }),
  );

  it.effect("keeps the idea when its thread cannot be read after a failed message", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* landingPad;
      const promotion = yield* TrellisIdeaPromotion.TrellisIdeaPromotion;
      const threadId = ThreadId.make("idea-move-unreadable");
      yield* createIn(threadId, TRELLIS_LANDING_PAD_PROJECT_ID);
      yield* promotion
        .dispatchMessage({
          threadId,
          commandId: CommandId.make("idea-move-unreadable:message"),
          // The move has committed; the cleanup's read of the thread fails.
          dispatch: Effect.sync(() => void (shellReads.failing = true)).pipe(
            Effect.andThen(Effect.fail("message failed")),
          ),
        })
        .pipe(Effect.flip, Effect.ensuring(Effect.sync(() => void (shellReads.failing = false))));
      assert.equal(yield* projectOf(threadId), ProjectId.make("idea-1-project"));
      assert.deepEqual(ideas.discarded, []);
    }),
  );

  it.effect("keeps the idea when the message fails after a committed move", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* landingPad;
      const promotion = yield* TrellisIdeaPromotion.TrellisIdeaPromotion;
      const threadId = ThreadId.make("idea-move-message-failed");
      yield* createIn(threadId, TRELLIS_LANDING_PAD_PROJECT_ID);
      yield* promotion
        .dispatchMessage({
          threadId,
          commandId: CommandId.make("idea-move-message-failed:message"),
          dispatch: Effect.fail("message failed"),
        })
        .pipe(Effect.flip);
      assert.equal(yield* projectOf(threadId), ProjectId.make("idea-1-project"));
      assert.deepEqual(ideas.discarded, []);
      // A retry goes straight to the idea.
      yield* promotion.dispatchMessage({
        threadId,
        commandId: CommandId.make("idea-move-message-failed:retry"),
        dispatch: sendMessage(threadId, "retry"),
      });
      assert.deepEqual(ideas.created, ["idea-1"]);
    }),
  );

  it.effect("discards the idea when the move fails", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* landingPad;
      const promotion = yield* TrellisIdeaPromotion.TrellisIdeaPromotion;
      const threadId = ThreadId.make("idea-move-failed");
      yield* createIn(threadId, TRELLIS_LANDING_PAD_PROJECT_ID);
      // A fork that has not run yet makes the move refuse.
      const now = yield* DateTime.now;
      yield* writeEvent({
        id: EventId.make("idea-move-failed:transfer"),
        type: "context-transfer.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: ContextTransferId.make("idea-move-failed:transfer"),
          type: "fork",
          sourceThreadId: ThreadId.make("idea-move-failed-source"),
          targetThreadId: threadId,
          sourcePoint: { threadId: ThreadId.make("idea-move-failed-source") },
          basePoint: null,
          sourceProviderInstanceId: modelSelection.instanceId,
          targetProviderInstanceId: modelSelection.instanceId,
          targetRunId: null,
          status: "pending",
          resolution: null,
          createdBy: "user",
          error: null,
          createdAt: now,
          updatedAt: now,
          consumedAt: null,
        },
      });
      const error = yield* promotion
        .dispatchMessage({
          threadId,
          commandId: CommandId.make("idea-move-failed:message"),
          dispatch: Effect.void,
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, TrellisError);
      assert.equal(yield* projectOf(threadId), TRELLIS_LANDING_PAD_PROJECT_ID);
      assert.deepEqual(ideas.discarded, ["idea-1"]);
    }),
  );
});
