import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import { makeTestTrellis, Trellis, TRELLIS_DISABLED_MESSAGE } from "./Trellis.ts";
import * as TrellisPtyAdapter from "./TrellisPtyAdapter.ts";

const spawnInput = (cwd: string): PtyAdapter.PtySpawnInput => ({
  shell: "bash",
  cwd,
  cols: 80,
  rows: 24,
  env: {},
});

// Trellis is off; only its remembered root is known.
const harness = () => {
  const spawned: Array<PtyAdapter.PtySpawnInput> = [];
  const layer = TrellisPtyAdapter.layer.pipe(
    Layer.provide(
      Layer.succeed(PtyAdapter.PtyAdapter, {
        spawn: (input) =>
          Effect.sync(() => {
            spawned.push(input);
            return {} as never;
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        Trellis,
        makeTestTrellis({ env: null, expectedRoots: Effect.succeed(["/trellis"]) }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { layer, spawned };
};

it.effect("refuses terminals in Trellis projects while the integration is off", () =>
  Effect.gen(function* () {
    const { layer, spawned } = harness();
    const error = yield* Effect.gen(function* () {
      const adapter = yield* PtyAdapter.PtyAdapter;
      return yield* adapter
        .spawn(spawnInput("/trellis/workspaces/ws-1/project/idea"))
        .pipe(Effect.flip);
    }).pipe(Effect.provide(layer));
    expect(error.message).toBe(TRELLIS_DISABLED_MESSAGE);
    expect(spawned).toEqual([]);
  }),
);

it.effect("spawns host terminals elsewhere unchanged", () =>
  Effect.gen(function* () {
    const { layer, spawned } = harness();
    yield* Effect.gen(function* () {
      const adapter = yield* PtyAdapter.PtyAdapter;
      yield* adapter.spawn(spawnInput("/"));
    }).pipe(Effect.provide(layer));
    expect(spawned.map((input) => input.shell)).toEqual(["bash"]);
  }),
);
