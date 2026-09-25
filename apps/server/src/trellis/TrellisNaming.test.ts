import { ProjectId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { Trellis, type TrellisProjectView, makeTestTrellis } from "./Trellis.ts";
import { TrellisCatalog } from "./TrellisCatalog.ts";
import * as TrellisNaming from "./TrellisNaming.ts";

const ROOT = "/trellis";
const IDEA_PATH = `${ROOT}/workspaces/ws-scratch/project/idea-1`;
const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");

type Message = { readonly role: "user" | "assistant"; readonly text: string };

function makeHarness(input: {
  readonly nameSource: string | undefined;
  readonly messages: ReadonlyArray<Message>;
  readonly workspaceRoot?: string;
  readonly latestTurnState?: string;
}) {
  const generated: Array<{ message: string; previousName?: string | undefined }> = [];
  const described: Array<Parameters<Trellis["Service"]["describe"]>[0]> = [];
  let syncs = 0;
  const env = { root: ROOT, bin: "trellis", shimDir: "/shims" };
  const item: TrellisProjectView = {
    id: "idea-1",
    kind: "idea",
    name: "Idea",
    ...(input.nameSource === undefined ? {} : { name_source: input.nameSource }),
    description: "",
    workspace_id: "ws-scratch",
    path: IDEA_PATH,
    updated_at: 0,
    deleted_at: null,
    graduated_to: null,
    workspaces: [],
  };
  const unused = () => Effect.die(new Error("unused"));
  const thread = {
    id: threadId,
    projectId,
    worktreePath: null,
    messages: input.messages,
    latestTurn: { state: input.latestTurnState ?? "completed" },
  };

  const layer = TrellisNaming.layer.pipe(
    Layer.provide(
      Layer.succeed(Trellis, {
        ...makeTestTrellis({ env }),
        current: Effect.succeed(env),
        refresh: Effect.succeed(env),
        expectedRoot: Effect.succeed(ROOT),
        bin: "trellis",
        listWorkspaces: unused,
        listProjects: unused,
        createIdea: unused,
        createProject: unused,
        describe: (request) =>
          Effect.sync(() => {
            described.push(request);
            return { ignored: [] };
          }),
        find: unused,
        resolve: () =>
          Effect.succeed({
            workspace: {
              id: "ws-scratch",
              kind: "scratch",
              name: "scratch",
              path: `${ROOT}/workspaces/ws-scratch/project`,
              deleted_at: null,
            },
            project: item,
          }),
        listSnapshots: unused,
        createSnapshot: unused,
        rollback: unused,
        preview: unused,
        primer: unused,
      }),
    ),
    Layer.provide(
      Layer.mock(TrellisCatalog)({
        syncNow: Effect.sync(() => {
          syncs += 1;
          return new Map();
        }),
      }),
    ),
    Layer.provide(
      Layer.mock(TextGeneration)({
        generateProjectName: (request) =>
          Effect.sync(() => {
            generated.push({ message: request.message, previousName: request.previousName });
            return { name: "Weather Plots", description: "Plotting local weather data." };
          }),
      }),
    ),
    Layer.provide(Layer.mock(OrchestrationEngineService)({})),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadDetailById: () => Effect.succeed(Option.some(thread as never)),
        getThreadShellById: () => Effect.succeed(Option.some(thread as never)),
        getProjectShellById: () =>
          Effect.succeed(
            Option.some({
              id: projectId,
              workspaceRoot: input.workspaceRoot ?? IDEA_PATH,
            } as never),
          ),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
  );
  return { layer, generated, described, syncs: () => syncs };
}

const userMessageSent = {
  type: "thread.message-sent",
  metadata: {},
  payload: { threadId, role: "user", streaming: false },
} as unknown as OrchestrationEvent;
const sessionReady = {
  type: "thread.session-set",
  metadata: {},
  payload: { threadId, session: { status: "ready" } },
} as unknown as OrchestrationEvent;

const run = (harness: ReturnType<typeof makeHarness>, events: ReadonlyArray<OrchestrationEvent>) =>
  Effect.gen(function* () {
    const naming = yield* TrellisNaming.TrellisNaming;
    for (const event of events) yield* naming.handleEvent(event);
    yield* naming.drain;
  }).pipe(Effect.provide(harness.layer));

const firstMessage: ReadonlyArray<Message> = [{ role: "user", text: "plot the weather" }];
const threeTurns: ReadonlyArray<Message> = [
  { role: "user", text: "plot the weather" },
  { role: "assistant", text: "done" },
  { role: "user", text: "add rain" },
  { role: "assistant", text: "done" },
  { role: "user", text: "and wind" },
  { role: "assistant", text: "done" },
];

describe("mayGenerateName", () => {
  it("names placeholders first and refines only generated or placeholder names", () => {
    expect(TrellisNaming.mayGenerateName("initial", "default")).toBe(true);
    expect(TrellisNaming.mayGenerateName("initial", "generated")).toBe(false);
    expect(TrellisNaming.mayGenerateName("refine", "generated")).toBe(true);
    expect(TrellisNaming.mayGenerateName("refine", "default")).toBe(true);
    for (const source of ["user", "agent", "derived", "refined", undefined]) {
      expect(TrellisNaming.mayGenerateName("initial", source)).toBe(false);
      expect(TrellisNaming.mayGenerateName("refine", source)).toBe(false);
    }
  });
});

describe("TrellisNaming", () => {
  it.effect("names a placeholder idea from the first user message and syncs", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ nameSource: "default", messages: firstMessage });
      yield* run(harness, [userMessageSent]);
      expect(harness.generated).toEqual([{ message: "plot the weather", previousName: undefined }]);
      expect(harness.described).toEqual([
        {
          target: IDEA_PATH,
          name: "Weather Plots",
          description: "Plotting local weather data.",
          source: "generated",
        },
      ]);
      expect(harness.syncs()).toBe(1);
    }),
  );

  it.effect("keeps names chosen by the user, an agent, the repository or a refinement", () =>
    Effect.gen(function* () {
      for (const nameSource of ["user", "agent", "derived", "refined"]) {
        const harness = makeHarness({ nameSource, messages: threeTurns });
        yield* run(harness, [userMessageSent, sessionReady]);
        expect(harness.generated).toEqual([]);
        expect(harness.described).toEqual([]);
      }
    }),
  );

  it.effect("does not rename from a later message or outside Trellis", () =>
    Effect.gen(function* () {
      const later = makeHarness({ nameSource: "default", messages: threeTurns });
      yield* run(later, [userMessageSent]);
      expect(later.generated).toEqual([]);

      const host = makeHarness({
        nameSource: "default",
        messages: firstMessage,
        workspaceRoot: "/home/me/code",
      });
      yield* run(host, [userMessageSent]);
      expect(host.generated).toEqual([]);
    }),
  );

  it.effect("refines from the conversation after the third turn, as a final name", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ nameSource: "generated", messages: threeTurns });
      yield* run(harness, [sessionReady, sessionReady]);
      expect(harness.generated).toHaveLength(1);
      expect(harness.generated[0]?.previousName).toBe("Idea");
      expect(harness.generated[0]?.message).toContain("and wind");
      expect(harness.described[0]?.source).toBe("refined");
    }),
  );

  it.effect("does not refine before the third turn or while a turn runs", () =>
    Effect.gen(function* () {
      const early = makeHarness({ nameSource: "generated", messages: firstMessage });
      yield* run(early, [sessionReady]);
      expect(early.generated).toEqual([]);

      const running = makeHarness({
        nameSource: "generated",
        messages: threeTurns,
        latestTurnState: "running",
      });
      yield* run(running, [sessionReady]);
      expect(running.generated).toEqual([]);
    }),
  );
});
