import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";

import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import { makeTestTrellis, Trellis, TRELLIS_DISABLED_MESSAGE, type TrellisEnv } from "./Trellis.ts";
import * as TrellisPtyAdapter from "./TrellisPtyAdapter.ts";
import { TRELLIS_OUTSIDE_WORKSPACE_MESSAGE } from "./TrellisRuntimePolicy.ts";

const idea = "/trellis/workspaces/ws-1/project/idea";

const spawnInput = (cwd: string): PtyAdapter.PtySpawnInput => ({
  shell: "bash",
  cwd,
  cols: 80,
  rows: 24,
  env: {},
});

const harness = (
  env: TrellisEnv | null,
  roots: ReadonlyArray<string> = ["/trellis"],
  aliases: Readonly<Record<string, string>> = {},
) => {
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
        makeTestTrellis({
          env,
          expectedRoots: Effect.succeed(roots),
          canonicalPath: (path) => Effect.succeed(aliases[path] ?? path),
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  const spawn = (cwd: string) =>
    Effect.gen(function* () {
      const adapter = yield* PtyAdapter.PtyAdapter;
      return yield* adapter.spawn(spawnInput(cwd));
    }).pipe(Effect.provide(layer));
  return { spawn, spawned };
};

describe("TrellisPtyAdapter", () => {
  it.effect("opens a login bash inside the workspace for a Trellis project path", () =>
    Effect.gen(function* () {
      const { spawn, spawned } = harness({ root: "/trellis", bin: "/opt/trellis", shimDir: null });
      yield* spawn(idea);
      expect(spawned).toEqual([
        {
          ...spawnInput(idea),
          shell: "/opt/trellis",
          args: ["exec", "--tty", "--cwd", idea, "--", "bash", "-l"],
        },
      ]);
    }),
  );

  it.effect("opens a symlink to a workspace path inside the workspace", () =>
    Effect.gen(function* () {
      const { spawn, spawned } = harness(
        { root: "/trellis", bin: "/opt/trellis", shimDir: null },
        ["/trellis"],
        { "/home/me/idea": idea },
      );
      yield* spawn("/home/me/idea");
      expect(spawned).toEqual([
        {
          ...spawnInput(idea),
          shell: "/opt/trellis",
          args: ["exec", "--tty", "--cwd", idea, "--", "bash", "-l"],
        },
      ]);
    }),
  );

  it.effect("refuses terminals in Trellis projects while the integration is off", () =>
    Effect.gen(function* () {
      const { spawn, spawned } = harness(null);
      const error = yield* spawn(idea).pipe(Effect.flip);
      expect(error.message).toBe(TRELLIS_DISABLED_MESSAGE);
      expect(spawned).toEqual([]);
    }),
  );

  it.effect("refuses a terminal in a git worktree of a Trellis project", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const worktree = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trellis-wt-" });
      yield* fileSystem.writeFileString(
        path.join(worktree, ".git"),
        "gitdir: /trellis/workspaces/ws-1/project/.git/worktrees/feature\n",
      );
      const { spawn, spawned } = harness({ root: "/trellis", bin: "trellis", shimDir: null });
      const error = yield* spawn(path.join(worktree)).pipe(Effect.flip);
      expect(error.message).toBe(TRELLIS_OUTSIDE_WORKSPACE_MESSAGE);
      expect(spawned).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("spawns host terminals elsewhere unchanged", () =>
    Effect.gen(function* () {
      const { spawn, spawned } = harness({ root: "/trellis", bin: "trellis", shimDir: null });
      yield* spawn("/");
      expect(spawned).toEqual([spawnInput("/")]);
    }),
  );
});

describe("mainCheckoutFromGitFile", () => {
  it("finds the main checkout of a git worktree", () => {
    expect(
      TrellisPtyAdapter.mainCheckoutFromGitFile(
        "gitdir: /trellis/workspaces/ws-1/project/.git/worktrees/feature\n",
        "/home/me/.t3/worktrees/feature",
      ),
    ).toBe("/trellis/workspaces/ws-1/project");
    // `worktree.useRelativePaths` writes a path relative to the worktree.
    expect(
      TrellisPtyAdapter.mainCheckoutFromGitFile(
        "gitdir: ../../../../trellis/workspaces/ws-1/project/.git/worktrees/feature\n",
        "/home/me/wt/feature",
      ),
    ).toBe("/trellis/workspaces/ws-1/project");
    expect(
      TrellisPtyAdapter.mainCheckoutFromGitFile("gitdir: /repo/.git/modules/sub\n", "/repo/sub"),
    ).toBeNull();
    expect(TrellisPtyAdapter.mainCheckoutFromGitFile("", "/x")).toBeNull();
  });
});
