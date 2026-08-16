// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";

import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectEntry,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@t3tools/shared/path";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

const WORKSPACE_FALLBACK_CACHE_TTL = Duration.seconds(15);
const WORKSPACE_FALLBACK_CACHE_MAX_KEYS = 4;
const WORKSPACE_FALLBACK_MAX_ENTRIES = 25_000;
const WORKSPACE_FALLBACK_READDIR_CONCURRENCY = 32;
const WORKSPACE_FALLBACK_IGNORED_DIRECTORY_NAMES = new Set([".git", ".convex", "node_modules"]);

interface WorkspaceFallbackIndex {
  readonly entries: ReadonlyArray<SearchableWorkspaceFallbackEntry>;
  readonly truncated: boolean;
}

interface SearchableWorkspaceFallbackEntry extends ProjectEntry {
  readonly normalizedPath: string;
  readonly normalizedName: string;
}

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

function isPathInFallbackIgnoredDirectory(relativePath: string): boolean {
  return relativePath
    .split("/")
    .some((segment) => WORKSPACE_FALLBACK_IGNORED_DIRECTORY_NAMES.has(segment));
}

function fallbackBasenameOf(relativePath: string): string {
  const separatorIndex = relativePath.lastIndexOf("/");
  return separatorIndex === -1 ? relativePath : relativePath.slice(separatorIndex + 1);
}

function toSearchableWorkspaceFallbackEntry(entry: ProjectEntry): SearchableWorkspaceFallbackEntry {
  const normalizedPath = entry.path.toLowerCase();
  return {
    ...entry,
    normalizedPath,
    normalizedName: fallbackBasenameOf(normalizedPath),
  };
}

function scoreWorkspaceFallbackEntry(
  entry: SearchableWorkspaceFallbackEntry,
  query: string,
): number | null {
  if (!query) return entry.kind === "directory" ? 0 : 1;

  const scores = [
    scoreQueryMatch({
      value: entry.normalizedName,
      query,
      exactBase: 0,
      prefixBase: 2,
      includesBase: 5,
      fuzzyBase: 100,
    }),
    scoreQueryMatch({
      value: entry.normalizedPath,
      query,
      exactBase: 1,
      prefixBase: 3,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 200,
      boundaryMarkers: ["/"],
    }),
  ].filter((score): score is number => score !== null);
  return scores.length > 0 ? Math.min(...scores) : null;
}

export class WorkspaceEntriesWindowsPathUnsupportedError extends Schema.TaggedErrorClass<WorkspaceEntriesWindowsPathUnsupportedError>()(
  "WorkspaceEntriesWindowsPathUnsupportedError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    platform: Schema.String,
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Windows-style workspace path '${this.partialPath}' is not supported on '${this.platform}'${cwd}.`;
  }
}

export class WorkspaceEntriesCurrentProjectRequiredError extends Schema.TaggedErrorClass<WorkspaceEntriesCurrentProjectRequiredError>()(
  "WorkspaceEntriesCurrentProjectRequiredError",
  {
    partialPath: Schema.String,
  },
) {
  override get message(): string {
    return `A current project is required to browse relative workspace path '${this.partialPath}'.`;
  }
}

export class WorkspaceEntriesReadDirectoryError extends Schema.TaggedErrorClass<WorkspaceEntriesReadDirectoryError>()(
  "WorkspaceEntriesReadDirectoryError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    parentPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Failed to read workspace directory '${this.parentPath}' while browsing '${this.partialPath}'${cwd}.`;
  }
}

export const WorkspaceEntriesBrowseError = Schema.Union([
  WorkspaceEntriesWindowsPathUnsupportedError,
  WorkspaceEntriesCurrentProjectRequiredError,
  WorkspaceEntriesReadDirectoryError,
]);
export type WorkspaceEntriesBrowseError = typeof WorkspaceEntriesBrowseError.Type;

export const WorkspaceEntriesError = Schema.Union([
  WorkspacePaths.WorkspaceRootNotExistsError,
  WorkspacePaths.WorkspaceRootCreateFailedError,
  WorkspacePaths.WorkspaceRootStatFailedError,
  WorkspacePaths.WorkspaceRootNotDirectoryError,
  WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed,
  WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut,
  WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed,
]);
export type WorkspaceEntriesError = typeof WorkspaceEntriesError.Type;

