import { assert, it } from "@effect/vitest";
import { CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { rollbackInFlight } from "./CheckpointRollbackService.ts";
import type { EffectOutboxV2Shape } from "./EffectOutbox.ts";

const requestId = CommandId.make("rollback-1");
const pending = {
  rollbackRequestId: requestId,
  rollbackCompletedRequestId: null,
  rollbackFailure: null,
};
const outboxWith = (status: "pending" | "running" | "failed" | "succeeded") =>
  Option.some({
    listByCommandId: () =>
      Effect.succeed([{ request: { type: "provider-thread.rollback" }, status } as never]),
  } as unknown as EffectOutboxV2Shape);

// A second rollback is refused while the first can still retry, and a
// rollback whose failure receipt was lost does not stay in flight.
it.effect("a rollback is in flight until it completes, fails or its effect settles", () =>
  Effect.gen(function* () {
    assert.isTrue(yield* rollbackInFlight(pending, outboxWith("pending")));
    assert.isTrue(yield* rollbackInFlight(pending, outboxWith("running")));
    assert.isFalse(yield* rollbackInFlight(pending, outboxWith("failed")));
    assert.isTrue(yield* rollbackInFlight(pending, Option.none()));
    assert.isFalse(
      yield* rollbackInFlight(
        { ...pending, rollbackCompletedRequestId: requestId },
        outboxWith("pending"),
      ),
    );
    assert.isFalse(
      yield* rollbackInFlight(
        { ...pending, rollbackFailure: { requestId, message: "failed" } },
        outboxWith("pending"),
      ),
    );
    // Servers that predate completion records never set the field.
    assert.isFalse(
      yield* rollbackInFlight({ rollbackRequestId: requestId }, outboxWith("pending")),
    );
  }),
);
