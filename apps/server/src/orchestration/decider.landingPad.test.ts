import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProviderInstanceId,
  ThreadId,
  TRELLIS_LANDING_PAD_PROJECT_ID,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";

// The Trellis landing pad only holds new-idea drafts; see promoteIdeaDraft in ws.ts.
const withLandingPad = projectEvent(createEmptyReadModel(now), {
  sequence: 1,
  eventId: EventId.make("evt-landing-pad"),
  aggregateKind: "project",
  aggregateId: TRELLIS_LANDING_PAD_PROJECT_ID,
  type: "project.created",
  occurredAt: now,
  commandId: CommandId.make("cmd-landing-pad"),
  causationEventId: null,
  correlationId: CommandId.make("cmd-landing-pad"),
  metadata: {},
  payload: {
    projectId: TRELLIS_LANDING_PAD_PROJECT_ID,
    title: "New idea",
    workspaceRoot: "/t3/state/trellis-landing-pad",
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  },
});

it.effect("refuses threads in, and deletion of, the Trellis landing pad", () =>
  Effect.gen(function* () {
    const readModel = yield* withLandingPad;
    const createError = yield* Effect.flip(
      decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create"),
          threadId: ThreadId.make("thread-1"),
          projectId: TRELLIS_LANDING_PAD_PROJECT_ID,
          title: "Thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        readModel,
      }),
    );
    expect(createError.message).toContain("landing pad");
    const deleteError = yield* Effect.flip(
      decideOrchestrationCommand({
        command: {
          type: "project.delete",
          commandId: CommandId.make("cmd-project-delete"),
          projectId: TRELLIS_LANDING_PAD_PROJECT_ID,
          force: true,
        },
        readModel,
      }),
    );
    expect(deleteError.message).toContain("landing pad");
  }).pipe(Effect.provide(NodeServices.layer)),
);
