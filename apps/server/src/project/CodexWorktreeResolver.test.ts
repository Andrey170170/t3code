import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import { GitVcsDriver, layer as gitLayer } from "../vcs/GitVcsDriver.ts";
import { makeCodexWorktreeResolver } from "./CodexWorktreeResolver.ts";

const testLayer = gitLayer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "codex-worktree-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const makeGitFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "codex-worktrees-" });
  const main = path.join(root, "main");
  const linked = path.join(root, "linked workspace");
  const detached = path.join(root, "detached");
  const clone = path.join(root, "clone");
  yield* fs.makeDirectory(main);
  const run = (args: string[]) =>
    git.execute({ operation: "CodexWorktreeResolver.test", cwd: main, args });
  yield* run(["init"]);
  yield* run([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ]);
  yield* run(["remote", "add", "origin", "https://example.invalid/shared.git"]);
  yield* run(["worktree", "add", "-b", "feature/linked", linked]);
  yield* run(["worktree", "add", "--detach", detached]);
  yield* run(["clone", main, clone]);
  yield* git.execute({
    operation: "CodexWorktreeResolver.test",
    cwd: clone,
    args: ["remote", "set-url", "origin", "https://example.invalid/shared.git"],
  });

  return { fs, path, git, root, main, linked, detached, clone, run };
});

it.layer(testLayer)("Codex worktree identity", (it) => {
  it.effect(
    "groups linked and detached worktrees by their main checkout, keeping clones separate",
    () =>
      Effect.gen(function* () {
        const { fs, git, main, linked, detached, clone } = yield* makeGitFixture;
        const calls: Array<ReadonlyArray<string>> = [];
        const resolver = yield* makeCodexWorktreeResolver({
          execute: (input) => {
            calls.push(input.args);
            return git.execute(input);
          },
        });
        const identities = yield* resolver.resolveMany([main, linked, detached, clone, linked]);
        expect(identities.get(main)).toMatchObject({ projectCwd: main, worktreePath: null });
        expect(identities.get(linked)).toMatchObject({
          projectCwd: main,
          worktreePath: linked,
          worktreeBranch: "feature/linked",
        });
        expect(identities.get(detached)).toMatchObject({
          projectCwd: main,
          worktreePath: detached,
          worktreeBranch: null,
        });
        expect(identities.get(clone)?.projectCwd).toBe(clone);
        expect(identities.get(clone)?.gitCommonDir).not.toBe(identities.get(main)?.gitCommonDir);
        expect(calls.filter((args) => args.includes("worktree"))).toHaveLength(2);
        const count = calls.length;
        yield* resolver.resolveMany([linked, main, detached]);
        expect(calls).toHaveLength(count);
        yield* fs.remove(detached, { recursive: true });
        expect(yield* resolver.resolveFresh(detached)).toBeNull();
        yield* resolver.invalidate;
        const refreshed = yield* resolver.resolveMany([main, detached]);
        expect(refreshed.get(detached)).toBeNull();
        expect(refreshed.get(main)?.checkouts.some((checkout) => checkout.cwd === detached)).toBe(
          false,
        );
      }),
  );
  it.effect("associates only removed Codex worktrees with one unambiguous persisted origin", () =>
    Effect.gen(function* () {
      const { fs, path, git, root, main, clone } = yield* makeGitFixture;
      const resolver = yield* makeCodexWorktreeResolver(git);
      const codexHome = path.join(root, "codex");
      const removed = path.join(codexHome, "worktrees", "old-id", "checkout");
      const outside = path.join(root, "unrelated-removed-folder");
      const thread = (
        id: string,
        cwd: string,
        originUrl = "https://example.invalid/shared.git",
      ) => ({
        id,
        cwd,
        modelProvider: "openai",
        preview: "",
        createdAt: 1,
        updatedAt: 2,
        gitInfo: { originUrl, branch: "old-work" },
      });
      const result = yield* resolver.resolveCatalog({
        codexHome,
        projectRoots: [main],
        threads: [thread("old", removed), thread("outside", outside)],
      });
      expect(result.get(removed)).toMatchObject({
        projectCwd: main,
        worktreePath: removed,
        worktreeMissing: true,
        worktreeBranch: "old-work",
      });
      expect(result.get(removed)?.checkouts).toHaveLength(3);
      expect(result.get(outside)).toBeNull();
      const ambiguous = yield* resolver.resolveCatalog({
        codexHome,
        projectRoots: [main, clone],
        threads: [thread("old", removed), thread("clone", clone)],
      });
      expect(ambiguous.get(removed)).toBeNull();
      expect(ambiguous.get(clone)?.projectCwd).toBe(clone);
      const conflicting = yield* resolver.resolveCatalog({
        codexHome,
        projectRoots: [main],
        threads: [
          thread("old", removed),
          thread("conflict", removed, "https://example.invalid/other.git"),
        ],
      });
      expect(conflicting.get(removed)).toBeNull();
      yield* fs.makeDirectory(removed, { recursive: true });
      const reused = yield* resolver.resolveCatalog({
        codexHome,
        projectRoots: [main],
        threads: [thread("old", removed)],
      });
      expect(reused.get(removed)).toBeNull();
    }),
  );
});
