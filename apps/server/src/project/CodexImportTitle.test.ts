import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import {
  CodexImportTitle,
  CodexImportTitleLive,
  needsCodexImportTitle,
} from "./CodexImportTitle.ts";

const projectId = ProjectId.make("project-codex-import-title");
const titleModel: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "configured-cheap-title-model",
};

function threadShell(threadId: ThreadId, title: string): OrchestrationThreadShell {
  return {
    id: threadId,
    projectId,
    title,
    modelSelection: titleModel,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function serviceLayer(input: {
  readonly titles: Map<ThreadId, string>;
  readonly generateThreadTitle: TextGeneration["Service"]["generateThreadTitle"];
  readonly dispatch: OrchestrationEngineService["Service"]["dispatch"];
  readonly onSnapshot?: ((threadId: ThreadId) => Effect.Effect<void>) | undefined;
}) {
  return CodexImportTitleLive.pipe(
    Layer.provideMerge(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: (threadId) =>
          Effect.gen(function* () {
            if (input.onSnapshot) yield* input.onSnapshot(threadId);
            const title = input.titles.get(threadId);
            return title === undefined ? Option.none() : Option.some(threadShell(threadId, title));
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(OrchestrationEngineService)({
        dispatch: input.dispatch,
      }),
    ),
    Layer.provideMerge(
      Layer.mock(TextGeneration)({
        generateThreadTitle: input.generateThreadTitle,
      }),
    ),
    Layer.provideMerge(
      ServerSettingsService.layerTest({ textGenerationModelSelection: titleModel }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

it.layer(NodeServices.layer)("CodexImportTitle", (it) => {
  it("recognizes only missing and generic native titles", () => {
    expect(needsCodexImportTitle(undefined)).toBe(true);
    expect(needsCodexImportTitle("  ")).toBe(true);
    expect(needsCodexImportTitle("NEW THREAD")).toBe(true);
    expect(needsCodexImportTitle("Untitled conversation")).toBe(true);
    expect(needsCodexImportTitle("Trace attention circuits")).toBe(false);
  });

  it.effect("uses the configured title model and dispatches a guarded rename", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("import-title-generated");
      const titles = new Map([[threadId, "New thread"]]);
      const commands: Array<OrchestrationCommand> = [];
      const generatedInputs: Array<
        Parameters<TextGeneration["Service"]["generateThreadTitle"]>[0]
      > = [];
      const renamed = yield* Deferred.make<void>();
      const layer = serviceLayer({
        titles,
        generateThreadTitle: (request) =>
          Effect.sync(() => {
            generatedInputs.push(request);
            return { title: "Imported title" };
          }),
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            if (command.type === "thread.meta.update" && command.title) {
              titles.set(threadId, command.title);
            }
          }).pipe(Effect.andThen(Deferred.succeed(renamed, undefined)), Effect.as({ sequence: 1 })),
      });

      yield* Effect.gen(function* () {
        const service = yield* CodexImportTitle;
        yield* service.schedule({
          threadId,
          cwd: "/workspace",
          expectedTitle: "New thread",
          context: "Investigate imported attention traces",
        });
        yield* Deferred.await(renamed);
      }).pipe(Effect.provide(layer));

      expect(generatedInputs).toHaveLength(1);
      expect(generatedInputs[0]).toMatchObject({
        cwd: "/workspace",
        message: "Investigate imported attention traces",
        modelSelection: titleModel,
      });
      expect(commands[0]).toMatchObject({
        type: "thread.meta.update",
        threadId,
        title: "Imported title",
        expectedTitle: "New thread",
      });
    }),
  );

  it.effect("contains generator failure and permits a later retry", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("import-title-retry");
      const titles = new Map([[threadId, "New thread"]]);
      const firstFailed = yield* Deferred.make<void>();
      const retried = yield* Deferred.make<void>();
      let attempts = 0;
      const layer = serviceLayer({
        titles,
        generateThreadTitle: () =>
          Effect.gen(function* () {
            attempts++;
            if (attempts === 1) {
              yield* Deferred.succeed(firstFailed, undefined);
              return yield* new TextGenerationError({
                operation: "generateThreadTitle",
                detail: "synthetic failure",
              });
            }
            yield* Deferred.succeed(retried, undefined);
            return { title: "Recovered title" };
          }),
        dispatch: () => Effect.succeed({ sequence: 1 }),
      });

      yield* Effect.gen(function* () {
        const service = yield* CodexImportTitle;
        yield* service.schedule({
          threadId,
          cwd: "/workspace",
          expectedTitle: "New thread",
          context: "Real preview",
        });
        yield* Deferred.await(firstFailed);
        yield* Effect.yieldNow;
        yield* service.schedule({
          threadId,
          cwd: "/workspace",
          expectedTitle: "New thread",
          context: "Real preview",
        });
        yield* Deferred.await(retried);
      }).pipe(Effect.provide(layer));

      expect(attempts).toBe(2);
    }),
  );

  it.effect("does not overwrite a manual rename while generation is running", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("import-title-manual-race");
      const titles = new Map([[threadId, "New thread"]]);
      const enteredGenerator = yield* Deferred.make<void>();
      const releaseGenerator = yield* Deferred.make<void>();
      const checkedLatest = yield* Deferred.make<void>();
      const commands: Array<OrchestrationCommand> = [];
      let snapshotReads = 0;
      const layer = serviceLayer({
        titles,
        onSnapshot: () =>
          Effect.gen(function* () {
            snapshotReads++;
            if (snapshotReads === 2) yield* Deferred.succeed(checkedLatest, undefined);
          }),
        generateThreadTitle: () =>
          Deferred.succeed(enteredGenerator, undefined).pipe(
            Effect.andThen(Deferred.await(releaseGenerator)),
            Effect.as({ title: "Generated title" }),
          ),
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: 1 };
          }),
      });

      yield* Effect.gen(function* () {
        const service = yield* CodexImportTitle;
        yield* service.schedule({
          threadId,
          cwd: "/workspace",
          expectedTitle: "New thread",
          context: "Real preview",
        });
        yield* Deferred.await(enteredGenerator);
        titles.set(threadId, "Manual title");
        yield* Deferred.succeed(releaseGenerator, undefined);
        yield* Deferred.await(checkedLatest);
        yield* Effect.yieldNow;
      }).pipe(Effect.provide(layer));

      expect(commands).toEqual([]);
      expect(titles.get(threadId)).toBe("Manual title");
    }),
  );

  it.effect("runs at most two generations and deduplicates pending thread ids", () =>
    Effect.gen(function* () {
      const threadIds = Array.from({ length: 4 }, (_, index) =>
        ThreadId.make(`import-title-concurrency-${index}`),
      );
      const titles = new Map(threadIds.map((threadId) => [threadId, "New thread"]));
      const firstTwoStarted = yield* Deferred.make<void>();
      const releaseGenerators = yield* Deferred.make<void>();
      const allRenamed = yield* Deferred.make<void>();
      let active = 0;
      let maxActive = 0;
      let started = 0;
      let renamed = 0;
      const layer = serviceLayer({
        titles,
        generateThreadTitle: () =>
          Effect.gen(function* () {
            active++;
            started++;
            maxActive = Math.max(maxActive, active);
            if (started === 2) yield* Deferred.succeed(firstTwoStarted, undefined);
            yield* Deferred.await(releaseGenerators);
            return { title: `Generated ${started}` };
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                active--;
              }),
            ),
          ),
        dispatch: () =>
          Effect.gen(function* () {
            renamed++;
            if (renamed === 4) yield* Deferred.succeed(allRenamed, undefined);
            return { sequence: renamed };
          }),
      });

      yield* Effect.gen(function* () {
        const service = yield* CodexImportTitle;
        for (const threadId of threadIds) {
          yield* service.schedule({
            threadId,
            cwd: "/workspace",
            expectedTitle: "New thread",
            context: `Real preview ${threadId}`,
          });
        }
        yield* service.schedule({
          threadId: threadIds[0]!,
          cwd: "/workspace",
          expectedTitle: "New thread",
          context: "Duplicate preview",
        });
        yield* Deferred.await(firstTwoStarted);
        expect(started).toBe(2);
        expect(maxActive).toBe(2);
        yield* Deferred.succeed(releaseGenerators, undefined);
        yield* Deferred.await(allRenamed);
      }).pipe(Effect.provide(layer));

      expect(started).toBe(4);
      expect(maxActive).toBe(2);
    }),
  );
});
