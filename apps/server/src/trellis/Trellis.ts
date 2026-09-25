// @effect-diagnostics nodeBuiltinImport:off
/**
 * Trellis - client for the optional local Trellis workspace service.
 *
 * Trellis manages isolated workspaces (Btrfs subvolumes run as rootless podman
 * containers). Its API is JSON over HTTP on a Unix socket. When the socket is
 * absent or unreachable, `current` is null and every Trellis-aware seam in T3
 * behaves exactly as without Trellis.
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

const TrellisStatusView = Schema.Struct({ root: Schema.String });
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
    /** Re-reads `/v1/status` (and creates provider shims on first success). */
    readonly refresh: Effect.Effect<TrellisEnv | null>;
    /**
     * Where Trellis project paths live even while Trellis is unreachable: the
     * last reported root, else the root implied by the socket path. Work in
     * those paths must fail rather than silently run on the host.
     */
    readonly expectedRoot: Effect.Effect<string | null>;
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
  readonly method: "GET" | "POST";
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
  const socketPath = yield* Config.String("TRELLIS_SOCKET").pipe(
    Config.withDefault(DEFAULT_TRELLIS_SOCKET),
  );
  const bin = yield* Config.String("TRELLIS_BIN").pipe(Config.withDefault("trellis"));
  const shimDir = NodePath.join(serverConfig.stateDir, "trellis-shims");
  const state = yield* Ref.make<TrellisEnv | null>(null);
  const lastRoot = yield* Ref.make<string | null>(rootFromSocketPath(socketPath));
  let lastShimAttemptMs = 0;

  const call = <S extends Schema.Top>(
    schema: S,
    method: "GET" | "POST",
    path: string,
    options: { readonly body?: unknown; readonly timeoutMs?: number } = {},
  ) =>
    Effect.tryPromise({
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
    const status = yield* call(TrellisStatusView, "GET", "/v1/status", { timeoutMs: 3_000 }).pipe(
      Effect.option,
    );
    const previous = yield* Ref.get(state);
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
    yield* Ref.set(lastRoot, status.value.root);
    const next: TrellisEnv = {
      root: status.value.root,
      bin,
      shimDir: yield* ensureShims,
    };
    yield* Effect.logInfo("Trellis is available", { root: next.root, shimDir: next.shimDir });
    yield* Ref.set(state, next);
    return next;
  }).pipe(refreshLock.withPermits(1));

  yield* refresh;

  return Trellis.of({
    current: Ref.get(state),
    refresh,
    expectedRoot: Ref.get(lastRoot),
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
  const root = yield* trellis.expectedRoot;
  return root !== null && isTrellisManagedPath(root, cwd);
});

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
