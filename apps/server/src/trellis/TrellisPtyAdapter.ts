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
import { isTrellisManagedPath, Trellis } from "./Trellis.ts";

/**
 * The spawn input for a terminal in `input.cwd`: a login bash inside the
 * workspace for a Trellis project path (`root` is the current or expected
 * Trellis root). If Trellis is down, `trellis exec` reports it in the terminal.
 */
export function trellisTerminalSpawnInput(
  trellis: { readonly root: string | null; readonly bin: string },
  input: PtyAdapter.PtySpawnInput,
): PtyAdapter.PtySpawnInput {
  if (trellis.root === null || !isTrellisManagedPath(trellis.root, input.cwd)) return input;
  return {
    ...input,
    shell: trellis.bin,
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
        trellis.expectedRoot.pipe(
          Effect.flatMap((root) =>
            host.spawn(trellisTerminalSpawnInput({ root, bin: trellis.bin }, input)),
          ),
        ),
    });
  }),
);
