import { ThreadId, TrellisError } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import { Trellis, type TrellisSnapshot } from "./Trellis.ts";
import * as TrellisBaseline from "./TrellisBaseline.ts";

const ROOT = "/trellis";
const CWD = `${ROOT}/workspaces/ws-1/project/idea-1`;
const threadId = ThreadId.make("thread-1");

function makeHarness(input: {
  readonly snapshots: Array<TrellisSnapshot>;
  readonly failures?: { list?: number; create?: number };
}) {
  const failures = { list: input.failures?.list ?? 0, create: input.failures?.create ?? 0 };
  const created: Array<string> = [];
  const env = { root: ROOT, bin: "trellis", shimDir: null };
  const unused = () => Effect.die(new Error("unused"));
  const fail = () => Effect.fail(new TrellisError({ message: "Trellis is restarting" }));
  const layer = TrellisBaseline.layer.pipe(
    Layer.provide(
      Layer.succeed(Trellis, {
        current: Effect.succeed(env),
        refresh: Effect.succeed(env),
        expectedRoot: Effect.succeed(ROOT),
        bin: "trellis",
        listWorkspaces: unused,
        listProjects: unused,
        createIdea: unused,
        createProject: unused,
        describe: unused,
        find: unused,
        resolve: unused,
        listSnapshots: () =>
          failures.list-- > 0 ? fail() : Effect.sync(() => [...input.snapshots]),
        createSnapshot: ({ thread, turn }) =>
          failures.create-- > 0
            ? fail()
            : Effect.sync(() => {
                created.push(turn);
                const snapshot = {
                  id: `snap-${input.snapshots.length + 1}`,
                  workspace_id: "ws-1",
                  seq: input.snapshots.length + 1,
                  kind: "turn",
                  thread,
                  turn,
                  created_at: 0,
                };
                input.snapshots.push(snapshot);
                return snapshot;
              }),
        rollback: unused,
        preview: unused,
        primer: unused,
      }),
    ),
  );
  return { layer, created };
}

const snapshot = (turn: string): TrellisSnapshot => ({
  id: `snap-${turn}`,
  workspace_id: "ws-1",
  seq: 1,
  kind: "turn",
  thread: threadId,
  turn,
  created_at: 0,
});

const ensureTimes = (harness: ReturnType<typeof makeHarness>, times: number) =>
  Effect.gen(function* () {
    const baseline = yield* TrellisBaseline.TrellisBaseline;
    const results: Array<"ok" | string> = [];
    for (let index = 0; index < times; index += 1) {
      const result = yield* baseline.ensure(threadId, CWD).pipe(Effect.result);
      results.push(result._tag === "Success" ? "ok" : result.failure.message);
    }
    return results;
  }).pipe(Effect.provide(harness.layer));

describe("TrellisBaseline", () => {
  it.effect("takes the baseline once for a new thread", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ snapshots: [] });
      expect(yield* ensureTimes(harness, 2)).toEqual(["ok", "ok"]);
      expect(harness.created).toEqual(["baseline"]);
    }),
  );

  it.effect("reports a failed capture and takes it at the next attempt", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ snapshots: [], failures: { create: 1 } });
      expect(yield* ensureTimes(harness, 2)).toEqual(["Trellis is restarting", "ok"]);
      expect(harness.created).toEqual(["baseline"]);
    }),
  );

  it.effect("never blocks once the baseline exists, even if Trellis later fails", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ snapshots: [snapshot("baseline")] });
      const results = yield* Effect.gen(function* () {
        const baseline = yield* TrellisBaseline.TrellisBaseline;
        yield* baseline.ensure(threadId, CWD);
        return yield* baseline.ensure(threadId, CWD).pipe(Effect.result);
      }).pipe(Effect.provide(harness.layer));
      expect(results._tag).toBe("Success");
      expect(harness.created).toEqual([]);
    }),
  );

  it.effect("does not record a late baseline for a thread whose turns already ran", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ snapshots: [snapshot("turn-1")] });
      expect(yield* ensureTimes(harness, 1)).toEqual(["ok"]);
      expect(harness.created).toEqual([]);
    }),
  );
});
