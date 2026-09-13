import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import LegacyAgentOrigin from "./050_ProjectionMessageAgentOrigin.ts";
import TaskOperations from "./052_TaskOperations.ts";

const agentOriginJson = '{"threadId":"source","operationId":"operation-1"}';
const contextJson = '{"version":1,"records":[]}';

for (const baseline of ["fresh", "upstream-51", "local-50", "local-52"] as const) {
  it.effect(`upgrades ${baseline} while preserving data and migration history`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const local = baseline === "local-50" || baseline === "local-52";

      if (baseline !== "fresh") {
        yield* runMigrations({ toMigrationInclusive: 49 });
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json,
            linked_pull_request_json, created_at, updated_at
          ) VALUES (
            'thread-1', 'project-1', 'Existing thread',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            '{"repository":"acme/widgets","number":42,"url":"https://github.com/acme/widgets/pull/42"}',
            '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z'
          )
        `;
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
          ) VALUES (
            'message-1', 'thread-1', NULL, 'user', 'Existing prompt', 0,
            '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z'
          )
        `;

        if (local) {
          yield* LegacyAgentOrigin;
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name)
            VALUES (50, 'ProjectionMessageAgentOrigin')
          `;
          yield* sql`
            UPDATE projection_thread_messages SET agent_origin_json = ${agentOriginJson}
            WHERE message_id = 'message-1'
          `;
          if (baseline === "local-52") {
            yield* TaskOperations;
            yield* sql`
              INSERT INTO effect_sql_migrations (migration_id, name)
              VALUES (52, 'TaskOperations')
            `;
            yield* sql`
              INSERT INTO agent_task_operations (
                source_thread_id, operation_id, request_hash, target_thread_id,
                create_command_json, created_at, result_sequence
              ) VALUES (
                'source', 'operation-1', 'request-hash', 'thread-1',
                '{"command":"retained"}', '2026-09-08T00:00:00.000Z', 7
              )
            `;
          }
        } else {
          yield* runMigrations({ toMigrationInclusive: 51 });
          yield* sql`
            UPDATE projection_thread_messages SET context_json = ${contextJson}
            WHERE message_id = 'message-1'
          `;
          // An upstream user may have unlinked a migrated PR; reconciliation
          // must not backfill it again from the retained legacy column.
          yield* sql`DELETE FROM projection_thread_pull_requests WHERE thread_id = 'thread-1'`;
        }
      }

      const executed = yield* runMigrations();
      assert.equal(executed.at(-1)?.[0], 53);
      assert.deepStrictEqual(yield* runMigrations(), []);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      assert.ok(columns.some((column) => column.name === "agent_origin_json"));
      assert.ok(columns.some((column) => column.name === "context_json"));
      const links = yield* sql<{ readonly repository: string; readonly number: number }>`
        SELECT repository, number FROM projection_thread_pull_requests
      `;
      assert.deepStrictEqual(links, local ? [{ repository: "acme/widgets", number: 42 }] : []);
      const tasks = yield* sql`
        SELECT request_hash, create_command_json, result_sequence FROM agent_task_operations
      `;
      assert.deepStrictEqual(
        tasks,
        baseline === "local-52"
          ? [
              {
                request_hash: "request-hash",
                create_command_json: '{"command":"retained"}',
                result_sequence: 7,
              },
            ]
          : [],
      );

      if (baseline !== "fresh") {
        const messages = yield* sql`
          SELECT text, agent_origin_json, context_json FROM projection_thread_messages
        `;
        assert.deepStrictEqual(messages, [
          {
            text: "Existing prompt",
            agent_origin_json: local ? agentOriginJson : null,
            context_json: local ? null : contextJson,
          },
        ]);
        const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id = 50
        `;
        assert.deepStrictEqual(recorded, [
          {
            migration_id: 50,
            name: local ? "ProjectionMessageAgentOrigin" : "ProjectionThreadPullRequests",
          },
        ]);
      }
      if (baseline === "local-52") {
        assert.deepStrictEqual(executed, [[53, "ReconcileForkSchema"]]);
        const skipped = yield* sql`
          SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 51
        `;
        assert.deepStrictEqual(skipped, []);
      }
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
}
