import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ThreadTitleState from "./052_ProjectionThreadTitleState.ts";
import TaskOperations from "./052_TaskOperations.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Fork databases already recorded 52 for tasks and 53 for reconciliation;
  // upstream databases recorded 52 for title state. Preserve both histories.
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "title_state_json")) {
    yield* ThreadTitleState;
  }
  yield* TaskOperations;
});
