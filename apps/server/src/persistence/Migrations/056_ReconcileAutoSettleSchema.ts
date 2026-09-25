import * as Effect from "effect/Effect";

import TaskOperations from "./052_TaskOperations.ts";
import AutoSettleDisabledAt from "./054_ProjectionThreadsAutoSettleDisabledAt.ts";

export default Effect.gen(function* () {
  // Upstream 54 skips the fork's task-table reconciliation at the same ID.
  // Preserve both recorded histories and fill the missing schema at a new ID.
  yield* TaskOperations;
  yield* AutoSettleDisabledAt;
});
