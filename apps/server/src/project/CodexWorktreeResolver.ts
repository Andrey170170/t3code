import type { CodexThreadsListResult } from "@t3tools/contracts";
import type { NativeThread } from "effect-codex-app-server/thread-history";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { GitVcsDriver } from "../vcs/GitVcsDriver.ts";

type Checkout = NonNullable<CodexThreadsListResult["projects"][number]["checkouts"]>[number];
export interface CodexWorkspaceIdentity {
  readonly projectCwd: string;
  readonly worktreePath: string | null;
  readonly worktreeBranch: string | null;
  readonly worktreeMissing: boolean;
  readonly gitCommonDir: string;
  readonly originUrl: string | null;
  readonly checkouts: ReadonlyArray<Checkout>;
}
interface WorktreeEntry {
  readonly cwd: string;
  readonly branch: string | null;
  readonly bare: boolean;
  readonly prunable: boolean;
}
const NativeGitInfo = Schema.Struct({
  originUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeGitInfo = Schema.decodeUnknownOption(NativeGitInfo);

// NUL porcelain preserves whitespace and newlines in checkout names. Git lists
// the main worktree first, followed by linked worktrees; bare repositories have
// no main checkout and cannot establish a canonical project directory here.
const parseWorktrees = (stdout: string): ReadonlyArray<WorktreeEntry> =>
  stdout.split("\0\0").flatMap((record) => {
    const fields = record.split("\0");
    const cwd = fields.find((field) => field.startsWith("worktree "))?.slice(9);
    if (!cwd) return [];
    return [
      {
        cwd,
        branch:
          fields
            .find((field) => field.startsWith("branch "))
            ?.slice(7)
            .replace(/^refs\/heads\//, "") ?? null,
        bare: fields.includes("bare"),
        prunable: fields.some((field) => field === "prunable" || field.startsWith("prunable ")),
      },
    ];
  });
const stripFinalNewline = (value: string) => value.replace(/\r?\n$/, "");

/** Metadata-only Git discovery, single-flight per unique cwd and common directory. */
export const makeCodexWorktreeResolver = (git: Pick<GitVcsDriver["Service"], "execute">) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const inside = (root: string, candidate: string) => {
      const relative = path.relative(root, candidate);
      return (
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
      );
    };
    const existingDirectory = (cwd: string) =>
      fs.stat(cwd).pipe(
        Effect.map((stat) => stat.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
    const missingDirectory = (cwd: string) =>
      fs.stat(cwd).pipe(
        Effect.as(false),
        Effect.catch((error) => Effect.succeed(error.reason._tag === "NotFound")),
      );
    const execute = (cwd: string, args: ReadonlyArray<string>) =>
      git.execute({
        operation: "CodexWorktreeResolver.metadata",
        cwd,
        args,
        timeoutMs: 5_000,
        maxOutputBytes: 1_000_000,
        allowNonZeroExit: true,
      });
    const readRepository = Effect.fn("CodexWorktreeResolver.readRepository")(
      function* (commonDir: string) {
        const listed = yield* execute(commonDir, [
          "--git-dir",
          commonDir,
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ]);
        if (listed.exitCode !== 0 || listed.stdoutTruncated) return null;
        const entries = parseWorktrees(listed.stdout);
        const main = entries[0];
        if (!main || main.bare || !(yield* existingDirectory(main.cwd))) return null;
        const projectCwd = yield* fs.realPath(main.cwd).pipe(Effect.orElseSucceed(() => null));
        if (!projectCwd) return null;
        const checkouts = (yield* Effect.forEach(
          entries,
          (entry) =>
            Effect.gen(function* () {
              if (entry.bare || entry.prunable || !(yield* existingDirectory(entry.cwd)))
                return null;
              const cwd = yield* fs.realPath(entry.cwd);
              return { cwd, branch: entry.branch, isMain: cwd === projectCwd };
            }),
          { concurrency: 4 },
        )).filter((entry): entry is Checkout => entry !== null);
        const origin = yield* execute(commonDir, [
          "--git-dir",
          commonDir,
          "config",
          "--get",
          "remote.origin.url",
        ]);
        return {
          projectCwd,
          gitCommonDir: commonDir,
          checkouts,
          originUrl: origin.exitCode === 0 ? stripFinalNewline(origin.stdout) || null : null,
        };
      },
      Effect.orElseSucceed(() => null),
    );
    const repositories = yield* Cache.makeWith(readRepository, {
      capacity: 256,
      timeToLive: () => "30 seconds",
    });
    const resolve = Effect.fn("CodexWorktreeResolver.resolve")(
      function* (cwd: string, fresh: boolean) {
        const canonicalCwd = yield* fs.realPath(cwd);
        const common = yield* execute(canonicalCwd, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]);
        if (common.exitCode !== 0 || common.stdoutTruncated) return null;
        const commonDir = yield* fs.realPath(stripFinalNewline(common.stdout));
        const repository = yield* fresh
          ? readRepository(commonDir)
          : Cache.get(repositories, commonDir);
        if (!repository) return null;
        const checkout = repository.checkouts
          .filter((entry) => inside(entry.cwd, canonicalCwd))
          .sort((a, b) => b.cwd.length - a.cwd.length)[0];
        if (!checkout) return null;
        const identity: CodexWorkspaceIdentity = {
          ...repository,
          worktreePath: checkout.isMain ? null : cwd,
          worktreeBranch: checkout.branch,
          worktreeMissing: false,
        };
        return identity;
      },
      Effect.orElseSucceed(() => null),
    );
    const directories = yield* Cache.makeWith((cwd: string) => resolve(cwd, false), {
      capacity: 2048,
      timeToLive: () => "30 seconds",
    });
    const resolveMany = (cwds: ReadonlyArray<string>) =>
      Effect.forEach(
        [...new Set(cwds)],
        (cwd) =>
          Cache.get(directories, cwd).pipe(Effect.map((identity) => [cwd, identity] as const)),
        { concurrency: 4 },
      ).pipe(Effect.map((entries) => new Map(entries)));

    const resolveCatalog = Effect.fn("CodexWorktreeResolver.resolveCatalog")(function* (input: {
      readonly threads: ReadonlyArray<NativeThread>;
      readonly codexHome: string;
      readonly projectRoots: ReadonlyArray<string>;
    }) {
      const identities = yield* resolveMany([
        ...input.threads.map((thread) => thread.cwd),
        ...input.projectRoots,
      ]);
      const candidates = new Map<string, Map<string, CodexWorkspaceIdentity>>();
      for (const identity of identities.values()) {
        if (!identity?.originUrl) continue;
        const roots = candidates.get(identity.originUrl) ?? new Map();
        roots.set(identity.projectCwd, identity);
        candidates.set(identity.originUrl, roots);
      }
      const byCwd = new Map<string, Array<NativeThread>>();
      for (const thread of input.threads) {
        const threads = byCwd.get(thread.cwd) ?? [];
        threads.push(thread);
        byCwd.set(thread.cwd, threads);
      }
      for (const [cwd, threads] of byCwd) {
        if (identities.get(cwd)) continue;
        // Only removed Codex-managed worktrees may use persisted origin metadata.
        // Existing independent clones always retain their own physical identity.
        const worktreeHome = path.join(input.codexHome, "worktrees");
        const relative = path.relative(worktreeHome, cwd);
        if (
          !inside(worktreeHome, cwd) ||
          relative.split(path.sep).length < 2 ||
          !(yield* missingDirectory(cwd))
        )
          continue;
        const metadata = threads.map((thread) =>
          Option.getOrUndefined(decodeGitInfo(thread.gitInfo)),
        );
        const origins = new Set(
          metadata.flatMap((info) => (info?.originUrl ? [info.originUrl] : [])),
        );
        if (origins.size !== 1) continue;
        const originUrl = origins.values().next().value!;
        const roots = candidates.get(originUrl);
        if (roots?.size !== 1) continue;
        const candidate = roots.values().next().value!;
        const branches = new Set(metadata.flatMap((info) => (info?.branch ? [info.branch] : [])));
        identities.set(cwd, {
          ...candidate,
          worktreePath: cwd,
          worktreeBranch: branches.size === 1 ? branches.values().next().value! : null,
          worktreeMissing: true,
        });
      }
      return identities;
    });
    return {
      invalidate: Cache.invalidateAll(directories).pipe(
        Effect.andThen(Cache.invalidateAll(repositories)),
      ),
      resolveMany,
      resolveFresh: (cwd: string) => resolve(cwd, true),
      resolveCatalog,
      existingDirectory,
      missingDirectory,
    };
  });
