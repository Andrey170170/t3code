// @effect-diagnostics nodeBuiltinImport:off
/**
 * Trellis - client for the optional local Trellis workspace service.
 *
 * Trellis manages isolated workspaces (Btrfs subvolumes run as rootless podman
 * containers). Its API is JSON over HTTP on a Unix socket. The integration is
 * off until the `trellis.enabled` server setting turns it on; while it is off
 * nothing talks to the socket. When it is off or Trellis is unreachable,
 * `current` is null and every Trellis-aware seam in T3 behaves as without
 * Trellis, except that Trellis project paths (see `expectedRoots`) are never
 * treated as ordinary host folders.
 *
 * Project files live at `<root>/workspaces/<ws>/project[/<idea>]`, and the same
 * path exists inside the workspace container, so T3 reads files and git state
 * from the host path and passes the same path as cwd to processes inside.
 *
 * @module trellis/Trellis
 */
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { TrellisError } from "@t3tools/contracts";
import { isTrellisManagedPath as isSharedTrellisManagedPath } from "@t3tools/shared/trellis";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";

export const DEFAULT_TRELLIS_SOCKET = "/trellis/state/api.sock";

export const TrellisWorkspaceView = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  name: Schema.String,
  path: Schema.String,
  deleted_at: Schema.NullOr(Schema.Finite),
});
export type TrellisWorkspaceView = typeof TrellisWorkspaceView.Type;

export const TrellisProjectView = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  name: Schema.String,
  /**
   * Who named it: `default` (placeholder), `derived` (e.g. the git repo),
   * `generated` (a client's naming model), `agent` or `user`. Absent from
   * Trellis versions that predate it.
   */
  name_source: Schema.optional(Schema.String),
  description: Schema.String,
  workspace_id: Schema.String,
  path: Schema.String,
  updated_at: Schema.Finite,
  deleted_at: Schema.NullOr(Schema.Finite),
  graduated_to: Schema.NullOr(Schema.String),
  workspaces: Schema.Array(TrellisWorkspaceView),
});
export type TrellisProjectView = typeof TrellisProjectView.Type;

export const TrellisSnapshot = Schema.Struct({
  id: Schema.String,
  workspace_id: Schema.String,
  seq: Schema.Finite,
  kind: Schema.String,
  /** Pinned snapshots survive thinning. Absent from older Trellis versions. */
  pinned: Schema.optional(Schema.Boolean),
  thread: Schema.NullOr(Schema.String),
  turn: Schema.NullOr(Schema.String),
  created_at: Schema.Finite,
});
export type TrellisSnapshot = typeof TrellisSnapshot.Type;

export const TrellisFindHitView = Schema.Struct({
  project: TrellisProjectView,
  matches: Schema.Array(Schema.Struct({ path: Schema.String, snippet: Schema.String })),
});
export type TrellisFindHitView = typeof TrellisFindHitView.Type;

export const TrellisResolved = Schema.Struct({
  workspace: TrellisWorkspaceView,
  project: Schema.NullOr(TrellisProjectView),
});
export type TrellisResolved = typeof TrellisResolved.Type;

/** A trashed project or workspace as `GET /v1/trash` lists it. */
export const TrellisTrashEntryView = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  name: Schema.String,
  project_id: Schema.optional(Schema.NullOr(Schema.String)),
  deleted_at: Schema.NullOr(Schema.Finite),
  /** When Trellis removes it for good; null keeps it until the trash is emptied. */
  expires_at: Schema.optional(Schema.NullOr(Schema.Finite)),
});
export type TrellisTrashEntryView = typeof TrellisTrashEntryView.Type;

export const TrellisTrashView = Schema.Struct({
  projects: Schema.Array(TrellisTrashEntryView),
  workspaces: Schema.Array(TrellisTrashEntryView),
  /** How long ideas stay in the trash; older Trellis versions sent `purge_after_days`. */
  idea_expiry_days: Schema.optional(Schema.Finite),
  purge_after_days: Schema.optional(Schema.Finite),
});
export type TrellisTrashView = typeof TrellisTrashView.Type;

