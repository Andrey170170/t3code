import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import MessageAgentOrigin from "./050_ProjectionMessageAgentOrigin.ts";
import ThreadPullRequests from "./050_ProjectionThreadPullRequests.ts";
import ThreadMessageContext from "./051_ProjectionThreadMessageContext.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The fork used 50 for agent origin and jumped to 52 for tasks. The migrator
  // skips IDs below the latest recorded ID, so preserve that history and repair
  // the missing upstream schema here instead of renumbering applied migrations.
  const pullRequestTables = yield* sql`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_thread_pull_requests'
  `;
  if (pullRequestTables.length === 0) {
    yield* ThreadPullRequests;
  }
  yield* ThreadMessageContext;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!columns.some((column) => column.name === "agent_origin_json")) {
    yield* MessageAgentOrigin;
  }
});
