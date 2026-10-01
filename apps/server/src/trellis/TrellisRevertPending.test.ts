import { assert, it } from "@effect/vitest";
import { CommandId, EventId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { OrchestratorV2, ROLLBACK_PENDING_MESSAGE } from "../orchestration-v2/Orchestrator.ts";
import {
  createThread,
  rejection,
  sendMessage,
  TrellisOrchestratorTestLayer,
  writeEvent,
} from "./TrellisOrchestrator.testkit.ts";

// A rollback releases its restore lease between retries, so new turns in the
// thread are refused until it is done or has failed for good.

it.layer(TrellisOrchestratorTestLayer)("a pending revert", (it) => {
  it.effect("refuses new messages until the revert completes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const { threadId } = yield* createThread(
        "revert-pending",
        "/trellis/workspaces/ws-a/project/idea-1",
      );
      const setRollback = (completed: CommandId | null, label: string) =>
        Effect.gen(function* () {
          const thread = (yield* orchestrator.getThreadProjection(threadId)).thread;
          const now = yield* DateTime.now;
          yield* writeEvent({
            id: EventId.make(`revert-pending:${label}`),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: thread.providerInstanceId,
            occurredAt: now,
            payload: {
              ...thread,
              rollbackRequestId: CommandId.make("rollback-1"),
              rollbackCompletedRequestId: completed,
              updatedAt: now,
            },
          });
        });

      yield* setRollback(null, "started");
      assert.equal(yield* rejection(sendMessage(threadId, "during")), ROLLBACK_PENDING_MESSAGE);

      yield* setRollback(CommandId.make("rollback-1"), "completed");
      yield* sendMessage(threadId, "after");
    }),
  );
});