const TrellisStatusView = Schema.Struct({ root: Schema.String });
const TrellisPurgeView = Schema.Struct({ purged: Schema.Finite });
const TrellisRollbackView = Schema.Struct({ undo_snapshot: Schema.optional(Schema.Unknown) });
const TrellisDescribeView = Schema.Struct({
  ignored: Schema.optional(Schema.Array(Schema.String)),
  // Older Trellis versions.
  ignored_pinned: Schema.optional(Schema.Array(Schema.String)),
});
const TrellisPreviewView = Schema.Struct({ host_port: Schema.Finite, url: Schema.String });
const TrellisPrimerView = Schema.Struct({ primer: Schema.String });
const TrellisErrorBody = Schema.Struct({ error: Schema.String });

/** Enabled Trellis state. `shimDir` is null when provider shims could not be created. */
export interface TrellisEnv {
  readonly root: string;
  readonly bin: string;
  readonly shimDir: string | null;
}

/** See `TrellisState` in the contracts. */
export interface TrellisConnection {
  readonly state: "disabled" | "unavailable" | "ready";
  readonly root: string | null;
  readonly socketPath: string;
}

/** Message for work in a Trellis project path while the integration is off. */
export const TRELLIS_DISABLED_MESSAGE =
  "The Trellis integration is turned off on this server, so this project's workspace is unavailable. Turn it on in Settings → Trellis and try again.";

/** True when `cwd` is inside a Trellis project directory (`<root>/workspaces/<ws>/project`). */
export const isTrellisManagedPath = isSharedTrellisManagedPath;

/** `<root>` for a socket at the conventional `<root>/state/api.sock`, else null. */
export function rootFromSocketPath(socketPath: string): string | null {
  const stateDir = NodePath.posix.dirname(socketPath);
  return NodePath.posix.basename(socketPath) === "api.sock" &&
    NodePath.posix.basename(stateDir) === "state"
    ? NodePath.posix.dirname(stateDir)
    : null;
}

export class Trellis extends Context.Service<
  Trellis,
  {
    /** Last known state; null when Trellis is disabled or unreachable. */
    readonly current: Effect.Effect<TrellisEnv | null>;
    /**
     * Re-reads `/v1/status` (and creates provider shims on first success).
     * Null without touching the socket while the integration is off.
     */
    readonly refresh: Effect.Effect<TrellisEnv | null>;
    /** Whether the `trellis.enabled` setting is on. */
    readonly enabled: Effect.Effect<boolean>;
    /** Disabled, unavailable or ready, from the setting and the last refresh. */
    readonly connection: Effect.Effect<TrellisConnection>;
    /**
     * Every place Trellis project paths may live, also while Trellis is off or
     * unreachable: the live root, every root Trellis ever reported (persisted
     * across restarts), `TRELLIS_ROOT`, and the root implied by the socket
     * path. Work in those paths must fail rather than silently run on the host.
     */
    readonly expectedRoots: Effect.Effect<ReadonlyArray<string>>;
    /** The `trellis` binary, for `trellis exec`. */
    readonly bin: string;
    /** `all` includes trashed workspaces; this listing queries container state. */
    readonly listWorkspaces: (options: {
      readonly all: boolean;
    }) => Effect.Effect<ReadonlyArray<TrellisWorkspaceView>, TrellisError>;
    /** `all` includes trashed and graduated items; the list never includes container state. */
    readonly listProjects: (options: {
      readonly all: boolean;
    }) => Effect.Effect<ReadonlyArray<TrellisProjectView>, TrellisError>;
    readonly createIdea: (input: {
      readonly name?: string | undefined;
    }) => Effect.Effect<TrellisProjectView, TrellisError>;
    readonly createProject: (input: {
      readonly name?: string | undefined;
      readonly gitUrl?: string | undefined;
      readonly base?: string | undefined;
    }) => Effect.Effect<TrellisProjectView, TrellisError>;
    /**
     * Sets the name and/or description. `user` (the default) pins them as a
     * user edit. `generated` and `refined` apply only while the name is still
     * `default` or `generated`; a `refined` name is final for generation.
     * Returns the fields Trellis kept instead.
     */
    readonly describe: (input: {
      readonly target: string;
      readonly name?: string | undefined;
      readonly description?: string | undefined;
      readonly source?: "user" | "generated" | "refined";
    }) => Effect.Effect<{ readonly ignored: ReadonlyArray<string> }, TrellisError>;
    readonly find: (
      query: string,
    ) => Effect.Effect<ReadonlyArray<TrellisFindHitView>, TrellisError>;
    readonly resolve: (target: string) => Effect.Effect<TrellisResolved, TrellisError>;
    readonly listSnapshots: (
      target: string,
    ) => Effect.Effect<ReadonlyArray<TrellisSnapshot>, TrellisError>;
    readonly createSnapshot: (input: {
      readonly target: string;
      readonly thread: string;
      readonly turn: string;
    }) => Effect.Effect<TrellisSnapshot, TrellisError>;
    /** Pins a snapshot so thinning keeps it. */
    readonly pinSnapshot: (id: string) => Effect.Effect<void, TrellisError>;
    /** Moves a project (with all its workspaces) to the trash. */
    readonly trashProject: (id: string) => Effect.Effect<void, TrellisError>;
    /** Moves one fork to the trash; the last one trashes its project. */
    readonly trashWorkspace: (id: string) => Effect.Effect<void, TrellisError>;
    readonly restoreProject: (id: string) => Effect.Effect<TrellisProjectView, TrellisError>;
    readonly restoreWorkspace: (id: string) => Effect.Effect<void, TrellisError>;
    readonly listTrash: Effect.Effect<TrellisTrashView, TrellisError>;
    /** Permanently removes everything in the trash. */
    readonly emptyTrash: Effect.Effect<number, TrellisError>;
    /**
     * Idea targets restore only the folder; workspace targets restart the
     * container. Returns the snapshot holding the state from just before.
     */
    readonly rollback: (input: {
      readonly target: string;
      readonly snapshot: string;
    }) => Effect.Effect<{ readonly undoSnapshot: string | null }, TrellisError>;
    /**
     * Publishes a workspace port on the preview host (idempotent per
     * workspace and port). `url` is reachable from the user's browser.
     */
    readonly preview: (input: {
      readonly target: string;
      readonly port: number;
    }) => Effect.Effect<{ readonly hostPort: number; readonly url: string }, TrellisError>;
    /** Short agent orientation for sessions started in `target`. */
    readonly primer: (target: string) => Effect.Effect<string, TrellisError>;
  }
