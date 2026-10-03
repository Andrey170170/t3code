import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

const FORK_LEDGER = [
  [50, "ProjectionMessageAgentOrigin"],
  [52, "TaskOperations"],
  [53, "ReconcileForkSchema"],
  [54, "ReconcileThreadTitleState"],
  [55, "ReconcilePullRequestFilesViewed"],
  [56, "ReconcileAutoSettleSchema"],
] as const;

// Applies main's schema through `schemaThrough` and records `ledger` through `forkThrough`.
const seedFork = (
  schemaThrough: number,
  forkThrough: number,
  ledger: ReadonlyArray<readonly [number, string]> = FORK_LEDGER,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: schemaThrough });
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 50`;
    for (const [id, name] of ledger.filter(([id]) => id <= forkThrough)) {
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
    }
  });

const readLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

describe("fork migration ledger", () => {
  it.effect("rewrites a current fork ledger so V2 migrations run", () =>
    Effect.gen(function* () {
      yield* seedFork(54, 56);
      assert.deepStrictEqual(yield* runMigrations(), [
        [55, "OrchestrationV2"],
        [56, "RemoveRedundantProjectionIndexes"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* readLedger, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("accepts a fork ledger that recorded 50 and 51 under main's names", () =>
    Effect.gen(function* () {
      yield* seedFork(54, 56, [
        [50, "ProjectionThreadPullRequests"],
        [51, "ProjectionThreadMessageContext"],
        ...FORK_LEDGER.slice(1),
      ]);
      assert.deepStrictEqual(yield* runMigrations(), [
        [55, "OrchestrationV2"],
        [56, "RemoveRedundantProjectionIndexes"],
      ]);
      assert.deepStrictEqual(yield* readLedger, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("applies main schema an older fork ledger never reconciled", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedFork(52, 54);
      assert.deepStrictEqual(yield* runMigrations(), [
        [53, "PullRequestFilesViewed"],
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
        [55, "OrchestrationV2"],
        [56, "RemoveRedundantProjectionIndexes"],
      ]);
      assert.deepStrictEqual(yield* readLedger, migrationManifest);
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.ok(columns.some((column) => column.name === "auto_settle_disabled_at"));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
