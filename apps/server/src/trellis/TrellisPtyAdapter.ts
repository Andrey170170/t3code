// @effect-diagnostics nodeBuiltinImport:off
/**
 * TrellisPtyAdapter - runs terminals whose cwd is a Trellis project path
 * inside the workspace container, through `trellis exec`.
 *
 * Wraps the host PtyAdapter; other terminals are spawned unchanged, except a
 * git worktree of a Trellis project, which is refused: it lives outside the
 * workspace, so a terminal there would run on the host.
 *
 * @module trellis/TrellisPtyAdapter
 */
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import { isTrellisManagedPath, Trellis } from "./Trellis.ts";
import { TRELLIS_OUTSIDE_WORKSPACE_MESSAGE } from "./TrellisProviderSession.ts";

/** A terminal refused because it would run a Trellis project on the host. */
export class TrellisTerminalRefusedError extends PtyAdapter.PtySpawnError {
  override get message(): string {
    return TRELLIS_OUTSIDE_WORKSPACE_MESSAGE;
  }
}

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

/** The main checkout named by a worktree's `.git` file (`gitdir: <main>/.git/worktrees/<n>`). */
export function mainCheckoutFromGitFile(contents: string): string | null {
  const gitdir = /^gitdir:\s*(.+)$/m.exec(contents)?.[1]?.trim();
  if (!gitdir) return null;
  const marker = `${NodePath.posix.sep}.git${NodePath.posix.sep}worktrees${NodePath.posix.sep}`;
  const index = gitdir.lastIndexOf(marker);
  return index > 0 ? gitdir.slice(0, index) : null;
}

export const layer = Layer.effect(
  PtyAdapter.PtyAdapter,
  Effect.gen(function* () {
    const host = yield* PtyAdapter.PtyAdapter;
    const trellis = yield* Trellis;
    const fileSystem = yield* FileSystem.FileSystem;

    // The main checkout when `cwd` is inside a git worktree, else null.
    const worktreeMainCheckout = Effect.fn("TrellisPtyAdapter.worktreeMainCheckout")(function* (
      cwd: string,
    ) {
      let dir = NodePath.posix.normalize(cwd);
      while (true) {
        const gitPath = NodePath.posix.join(dir, ".git");
        const info = yield* fileSystem.stat(gitPath).pipe(Effect.orElseSucceed(() => null));
        if (info !== null) {
          if (info.type !== "File") return null;
          const contents = yield* fileSystem
            .readFileString(gitPath)
            .pipe(Effect.orElseSucceed(() => ""));
          return mainCheckoutFromGitFile(contents);
        }
        const parent = NodePath.posix.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
      }
    });

    return PtyAdapter.PtyAdapter.of({
      spawn: Effect.fn("TrellisPtyAdapter.spawn")(function* (input) {
        const root = yield* trellis.expectedRoot;
        if (root !== null && !isTrellisManagedPath(root, input.cwd)) {
          const main = yield* worktreeMainCheckout(input.cwd);
          if (main !== null && isTrellisManagedPath(root, main)) {
            return yield* new TrellisTerminalRefusedError({
              adapter: "trellis",
              shell: input.shell,
            });
          }
        }
        return yield* host.spawn(trellisTerminalSpawnInput({ root, bin: trellis.bin }, input));
      }),
    });
  }),
);