>()("t3/trellis/Trellis") {}

interface RawResponse {
  readonly status: number;
  readonly body: string;
}

function requestOverSocket(input: {
  readonly socketPath: string;
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly body: unknown;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = input.body === undefined ? undefined : JSON.stringify(input.body);
    const request = NodeHttp.request(
      {
        socketPath: input.socketPath,
        method: input.method,
        path: input.path,
        signal: input.signal,
        headers: {
          accept: "application/json",
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }),
        },
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.setTimeout(input.timeoutMs, () =>
      request.destroy(new Error(`timed out after ${input.timeoutMs}ms`)),
    );
    request.on("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

const decodeJson = <S extends Schema.Top>(schema: S, text: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError(
      (error) => new TrellisError({ message: `Unexpected Trellis response: ${error.message}` }),
    ),
  );

const query = (params: Record<string, string>) => new URLSearchParams(params).toString();

export const make = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const serverSettings = yield* ServerSettingsService;
  const socketPath = yield* Config.String("TRELLIS_SOCKET").pipe(
    Config.withDefault(DEFAULT_TRELLIS_SOCKET),
  );
  const bin = yield* Config.String("TRELLIS_BIN").pipe(Config.withDefault("trellis"));
  // The `trellis` CLI's own root override, which shims and terminals inherit.
  const envRoot = yield* Config.String("TRELLIS_ROOT").pipe(
    Config.option,
    Effect.map((value) => Option.getOrNull(value)),
  );
  const shimDir = NodePath.join(serverConfig.stateDir, "trellis-shims");
  // Every root Trellis reported, one per line, kept so their paths stay
  // recognizable while the integration is off or Trellis is down, including
  // after a restart or a root change.
  const rootFile = NodePath.join(serverConfig.stateDir, "trellis-root");
  const state = yield* Ref.make<TrellisEnv | null>(null);
  const persistedRoots = yield* fileSystem.readFileString(rootFile).pipe(
    Effect.map((text) =>
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("/")),
    ),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  const knownRoots = yield* Ref.make<ReadonlyArray<string>>(persistedRoots);
  let lastShimAttemptMs = 0;

  const enabled = serverSettings.getSettings.pipe(
    Effect.map((value) => value.trellis.enabled),
    Effect.orElseSucceed(() => false),
  );

  const call = <S extends Schema.Top>(
    schema: S,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options: { readonly body?: unknown; readonly timeoutMs?: number } = {},
  ) =>
    Effect.gen(function* () {
      if (!(yield* enabled)) {
        return yield* new TrellisError({
          message: "The Trellis integration is turned off on this server.",
        });
      }
      return yield* Effect.tryPromise({
        try: (signal) =>
          requestOverSocket({
            socketPath,
            method,
            path,
            body: options.body,
            timeoutMs: options.timeoutMs ?? 15_000,
            signal,
          }),
        catch: (cause) =>
          new TrellisError({
            message: `Trellis is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      });
    }).pipe(
      Effect.flatMap((response) =>
        response.status >= 400
          ? decodeJson(TrellisErrorBody, response.body).pipe(
              Effect.flatMap((body) => Effect.fail(new TrellisError({ message: body.error }))),
            )
          : decodeJson(schema, response.body),
      ),
    );

  // Shims are symlinks named `codex` and `claude` to the trellis binary. Run in
  // a Trellis project path they execute the provider inside the workspace.
  const ensureShims = Effect.gen(function* () {
    yield* fileSystem.makeDirectory(shimDir, { recursive: true });
    const result = yield* processRunner.run({
      command: bin,
      args: ["shims", "--dir", shimDir],
      timeout: "10 seconds",
    });
    if (result.code !== 0) {
      return yield* new TrellisError({
        message: result.stderr.trim() || `trellis shims exited with code ${result.code}`,
      });
    }
    const present = yield* Effect.all([
      fileSystem.exists(NodePath.join(shimDir, "codex")),
      fileSystem.exists(NodePath.join(shimDir, "claude")),
    ]);
    return present.every(Boolean) ? shimDir : null;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Trellis provider shims could not be created", {
        shimDir,
        cause,
      }).pipe(Effect.as(null)),
    ),
  );

  // Serialized so concurrent refreshes never run `trellis shims` twice or
  // let a slower refresh overwrite a newer result.
  const refreshLock = yield* Semaphore.make(1);
  const refresh = Effect.gen(function* () {
    const previous = yield* Ref.get(state);
    if (!(yield* enabled)) {
      if (previous !== null) yield* Effect.logInfo("Trellis integration turned off");
      yield* Ref.set(state, null);
      return null;
    }
    const status = yield* call(TrellisStatusView, "GET", "/v1/status", { timeoutMs: 3_000 }).pipe(
      Effect.option,
    );
    if (status._tag === "None") {
      if (previous !== null) yield* Effect.logInfo("Trellis became unavailable");
      yield* Ref.set(state, null);
      return null;
    }
    // A failed shim setup is retried at most once a minute.
    const now = yield* Clock.currentTimeMillis;
    if (
      previous !== null &&
      previous.root === status.value.root &&
      (previous.shimDir !== null || now - lastShimAttemptMs < 60_000)
    ) {
      return previous;
    }
    lastShimAttemptMs = now;
    const known = yield* Ref.get(knownRoots);
    if (!known.includes(status.value.root)) {
      const next = [...known, status.value.root];
      yield* Ref.set(knownRoots, next);
      yield* fileSystem
        .writeFileString(rootFile, `${next.join("\n")}\n`)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("could not persist the Trellis root", { rootFile, cause }),
          ),
        );
    }
    const next: TrellisEnv = {
      root: status.value.root,
      bin,
      shimDir: yield* ensureShims,
    };
    yield* Effect.logInfo("Trellis is available", { root: next.root, shimDir: next.shimDir });
    yield* Ref.set(state, next);
    return next;
  }).pipe(refreshLock.withPermits(1));

  const socketRoot = rootFromSocketPath(socketPath);
  const expectedRoots = Effect.gen(function* () {
    const live = (yield* Ref.get(state))?.root ?? null;
    const roots = [live, ...(yield* Ref.get(knownRoots)), envRoot, socketRoot].filter(
      (root): root is string => root !== null,
    );
    return [...new Set(roots)];
  });

  const connection = Effect.gen(function* () {
    const on = yield* enabled;
    const env = on ? yield* Ref.get(state) : null;
    return {
      state: !on ? "disabled" : env === null ? "unavailable" : "ready",
      root: env?.root ?? (yield* Ref.get(knownRoots)).at(-1) ?? envRoot ?? socketRoot,
      socketPath,
    } satisfies TrellisConnection;
  });

  return Trellis.of({
    // Null as soon as the setting turns off, before the next refresh.
    current: Effect.gen(function* () {
      return (yield* enabled) ? yield* Ref.get(state) : null;
    }),
    refresh,
    enabled,
    connection,
    expectedRoots,
    bin,
    listWorkspaces: ({ all }) =>
      call(Schema.Array(TrellisWorkspaceView), "GET", `/v1/workspaces${all ? "?all=true" : ""}`),
    listProjects: ({ all }) =>
      call(
        Schema.Array(TrellisProjectView),
        "GET",
        `/v1/projects?${query({ light: "true", ...(all ? { all: "true" } : {}) })}`,
      ),
    createIdea: ({ name }) =>
      call(TrellisProjectView, "POST", "/v1/ideas", { body: name ? { name } : {} }),
    createProject: ({ name, gitUrl, base }) =>
      call(TrellisProjectView, "POST", "/v1/projects", {
        body: {
          ...(name ? { name } : {}),
          ...(gitUrl ? { git_url: gitUrl } : {}),
          ...(base ? { base } : {}),
        },
        // Creation may clone a repository.
        timeoutMs: 15 * 60_000,
      }),
    describe: ({ target, name, description, source = "user" }) =>
      call(TrellisDescribeView, "POST", "/v1/describe", {
        body: {
          target,
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
          source,
          ...(source === "user" ? { pin: true } : {}),
        },
      }).pipe(Effect.map((view) => ({ ignored: view.ignored ?? view.ignored_pinned ?? [] }))),
    find: (text) => call(Schema.Array(TrellisFindHitView), "GET", `/v1/find?${query({ q: text })}`),
    resolve: (target) => call(TrellisResolved, "GET", `/v1/resolve?${query({ target })}`),
    listSnapshots: (target) =>
      call(Schema.Array(TrellisSnapshot), "GET", `/v1/snapshots?${query({ target })}`),
    createSnapshot: ({ target, thread, turn }) =>
      call(TrellisSnapshot, "POST", "/v1/snapshots", {
        body: { target, kind: "turn", thread, turn },
        // Btrfs snapshots take milliseconds; these run on the shared
        // checkpoint worker, so a hung Trellis must not stall other threads.
        timeoutMs: 15_000,
      }),
    pinSnapshot: (id) =>
      call(TrellisSnapshot, "PATCH", `/v1/snapshots/${encodeURIComponent(id)}`, {
        body: { pinned: true },
      }).pipe(Effect.asVoid),
    trashProject: (id) =>
      call(Schema.Unknown, "DELETE", `/v1/projects/${encodeURIComponent(id)}`).pipe(Effect.asVoid),
    trashWorkspace: (id) =>
      call(Schema.Unknown, "DELETE", `/v1/workspaces/${encodeURIComponent(id)}`).pipe(
        Effect.asVoid,
      ),
    restoreProject: (id) =>
      call(TrellisProjectView, "POST", `/v1/projects/${encodeURIComponent(id)}/restore`),
    restoreWorkspace: (id) =>
      call(Schema.Unknown, "POST", `/v1/workspaces/${encodeURIComponent(id)}/restore`).pipe(
        Effect.asVoid,
      ),
    listTrash: call(TrellisTrashView, "GET", "/v1/trash"),
    emptyTrash: call(TrellisPurgeView, "POST", "/v1/trash/purge", {
      body: { all: true },
      timeoutMs: 5 * 60_000,
    }).pipe(Effect.map((view) => view.purged)),
    rollback: ({ target, snapshot }) =>
      call(TrellisRollbackView, "POST", "/v1/rollback", {
        body: { target, snapshot },
        // Includes a container restart for dedicated workspaces.
        timeoutMs: 60_000,
      }).pipe(
        Effect.map((view) => {
          const undo = view.undo_snapshot;
          const id =
            typeof undo === "string"
              ? undo
              : Predicate.hasProperty(undo, "id") && typeof undo.id === "string"
                ? undo.id
                : null;
          return { undoSnapshot: id };
        }),
      ),
    preview: ({ target, port }) =>
      call(TrellisPreviewView, "POST", "/v1/previews", { body: { target, port } }).pipe(
        Effect.map((view) => ({ hostPort: view.host_port, url: view.url })),
      ),
    primer: (target) =>
      call(TrellisPrimerView, "GET", `/v1/primer?${query({ target })}`, { timeoutMs: 5_000 }).pipe(
        Effect.map((view) => view.primer),
      ),
  });
});

export const layer = Layer.effect(Trellis, make).pipe(Layer.provide(ProcessRunner.layer));

/**
 * True when `cwd` is a Trellis project path, including while Trellis is
 * unreachable, so callers never treat such a path as an ordinary host folder.
 */
export const isTrellisPath = Effect.fn("Trellis.isTrellisPath")(function* (
  trellis: Trellis["Service"],
  cwd: string | undefined,
) {
  if (cwd === undefined) return false;
  return trellisRootOf(yield* trellis.expectedRoots, cwd) !== null;
});

/** The root among `roots` that manages `path`, or null for an ordinary host path. */
export function trellisRootOf(roots: ReadonlyArray<string>, path: string): string | null {
  return roots.find((root) => isTrellisManagedPath(root, path)) ?? null;
}

export const TRELLIS_WORKTREE_REFUSAL =
  "Git worktrees are not supported in Trellis projects: they would live outside the workspace and run on the host. Use `trellis fork` for parallel work instead.";

/**
 * Fails with `TRELLIS_WORKTREE_REFUSAL` when `cwd` is a Trellis project path.
 * `trellis` is the optional service captured when the caller was built.
 */
export const refuseWorktreeIn = <E>(
  trellis: Option.Option<Trellis["Service"]>,
  cwd: string,
  makeError: (detail: string) => E,
): Effect.Effect<void, E> =>
  Option.isNone(trellis)
    ? Effect.void
    : isTrellisPath(trellis.value, cwd).pipe(
        Effect.flatMap((managed) =>
          managed ? Effect.fail(makeError(TRELLIS_WORKTREE_REFUSAL)) : Effect.void,
        ),
      );

/**
 * A Trellis service for tests: ready at `env` (or off with `env: null`),
 * with every operation failing loudly unless overridden.
 */
export function makeTestTrellis(
  overrides: Partial<Trellis["Service"]> & { readonly env?: TrellisEnv | null } = {},
): Trellis["Service"] {
  const { env = { root: "/trellis", bin: "trellis", shimDir: "/shims" }, ...rest } = overrides;
  const unused = () => Effect.die(new Error("unused Trellis operation"));
  return Trellis.of({
    current: Effect.succeed(env),
    refresh: Effect.succeed(env),
    enabled: Effect.succeed(env !== null),
    connection: Effect.succeed({
      state: env === null ? "disabled" : "ready",
      root: env?.root ?? null,
      socketPath: DEFAULT_TRELLIS_SOCKET,
    }),
    expectedRoots: Effect.succeed(env === null ? [] : [env.root]),
    bin: env?.bin ?? "trellis",
    listWorkspaces: unused,
    listProjects: unused,
    createIdea: unused,
    createProject: unused,
    describe: unused,
    find: unused,
    resolve: unused,
    listSnapshots: unused,
    createSnapshot: unused,
    pinSnapshot: () => Effect.void,
    trashProject: unused,
    trashWorkspace: unused,
    restoreProject: unused,
    restoreWorkspace: unused,
    listTrash: Effect.die(new Error("unused Trellis operation")),
    emptyTrash: Effect.die(new Error("unused Trellis operation")),
    rollback: unused,
    preview: unused,
    primer: unused,
    ...rest,
  });
}
