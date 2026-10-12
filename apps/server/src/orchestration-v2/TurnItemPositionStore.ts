import { OrchestrationV2TurnItem, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class TurnItemPositionStoreError extends Schema.TaggedError<TurnItemPositionStoreError>()(
  "TurnItemPositionStoreError",
  {
    threadId: ThreadId,
    turnItemId: TurnItemId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isTurnItemPositionStoreError = Schema.is(TurnItemPositionStoreError);

/** Positions per band. A run's items share one band, so they stay together on the timeline. */
const BAND_SIZE = 1_000_000;

/** The band a position belongs to. */
export const positionBand = (ordinal: number) => Math.floor(ordinal / BAND_SIZE);

/** Hints from the caller's batch, whose earlier items are not projected yet. */
export interface TurnItemPositionHints {
  /** The run's ordinal, when the batch creates or updates the run. */
  readonly runOrdinal?: number;
  /** The band an earlier item of the same run took in this batch. */
  readonly runBand?: number;
}

export interface TurnItemPositionStoreV2Shape {
  readonly allocate: (
    input: {
      readonly threadId: ThreadId;
      readonly turnItemId: TurnItemId;
      readonly runId: RunId | null;
    } & TurnItemPositionHints,
  ) => Effect.Effect<number, TurnItemPositionStoreError>;
  readonly normalize: (
    item: OrchestrationV2TurnItem,
    hints?: TurnItemPositionHints,
  ) => Effect.Effect<OrchestrationV2TurnItem, TurnItemPositionStoreError>;
}

export class TurnItemPositionStoreV2 extends Context.Service<
  TurnItemPositionStoreV2,
  TurnItemPositionStoreV2Shape
>()("t3/orchestration-v2/TurnItemPositionStore/TurnItemPositionStoreV2") {}

/**
 * Gives each turn item a stable timeline position the first time it is seen. A run takes its
 * band when its first item arrives, after every band already used, so the timeline follows the
 * order runs actually started: a queued run that starts after a later one (delegated results
 * jump the queue) and a message steered into it land at the bottom, not above finished runs.
 * The band is never below the run's ordinal, so runs that start in order keep `ordinal` bands.
 */
export const layer: Layer.Layer<TurnItemPositionStoreV2, never, SqlClient.SqlClient> = Layer.effect(
  TurnItemPositionStoreV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const existingPosition = (threadId: ThreadId, turnItemId: TurnItemId) =>
      sql<{ readonly ordinal: number }>`
        SELECT ordinal
        FROM orchestration_v2_turn_item_positions
        WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
        LIMIT 1
      `.pipe(Effect.map((rows) => rows[0]?.ordinal));

    const allocate: TurnItemPositionStoreV2Shape["allocate"] = ({
      threadId,
      turnItemId,
      runId,
      runOrdinal,
      runBand,
    }) =>
      Effect.gen(function* () {
        // The run's band: the batch's hint, else its placed items' band, else the next free band
        // (never below its ordinal). Items without a run use band 0. 1000000 is BAND_SIZE.
        yield* sql`
          INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
          WITH band AS (
            SELECT CASE WHEN ${runId} IS NULL THEN 0 ELSE COALESCE(
              CAST(${runBand ?? null} AS INTEGER),
              (
                SELECT MIN(ordinal)
                FROM orchestration_v2_projection_turn_items
                WHERE thread_id = ${threadId} AND run_id = ${runId}
              ) / 1000000,
              MAX(
                COALESCE(
                  CAST(${runOrdinal ?? null} AS INTEGER),
                  (
                    SELECT ordinal
                    FROM orchestration_v2_projection_runs
                    WHERE thread_id = ${threadId} AND run_id = ${runId}
                  ),
                  0
                ),
                COALESCE(
                  (
                    SELECT MAX(ordinal)
                    FROM orchestration_v2_turn_item_positions
                    WHERE thread_id = ${threadId}
                  ) / 1000000 + 1,
                  0
                )
              )
            ) END AS value
          )
          SELECT
            ${threadId},
            ${turnItemId},
            COALESCE(
              (
                SELECT MAX(ordinal)
                FROM orchestration_v2_turn_item_positions
                WHERE thread_id = ${threadId}
                  AND ordinal >= band.value * 1000000
                  AND ordinal < (band.value + 1) * 1000000
              ),
              band.value * 1000000
            ) + 1
          FROM band
          WHERE true
          ON CONFLICT(thread_id, turn_item_id) DO NOTHING
        `;
        const ordinal = yield* existingPosition(threadId, turnItemId);
        if (ordinal === undefined) {
          return yield* new TurnItemPositionStoreError({
            threadId,
            turnItemId,
            cause: "Position allocation returned no row.",
          });
        }
        return ordinal;
      }).pipe(
        Effect.mapError((cause) =>
          isTurnItemPositionStoreError(cause)
            ? cause
            : new TurnItemPositionStoreError({ threadId, turnItemId, cause }),
        ),
      );

    return TurnItemPositionStoreV2.of({
      allocate,
      normalize: (item, hints = {}) =>
        allocate({
          threadId: item.threadId,
          turnItemId: item.id,
          runId: item.runId,
          ...hints,
        }).pipe(Effect.map((ordinal) => (item.ordinal === ordinal ? item : { ...item, ordinal }))),
    });
  }),
);
