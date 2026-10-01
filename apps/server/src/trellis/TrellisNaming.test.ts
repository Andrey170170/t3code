import { it } from "@effect/vitest";
import { type OrchestrationV2DomainEvent, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectService } from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { makeTestTrellis, Trellis, type TrellisProjectView } from "./Trellis.ts";
import { TrellisCatalog } from "./TrellisCatalog.ts";
import * as TrellisNaming from "./TrellisNaming.ts";

const ROOT = "/trellis";
const IDEA_PATH = `${ROOT}/workspaces/ws-scratch/project/idea-1`;
const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");

type Message = { readonly role: "user" | "assistant"; readonly text: string };

/** A Trellis item whose name source follows `describe`, and a thread that grows. */
function makeHarness(input: { readonly workspaceRoot?: string } = {}) {
  const messages: Array<Message> = [];
  const generated: Array<{ message: string; previousName?: string | undefined }> = [];
  const described: Array<Parameters<Trellis["Service"]["describe"]>[0]> = [];
  let item: TrellisProjectView = {
    id: "idea-1",
    kind: "idea",
    name: "Idea",
    name_source: "default",
    description: "",
    workspace_id: "ws-scratch",
    path: IDEA_PATH,
    updated_at: 0,
    deleted_at: null,
    graduated_to: null,
    workspaces: [],
  };

  const layer = TrellisNaming.layer.pipe(
    Layer.provide(
      Layer.succeed(
        Trellis,
        makeTestTrellis({
          env: { root: ROOT, bin: "trellis", shimDir: "/shims" },
          describe: (request) =>
            Effect.sync(() => {
              described.push(request);
              item = { ...item, name: request.name ?? item.name, name_source: request.source };
              return { ignored: [] };
            }),
          resolve: () =>
            Effect.sync(() => ({
              workspace: {
                id: "ws-scratch",
                kind: "scratch",
                name: "scratch",
                path: `${ROOT}/workspaces/ws-scratch/project`,
                deleted_at: null,
              },
              project: item,
            })),
        }),
      ),
    ),
    Layer.provide(Layer.mock(TrellisCatalog)({ syncNow: Effect.succeed(new Map()) })),
    Layer.provide(
      Layer.mock(TextGeneration)({
        generateProjectName: (request) =>
          Effect.sync(() => {
            generated.push({ message: request.message, previousName: request.previousName });
            return { name: "Weather Plots", description: "Plotting local weather data." };
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(OrchestratorV2)({
        getThreadRecords: () =>
          Effect.sync(() => ({
            thread: { id: threadId, projectId, worktreePath: null },
            messages: messages.map((message) => ({ ...message, streaming: false })),
          })) as never,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectService)({
        getById: () =>
          Effect.succeed(Option.some({ workspaceRoot: input.workspaceRoot ?? IDEA_PATH } as never)),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
  );
  return { layer, messages, generated, described };
}

const userMessage = {
  type: "message.updated",
  threadId,
  payload: { threadId, role: "user", streaming: false },
} as unknown as OrchestrationV2DomainEvent;
const runCompleted = (ordinal: number) =>
  ({
    type: "run.updated",
    threadId,
    payload: { threadId, ordinal, status: "completed" },
  }) as unknown as OrchestrationV2DomainEvent;

describe("TrellisNaming", () => {
  it.effect("names an item after the first message, then refines it once", () => {
    const harness = makeHarness();
    const turn = (text: string, ordinal: number) =>
      Effect.gen(function* () {
        const naming = yield* TrellisNaming.TrellisNaming;
        harness.messages.push({ role: "user", text });
        yield* naming.handleEvent(userMessage);
        // Message updates repeat; they never rename a generated name.
        yield* naming.handleEvent(userMessage);
        yield* naming.drain;
        harness.messages.push({ role: "assistant", text: `done ${ordinal}` });
        yield* naming.handleEvent(runCompleted(ordinal));
        yield* naming.drain;
      });
    return Effect.gen(function* () {
      yield* turn("plot the weather", 1);
      expect(harness.described.map((request) => request.source)).toEqual(["generated"]);
      expect(harness.generated).toEqual([{ message: "plot the weather", previousName: undefined }]);

      yield* turn("add rain", 2);
      yield* turn("and wind", 3);
      yield* turn("and snow", 4);
      expect(harness.described.map((request) => request.source)).toEqual(["generated", "refined"]);
      expect(harness.described[0]).toMatchObject({ target: IDEA_PATH, name: "Weather Plots" });
      expect(harness.generated[1]?.previousName).toBe("Weather Plots");
      expect(harness.generated[1]?.message).toContain("and wind");
      expect(harness.generated).toHaveLength(2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("leaves threads outside Trellis alone", () => {
    const harness = makeHarness({ workspaceRoot: "/home/me/code" });
    return Effect.gen(function* () {
      const naming = yield* TrellisNaming.TrellisNaming;
      harness.messages.push({ role: "user", text: "plot the weather" });
      yield* naming.handleEvent(userMessage);
      yield* naming.drain;
      expect(harness.generated).toEqual([]);
      expect(harness.described).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("mayGenerateName", () => {
  it("never overrides names from the user, an agent, the repository or a refinement", () => {
    for (const source of ["user", "agent", "git", "refined", undefined]) {
      expect(TrellisNaming.mayGenerateName("initial", source)).toBe(false);
      expect(TrellisNaming.mayGenerateName("refine", source)).toBe(false);
    }
    expect(TrellisNaming.mayGenerateName("initial", "generated")).toBe(false);
    expect(TrellisNaming.mayGenerateName("refine", "generated")).toBe(true);
  });
});
