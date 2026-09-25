import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import ThreadTitleState from "./052_ProjectionThreadTitleState.ts";
import PullRequestFilesViewed from "./053_PullRequestFilesViewed.ts";
import AutoSettleDisabledAt from "./054_ProjectionThreadsAutoSettleDisabledAt.ts";
import ReconcileAutoSettleSchema from "./056_ReconcileAutoSettleSchema.ts";

for (const baseline of ["fresh", "fork-54", "fork-55", "upstream-53", "upstream-54"] as const) {
  it.effect(`reconciles auto-settle and fork schema from ${baseline} without losing data`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (baseline !== "fresh") {
        yield* runMigrations({
          toMigrationInclusive: baseline === "fork-54" ? 54 : baseline === "fork-55" ? 55 : 51,
        });
        if (baseline === "upstream-53" || baseline === "upstream-54") {
          yield* ThreadTitleState;
          yield* PullRequestFilesViewed;
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name)
            VALUES (52, 'ProjectionThreadTitleState'), (53, 'PullRequestFilesViewed')
          `;
          yield* sql`
            INSERT INTO pull_request_files_viewed (
              provider, host, repository, number, viewer, path, revision, viewed_at
            ) VALUES (
              'forgejo', 'git.example.com', 'acme/widgets', 42, 'reader',
              'src/main.ts', 'revision-1', '2026-09-22T00:00:00.000Z'
            )
          `;
        }
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at,
            context_json
          ) VALUES (
            'message-1', 'thread-1', NULL, 'user', 'Retained prompt', 0,
            '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z', '{"version":1}'
          )
        `;
        if (baseline === "fork-54" || baseline === "fork-55") {
          yield* sql`
            UPDATE projection_thread_messages SET agent_origin_json = '{"threadId":"source"}'
            WHERE message_id = 'message-1'
          `;
        }
      }

      if (baseline !== "fresh") {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at
          ) VALUES (
            'thread-1', 'project-1', 'Retained title', '{}', 'full-access', '2026-09-25', '2026-09-25'
          )
        `;
      }
      if (baseline === "upstream-54") {
        yield* AutoSettleDisabledAt;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (54, 'ProjectionThreadsAutoSettleDisabledAt')`;
        yield* sql`UPDATE projection_threads SET auto_settle_disabled_at = '2026-09-25'`;
      }
      if (baseline === "fork-54" || baseline === "fork-55") {
        yield* sql`INSERT INTO agent_task_operations (
          source_thread_id, operation_id, request_hash, target_thread_id, created_at
        ) VALUES ('thread-1', 'operation-1', 'hash', 'thread-2', '2026-09-25')`;
      }

      const historyBefore =
        baseline === "fresh"
          ? []
          : yield* sql`
              SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
            `;
      const executed = yield* runMigrations();
      assert.equal(executed.at(-1)?.[0], 56);
      const lastBaselineId =
        baseline === "fresh"
          ? 0
          : baseline === "fork-55"
            ? 55
            : baseline === "upstream-53"
              ? 53
              : 54;
      assert.ok(executed.every(([id]) => id > lastBaselineId));
      yield* ReconcileAutoSettleSchema;
      yield* ReconcileAutoSettleSchema;
      assert.deepStrictEqual(yield* runMigrations(), []);
      const historyAfter = yield* sql`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(historyAfter.slice(0, historyBefore.length), historyBefore);
      const viewedFiles = yield* sql`SELECT path, revision FROM pull_request_files_viewed`;
      assert.deepStrictEqual(
        viewedFiles,
        baseline === "upstream-53" || baseline === "upstream-54"
          ? [{ path: "src/main.ts", revision: "revision-1" }]
          : [],
      );
      const messages = yield* sql`
        SELECT text, context_json, agent_origin_json FROM projection_thread_messages
      `;
      assert.deepStrictEqual(
        messages,
        baseline === "fresh"
          ? []
          : [
              {
                text: "Retained prompt",
                context_json: '{"version":1}',
                agent_origin_json:
                  baseline === "fork-54" || baseline === "fork-55" ? '{"threadId":"source"}' : null,
              },
            ],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT operation_id, request_hash FROM agent_task_operations`,
        baseline === "fork-54" || baseline === "fork-55"
          ? [{ operation_id: "operation-1", request_hash: "hash" }]
          : [],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT title, auto_settle_disabled_at FROM projection_threads`,
        baseline === "fresh"
          ? []
          : [
              {
                title: "Retained title",
                auto_settle_disabled_at: baseline === "upstream-54" ? "2026-09-25" : null,
              },
            ],
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM projection_thread_pull_requests`, []);
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.ok(columns.some((column) => column.name === "title_state_json"));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
}
