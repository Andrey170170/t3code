import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ThreadTitleState from "./Migrations/052_ProjectionThreadTitleState.ts";
import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import AutoSettleDisabledAt from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";

const MAIN_LEDGER = [
  [50, "ProjectionThreadPullRequests"],
  [51, "ProjectionThreadMessageContext"],
  [52, "ProjectionThreadTitleState"],
  [53, "PullRequestFilesViewed"],
  [54, "ProjectionThreadsAutoSettleDisabledAt"],
] as const;

// Fork reconcile migrations that applied main's 52–54 schema under fork ids.
const FORK_RECONCILES = [
  { id: 54, name: "ReconcileThreadTitleState", main: 52, migration: ThreadTitleState },
  { id: 55, name: "ReconcilePullRequestFilesViewed", main: 53, migration: PullRequestFilesViewed },
  { id: 56, name: "ReconcileAutoSettleSchema", main: 54, migration: AutoSettleDisabledAt },
] as const;

const FORK_BASE = new Map<number, string>([
  [50, "ProjectionMessageAgentOrigin"],
  [52, "TaskOperations"],
  [53, "ReconcileForkSchema"],
]);

/**
 * Databases from the dev_vm fork recorded fork migrations at ids 50–56, which
 * would mask main's OrchestrationV2 (55) forever. `ReconcileForkSchema` (53)
 * already applied main's 50–51 schema; apply any of main's 52–54 a fork
 * reconcile did not, then rewrite the ledger to main's so later ids run.
 * Fork leftovers (agent_origin_json, agent_task_operations) are unused and kept.
 */
export const reconcileForkMigrationLedger = Effect.fn("reconcileForkMigrationLedger")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
        `;
      if (tables.length === 0) return [];
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 50
        `;
      if (!history.some((row) => row.migration_id === 53 && row.name === "ReconcileForkSchema")) {
        return [];
      }
      const recorded = new Map(history.map((row) => [row.migration_id, row.name]));
      const known = (id: number, name: string | undefined) =>
        FORK_BASE.get(id) === name ||
        FORK_RECONCILES.some((entry) => entry.id === id && entry.name === name);
      if (history.some((row) => !known(row.migration_id, row.name))) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot reconcile a fork database with unexpected migrations at or above 50.",
        });
      }

      const executed: Array<readonly [number, string]> = [];
      for (const entry of FORK_RECONCILES) {
        if (recorded.get(entry.id) === entry.name) continue;
        yield* entry.migration;
        executed.push(MAIN_LEDGER.find(([id]) => id === entry.main)!);
      }
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 50`;
      for (const [id, name] of MAIN_LEDGER) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
      }
      return executed;
    }),
  );
});
