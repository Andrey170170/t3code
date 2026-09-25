/**
 * TrellisPtyAdapter - runs terminals whose cwd is a Trellis project path
 * inside the workspace container, through `trellis exec`.
 *
 * Wraps the host PtyAdapter; other terminals are spawned unchanged.
 *
 * @module trellis/TrellisPtyAdapter
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import { isTrellisManagedPath, Trellis, type TrellisEnv } from "./Trellis.ts";

/** The spawn input for a terminal in `input.cwd`: a login bash inside the workspace. */
export function trellisTerminalSpawnInput(
  env: TrellisEnv | null,
  input: PtyAdapter.PtySpawnInput,
): PtyAdapter.PtySpawnInput {
  if (env === null || !isTrellisManagedPath(env.root, input.cwd)) return input;
  return {
    ...input,
    shell: env.bin,
    args: ["exec", "--tty", "--cwd", input.cwd, "--", "bash", "-l"],
  };
}

export const layer = Layer.effect(
  PtyAdapter.PtyAdapter,
  Effect.gen(function* () {
    const host = yield* PtyAdapter.PtyAdapter;
    const trellis = yield* Trellis;
    return PtyAdapter.PtyAdapter.of({
      spawn: (input) =>
        trellis.current.pipe(
          Effect.flatMap((env) => host.spawn(trellisTerminalSpawnInput(env, input))),
        ),
    });
  }),
);
