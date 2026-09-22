import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import ThreadTitleState from "./052_ProjectionThreadTitleState.ts";

const titleStateJson = '{"source":"manual","version":"rename-1","needsRefinement":false}';

for (const baseline of ["fresh", "fork-53", "upstream-52"] as const) {
  it.effect(`reconciles title state and tasks from ${baseline} without rewriting history`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      if (baseline !== "fresh") {
        yield* runMigrations({ toMigrationInclusive: baseline === "fork-53" ? 53 : 51 });
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, created_at, updated_at
          ) VALUES (
            'thread-1', 'project-1', 'Existing title',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z'
          )
        `;
        if (baseline === "upstream-52") {
          yield* ThreadTitleState;
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name)
            VALUES (52, 'ProjectionThreadTitleState')
          `;
          yield* sql`
            UPDATE projection_threads SET title_state_json = ${titleStateJson}
            WHERE thread_id = 'thread-1'
          `;
        } else {
          yield* sql`
            INSERT INTO agent_task_operations (
              source_thread_id, operation_id, request_hash, target_thread_id,
              create_command_json, created_at, result_sequence
            ) VALUES (
              'source', 'operation-1', 'request-hash', 'thread-1',
              '{"command":"retained"}', '2026-09-13T00:00:00.000Z', 7
            )
          `;
        }
      }

      const historyBefore =
        baseline === "fresh"
          ? []
          : yield* sql`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      const executed = yield* runMigrations({ toMigrationInclusive: 54 });
      assert.equal(executed.at(-1)?.[0], 54);
      if (baseline === "fork-53") {
        assert.deepStrictEqual(executed, [[54, "ReconcileThreadTitleState"]]);
      }
      if (baseline === "upstream-52") {
        assert.deepStrictEqual(executed, [
          [53, "ReconcileForkSchema"],
          [54, "ReconcileThreadTitleState"],
        ]);
      }
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 54 }), []);

      const historyAfter = yield* sql`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(historyAfter.slice(0, historyBefore.length), historyBefore);
      const threads = yield* sql`SELECT title, title_state_json FROM projection_threads`;
      assert.deepStrictEqual(
        threads,
        baseline === "fresh"
          ? []
          : [
              {
                title: "Existing title",
                title_state_json: baseline === "upstream-52" ? titleStateJson : null,
              },
            ],
      );
      const tasks = yield* sql`
        SELECT request_hash, create_command_json, result_sequence FROM agent_task_operations
      `;
      assert.deepStrictEqual(
        tasks,
        baseline === "fork-53"
          ? [
              {
                request_hash: "request-hash",
                create_command_json: '{"command":"retained"}',
                result_sequence: 7,
              },
            ]
          : [],
      );
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      assert.ok(columns.some((column) => column.name === "agent_origin_json"));
      assert.ok(columns.some((column) => column.name === "context_json"));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
}
