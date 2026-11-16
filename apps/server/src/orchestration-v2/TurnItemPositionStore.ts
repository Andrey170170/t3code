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
      // `run_start` takes the run's unused first slot, ahead of its items, and appends once it is taken.
      readonly placement?: "append" | "run_start";
      // Keep an existing position even when it lies outside the run's band.
      readonly keepExisting?: boolean;
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
 * A run takes the next unused band when its first item arrives, so the timeline follows start
 * order: a queued run that starts late, and a message steered into it, land at the bottom.
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

    // The position with the item's projection before this batch, which may still be pending.
    const placedPosition = (threadId: ThreadId, turnItemId: TurnItemId) =>
      sql<{
        readonly ordinal: number;
        readonly runId: string | null;
        readonly status: string | null;
      }>`
        SELECT position.ordinal, item.run_id AS "runId", item.status
        FROM orchestration_v2_turn_item_positions AS position
        LEFT JOIN orchestration_v2_projection_turn_items AS item
          ON item.turn_item_id = position.turn_item_id
        WHERE position.thread_id = ${threadId} AND position.turn_item_id = ${turnItemId}
        LIMIT 1
      `.pipe(Effect.map((rows) => rows[0]));

    // The run's band: the batch's hint, else its other placed items' band, else the next free
    // band (never below its ordinal). Items without a run use band 0. 1000000 is BAND_SIZE.
    const bandOf = (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: TurnItemId;
      readonly runId: RunId | null;
      readonly runOrdinal: number | undefined;
      readonly runBand: number | undefined;
    }) => sql`
      SELECT CASE WHEN ${input.runId} IS NULL THEN 0 ELSE COALESCE(
        CAST(${input.runBand ?? null} AS INTEGER),
        (
          -- Positions, not projected ordinals: databases upgraded through the V2
          -- migration kept provider ordinals on projected items.
          SELECT MIN(position.ordinal)
          FROM orchestration_v2_projection_turn_items AS item
          JOIN orchestration_v2_turn_item_positions AS position
            ON position.thread_id = item.thread_id
            AND position.turn_item_id = item.turn_item_id
          WHERE item.thread_id = ${input.threadId}
            AND item.run_id = ${input.runId}
            AND item.turn_item_id != ${input.turnItemId}
            -- A queued message holds its submission slot, not its run's band.
            AND NOT (item.type = 'user_message' AND item.status = 'pending')
        ) / 1000000,
        MAX(
          COALESCE(
            CAST(${input.runOrdinal ?? null} AS INTEGER),
            (
              SELECT ordinal
              FROM orchestration_v2_projection_runs
              WHERE thread_id = ${input.threadId} AND run_id = ${input.runId}
            ),
            0
          ),
          COALESCE(
            (
              SELECT MAX(ordinal)
              FROM orchestration_v2_turn_item_positions
              WHERE thread_id = ${input.threadId}
            ) / 1000000 + 1,
            0
          )
        )
      ) END AS value
    `;

    const allocate: TurnItemPositionStoreV2Shape["allocate"] =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(
        function* ({
          threadId,
          turnItemId,
          runId,
          runOrdinal,
          runBand,
          placement = "append",
          keepExisting = false,
        }) {
          const band = { threadId, turnItemId, runId, runOrdinal, runBand };
          const placed = yield* placedPosition(threadId, turnItemId);
          if (placed !== undefined) {
            // Only an item that was queued, changed run, or is new in this batch can sit outside
            // its run's band: a steer that missed its turn moves into the run it starts.
            const mayHaveMoved =
              placed.status === null || placed.status === "pending" || placed.runId !== runId;
            if (keepExisting || runId === null || !mayHaveMoved) return placed.ordinal;
            const target =
              runBand ?? (yield* sql<{ readonly value: number }>`${bandOf(band)}`)[0]?.value;
            if (target === undefined || positionBand(placed.ordinal) === target) {
              return placed.ordinal;
            }
            yield* sql`
              UPDATE orchestration_v2_turn_item_positions
              SET ordinal = (
                SELECT COALESCE(MAX(ordinal), ${target} * 1000000) + 1
                FROM orchestration_v2_turn_item_positions
                WHERE thread_id = ${threadId}
                  AND ordinal >= ${target} * 1000000
                  AND ordinal < (${target} + 1) * 1000000
              )
              WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
            `;
            return (yield* existingPosition(threadId, turnItemId)) ?? placed.ordinal;
          }

          yield* sql`
            INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
            WITH band AS (${bandOf(band)})
            , taken AS (
              SELECT MIN(ordinal) AS low, MAX(ordinal) AS high
              FROM orchestration_v2_turn_item_positions, band
              WHERE thread_id = ${threadId}
                AND ordinal >= band.value * 1000000
                AND ordinal < (band.value + 1) * 1000000
            )
            SELECT
              ${threadId},
              ${turnItemId},
              ${
                placement === "run_start"
                  ? sql`CASE WHEN COALESCE(taken.low, band.value * 1000000 + 1) > band.value * 1000000 THEN band.value * 1000000 ELSE taken.high + 1 END`
                  : sql`COALESCE(taken.high, band.value * 1000000) + 1`
              }
            FROM band, taken
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
        },
        (effect, { threadId, turnItemId }) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isTurnItemPositionStoreError(cause)
                ? cause
                : new TurnItemPositionStoreError({ threadId, turnItemId, cause }),
            ),
          ),
      );

    return TurnItemPositionStoreV2.of({
      allocate,
      // Per-event normalization shares the enclosing orchestration span.
      normalize: Effect.fnUntraced(function* (item, hints = {}) {
        return yield* allocate({
          threadId: item.threadId,
          turnItemId: item.id,
          runId: item.runId,
          // Queued steers keep their submission order until their run starts (see Orchestrator).
          keepExisting: item.status === "pending",
          ...hints,
        }).pipe(Effect.map((ordinal) => (item.ordinal === ordinal ? item : { ...item, ordinal })));
      }),
    });
  }),
);
