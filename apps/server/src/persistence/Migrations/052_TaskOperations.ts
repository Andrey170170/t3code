import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_task_operations (
      source_thread_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      target_thread_id TEXT NOT NULL,
      create_command_json TEXT,
      created_at TEXT NOT NULL,
      result_sequence INTEGER,
      PRIMARY KEY (source_thread_id, operation_id)
    )
  `;
});