export class WorkspaceEntries extends Context.Service<
  WorkspaceEntries,
  {
    readonly browse: (
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesBrowseError>;
    readonly list: (
      input: ProjectListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntriesError>;
    readonly search: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
    readonly searchContents: (
      input: ProjectSearchContentsInput,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceEntriesError>;
    readonly refresh: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/workspace/WorkspaceEntries") {}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(NodeOS.homedir(), input.slice(2));
  }
  return input;
}

const resolveBrowseTarget = Effect.fn("WorkspaceEntries.resolveBrowseTarget")(function* (
  input: FilesystemBrowseInput,
  path: Path.Path,
): Effect.fn.Return<string, WorkspaceEntriesBrowseError> {
  const platform = yield* HostProcessPlatform;
  if (platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
    return yield* new WorkspaceEntriesWindowsPathUnsupportedError({
      cwd: input.cwd,
      partialPath: input.partialPath,
      platform,
    });
  }

  if (!isExplicitRelativePath(input.partialPath)) {
    return path.resolve(expandHomePath(input.partialPath, path));
  }

  if (!input.cwd) {
    return yield* new WorkspaceEntriesCurrentProjectRequiredError({
      partialPath: input.partialPath,
    });
  }
  return path.resolve(expandHomePath(input.cwd, path), input.partialPath);
});

export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceSearchIndexes = yield* WorkspaceSearchIndex.WorkspaceSearchIndexMap;

  const readFallbackDirectoryEntries = Effect.fn("WorkspaceEntries.readFallbackDirectoryEntries")(
    function* (cwd: string, relativeDir: string) {
      return yield* Effect.tryPromise({
        try: async () => {
          const absoluteDir = relativeDir ? path.join(cwd, relativeDir) : cwd;
          const dirents = await NodeFSP.readdir(absoluteDir, { withFileTypes: true });
          return { relativeDir, dirents };
        },
        catch: (cause) =>
          new WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed({
            cwd,
            reason: `Native index unavailable and fallback directory scan failed at '${relativeDir || "."}'.`,
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          () => relativeDir.length > 0,
          () => Effect.succeed({ relativeDir, dirents: null }),
        ),
      );
    },
  );

  // Git's index can retain deleted paths and represents gitlinks without a
  // filesystem kind. The fallback scans directory entries for existence,
  // kind, and empty directories; VCS detection is used only for ignore rules.
  const buildWorkspaceFallbackIndex = Effect.fn("WorkspaceEntries.buildWorkspaceFallbackIndex")(
    function* (
      cwd: string,
    ): Effect.fn.Return<
      WorkspaceFallbackIndex,
      WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed
    > {
      const vcs = yield* vcsRegistry.detect({ cwd }).pipe(Effect.orElseSucceed(() => null));
      let pendingDirectories = [""];
      const entries: SearchableWorkspaceFallbackEntry[] = [];
      let truncated = false;

      while (pendingDirectories.length > 0 && !truncated) {
        const currentDirectories = pendingDirectories;
        pendingDirectories = [];
        const directoryEntries = yield* Effect.forEach(
          currentDirectories,
          (relativeDir) => readFallbackDirectoryEntries(cwd, relativeDir),
          { concurrency: WORKSPACE_FALLBACK_READDIR_CONCURRENCY },
        );
        const candidatesByDirectory = directoryEntries.map(({ relativeDir, dirents }) => {
          if (!dirents) return [] as Array<{ dirent: NodeFS.Dirent; relativePath: string }>;
          dirents.sort((left, right) => left.name.localeCompare(right.name));
          return dirents.flatMap((dirent) => {
            if (!dirent.name || dirent.name === "." || dirent.name === "..") return [];
            if (
              dirent.isDirectory() &&
              WORKSPACE_FALLBACK_IGNORED_DIRECTORY_NAMES.has(dirent.name)
            ) {
              return [];
            }
            if (!dirent.isDirectory() && !dirent.isFile()) return [];
            const relativePath = toPosixPath(
              relativeDir ? path.join(relativeDir, dirent.name) : dirent.name,
            );
            return isPathInFallbackIgnoredDirectory(relativePath) ? [] : [{ dirent, relativePath }];
          });
        });
        const candidatePaths = candidatesByDirectory.flatMap((candidates) =>
          candidates.map((candidate) => candidate.relativePath),
        );
        const allowedPathSet = vcs
          ? new Set(
              yield* vcs.driver
                .filterIgnoredPaths(cwd, candidatePaths)
                .pipe(Effect.orElseSucceed(() => candidatePaths)),
            )
          : null;

        for (const candidates of candidatesByDirectory) {
          for (const candidate of candidates) {
            if (allowedPathSet && !allowedPathSet.has(candidate.relativePath)) continue;
            entries.push(
              toSearchableWorkspaceFallbackEntry({
                path: candidate.relativePath,
                kind: candidate.dirent.isDirectory() ? "directory" : "file",
              }),
            );
            if (candidate.dirent.isDirectory()) pendingDirectories.push(candidate.relativePath);
            if (entries.length >= WORKSPACE_FALLBACK_MAX_ENTRIES) {
              truncated = true;
              break;
            }
          }
          if (truncated) break;
        }
      }

      entries.sort((left, right) => left.path.localeCompare(right.path));
      return { entries, truncated };
    },
  );

  const workspaceFallbackIndexCache = yield* Cache.makeWith<
    string,
    WorkspaceFallbackIndex,
    WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed
  >(buildWorkspaceFallbackIndex, {
    capacity: WORKSPACE_FALLBACK_CACHE_MAX_KEYS,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? WORKSPACE_FALLBACK_CACHE_TTL : Duration.zero),
  });

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd);
  });

  const refresh: WorkspaceEntries["Service"]["refresh"] = Effect.fn("WorkspaceEntries.refresh")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.orElseSucceed(() => cwd),
      );
      yield* Cache.invalidate(workspaceFallbackIndexCache, normalizedCwd);
      for (const variant of WorkspaceSearchIndex.WORKSPACE_SEARCH_INDEX_VARIANTS) {
        const indexKey = WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, variant);
        if (!(yield* RcMap.has(workspaceSearchIndexes.rcMap, indexKey))) {
          continue;
        }
        const recoverRefreshFailure = (
          cause:
            | WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed
            | WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut
            | WorkspaceSearchIndex.WorkspaceSearchIndexRefreshFailed,
        ) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Failed to refresh workspace search index", {
              cwd,
              variant,
              cause,
            });
            yield* workspaceSearchIndexes.invalidate(indexKey);
          });
        yield* Effect.gen(function* () {
          const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
          yield* searchIndex.refresh();
        }).pipe(
          Effect.provide(workspaceSearchIndexes.get(indexKey)),
          Effect.catchTags({
            WorkspaceSearchIndexCreateFailed: recoverRefreshFailure,
            WorkspaceSearchIndexScanTimedOut: recoverRefreshFailure,
            WorkspaceSearchIndexRefreshFailed: recoverRefreshFailure,
          }),
        );
      }
    },
  );

  const browse: WorkspaceEntries["Service"]["browse"] = Effect.fn("WorkspaceEntries.browse")(
    function* (input) {
      const resolvedInputPath = yield* resolveBrowseTarget(input, path);
      const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
      const parentPath = endsWithSeparator ? resolvedInputPath : path.dirname(resolvedInputPath);
      const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);

      const dirents = yield* Effect.tryPromise({
        try: () => NodeFSP.readdir(parentPath, { withFileTypes: true }),
        catch: (cause) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: input.cwd,
            partialPath: input.partialPath,
            parentPath,
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) => {
            const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
            return code === "EACCES" || code === "EPERM";
          },
          () => Effect.succeed([]),
        ),
      );

      const showHidden = endsWithSeparator || prefix.startsWith(".");
      const lowerPrefix = prefix.toLowerCase();
      const entries: Array<{ readonly name: string; readonly fullPath: string }> = [];
      for (const dirent of dirents) {
        if (
          dirent.isDirectory() &&
          dirent.name.toLowerCase().startsWith(lowerPrefix) &&
          (showHidden || !dirent.name.startsWith("."))
        ) {
          entries.push({
            name: dirent.name,
            fullPath: path.join(parentPath, dirent.name),
          });
        }
      }

      return {
        parentPath,
        entries: entries.toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    },
  );

  const search: WorkspaceEntries["Service"]["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      const normalizedQuery = normalizeSearchQuery(input.query, {
        trimLeadingPattern: /^[@./]+/,
      });
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.search(normalizedQuery, input.limit, input.kind, input.imageOnly);
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
        Effect.catchTag("WorkspaceSearchIndexCreateFailed", () =>
          Cache.get(workspaceFallbackIndexCache, normalizedCwd).pipe(
            Effect.map((index) => {
              const rankedEntries: Array<{
                readonly item: SearchableWorkspaceFallbackEntry;
                readonly score: number;
                readonly tieBreaker: string;
              }> = [];
              let matchedEntryCount = 0;
              for (const entry of index.entries) {
                if (
                  input.imageOnly &&
                  (entry.kind !== "file" || !isWorkspaceImagePreviewPath(entry.path))
                ) {
                  continue;
                }
                if (!input.imageOnly && input.kind !== undefined && entry.kind !== input.kind) {
                  continue;
                }
                const score = scoreWorkspaceFallbackEntry(entry, normalizedQuery);
                if (score === null) continue;
                matchedEntryCount += 1;
                insertRankedSearchResult(
                  rankedEntries,
                  { item: entry, score, tieBreaker: entry.path },
                  input.limit,
                );
              }
              return {
                entries: rankedEntries.map(({ item }) => ({ path: item.path, kind: item.kind })),
                truncated: index.truncated || matchedEntryCount > input.limit,
              };
            }),
          ),
        ),
      );
    },
  );

  const searchContents: WorkspaceEntries["Service"]["searchContents"] = Effect.fn(
    "WorkspaceEntries.searchContents",
  )(function* (input) {
    const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
    return yield* Effect.gen(function* () {
      const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
      return yield* searchIndex.searchContents(input);
    }).pipe(
      Effect.provide(
        workspaceSearchIndexes.get(
          WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "content"),
        ),
      ),
    );
  });

  const list: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.list();
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
        Effect.catchTag("WorkspaceSearchIndexCreateFailed", () =>
          Cache.get(workspaceFallbackIndexCache, normalizedCwd).pipe(
            Effect.map((index) => ({
              entries: index.entries.map(({ path: entryPath, kind }) => ({
                path: entryPath,
                kind,
              })),
              truncated: index.truncated,
            })),
          ),
        ),
      );
    },
  );

  return WorkspaceEntries.of({ browse, list, refresh, search, searchContents });
});

export const layer = Layer.effect(WorkspaceEntries, make).pipe(
  Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
);
