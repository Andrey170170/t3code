/**
 * TrellisPreview - maps loopback previews of Trellis threads to the
 * workspace's preview address.
 *
 * A workspace runs in its own network namespace, so `localhost:PORT` in an
 * agent's or user's preview means the workspace, not the host T3 runs on.
 * Trellis publishes a workspace port on its preview host (`POST
 * /v1/previews`); the browser loads that address instead, with the same path,
 * query and fragment. The Trellis relay forwards raw TCP, so websockets (dev
 * server HMR) pass through. Threads outside Trellis are unchanged, and a
 * failed mapping is an error rather than a silent fall back to the host.
 *
 * A URL is mapped exactly once, at the first entry point. Later hops pass
 * `alreadyResolved`, which is honoured only for an address Trellis lists as
 * published for the thread's own workspace, so the flag cannot reach other
 * host ports. Port numbers alone are never taken as proof: a workspace's own
 * port may equal a host port Trellis published. T3's own signed asset URLs
 * (local file previews) also load as given.
 *
 * Hooks: the `preview.open`/`preview.navigate` WS handlers, the
 * `trellis.resolvePreviewUrl` RPC (the address bar of an open tab) and the
 * `preview_open`/`preview_navigate` MCP tools.
 *
 * Discovered servers follow the same rule: the host port scanner cannot see
 * a workspace's listeners, so a Trellis thread's local servers are the ports
 * Trellis lists inside its workspace, offered as `http://localhost:PORT` so
 * opening one goes through the mapping above.
 *
 * @module trellis/TrellisPreview
 */
import { type DiscoveredLocalServer, PreviewTrellisError, type ThreadId } from "@t3tools/contracts";
import { isLoopbackHostname, normalizePreviewUrl } from "@t3tools/shared/preview";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { isIssuedAssetUrl } from "../assets/AssetAccess.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { POLL_INTERVAL } from "../preview/PortScanner.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { Trellis, type TrellisPort, trellisRootOf, trellisWorkspaceOf } from "./Trellis.ts";

/** The port of a loopback `http(s)` URL, or null for any other URL. */
export function loopbackPort(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(normalizePreviewUrl(url));
  } catch {
    return null;
  }
  if (!isLoopbackHostname(parsed.hostname)) return null;
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === "https:" ? 443 : 80;
}

/**
 * `original` pointed at the host and port of `previewUrl`, keeping its
 * scheme, path, query and fragment. The relay is a TCP pipe, so the dev
 * server's own scheme still applies.
 */
export function rewriteToPreview(original: string, previewUrl: string): string {
  const source = new URL(normalizePreviewUrl(original));
  const preview = new URL(previewUrl);
  source.hostname = preview.hostname;
  source.port = preview.port;
  return source.toString();
}

/**
 * The reachable workspace ports as discovered local servers, one per port.
 * A configured loopback URL on the same port stands in for the bare origin,
 * as the host scanner does.
 */
export function workspaceServers(
  ports: ReadonlyArray<TrellisPort>,
  configuredUrls: ReadonlyArray<string>,
): ReadonlyArray<DiscoveredLocalServer> {
  const servers = new Map<number, DiscoveredLocalServer>();
  for (const { port, reachable } of ports) {
    if (!reachable || servers.has(port) || port <= 0 || port >= 65536) continue;
    const configured = configuredUrls.find((url) => loopbackPort(url) === port);
    servers.set(port, {
      host: "localhost",
      port,
      url: configured ?? `http://localhost:${port}`,
      processName: null,
      pid: null,
      terminal: null,
    });
  }
  return [...servers.values()].toSorted((left, right) => left.port - right.port);
}

const sameServers = (
  left: ReadonlyArray<DiscoveredLocalServer>,
  right: ReadonlyArray<DiscoveredLocalServer>,
) => left.length === right.length && left.every((server, i) => server.url === right[i]?.url);

export class TrellisPreview extends Context.Service<
  TrellisPreview,
  {
    /** `url` as the browser should load it for `threadId`. */
    readonly resolveUrl: (
      threadId: ThreadId,
      url: string,
      options?: { readonly alreadyResolved?: boolean | undefined },
    ) => Effect.Effect<string, PreviewTrellisError>;
    /** A workspace port of `threadId` as a browser URL, or null outside Trellis. */
    readonly resolvePort: (
      threadId: ThreadId,
      input: {
        readonly port: number;
        readonly protocol?: "http" | "https" | undefined;
        readonly path?: string | undefined;
      },
    ) => Effect.Effect<string | null, PreviewTrellisError>;
    /**
     * The local servers of `threadId`'s workspace, polled while the stream
     * runs; null for a thread outside Trellis, whose servers are the host's.
     * A workspace that is not running, or a thread whose localhost is not
     * its workspace's, has none.
     */
    readonly watchServers: (
      threadId: ThreadId,
      configuredUrls: ReadonlyArray<string>,
    ) => Effect.Effect<Stream.Stream<ReadonlyArray<DiscoveredLocalServer>> | null>;
  }
>()("t3/trellis/TrellisPreview") {}

const readFailure = (what: string) =>
  new PreviewTrellisError({ detail: `could not read ${what} to find its workspace` });

const outsideWorkspace = () =>
  new PreviewTrellisError({
    detail:
      "this thread runs outside its Trellis workspace (an external worktree), so its localhost is not the workspace's",
  });

/** `host:port` of a URL, with the scheme's default port. */
const hostPortOf = (url: URL) =>
  `${url.hostname.toLowerCase()}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;

const make = Effect.gen(function* () {
  const trellis = yield* Trellis;
  const orchestrator = yield* OrchestratorV2;
  const projects = yield* ProjectService;
  const secrets = yield* ServerSecretStore;

  /**
   * The Trellis folder the thread runs in (worktree first), or null outside
   * Trellis. A Trellis project's thread whose worktree lies outside the
   * project's workspace fails: its localhost is neither the workspace nor
   * safely the host's.
   */
  const trellisCwdOf = Effect.fn("TrellisPreview.trellisCwdOf")(function* (threadId: ThreadId) {
    const roots = yield* trellis.expectedRoots;
    if (roots.length === 0) return null;
    // A read failure must not fall back to the host's localhost.
    const thread = yield* orchestrator
      .getThreadShell(threadId)
      .pipe(Effect.mapError(() => readFailure("the thread")));
    if (thread === null) return null;
    const projectPath = yield* projects.getById(thread.projectId).pipe(
      Effect.map((project) => Option.getOrNull(project)?.workspaceRoot ?? null),
      Effect.mapError(() => readFailure("the project")),
    );
    // Classified by realpath, as the runtime policy does.
    const projectRoot = projectPath === null ? null : yield* trellis.canonicalPath(projectPath);
    const worktree =
      thread.worktreePath === null ? null : yield* trellis.canonicalPath(thread.worktreePath);
    const projectWorkspace = projectRoot === null ? null : trellisWorkspaceOf(roots, projectRoot);
    const cwd = worktree ?? projectRoot;
    if (cwd === null) return null;
    if (projectWorkspace !== null) {
      if (trellisWorkspaceOf(roots, cwd) !== projectWorkspace) return yield* outsideWorkspace();
      return cwd;
    }
    return trellisRootOf(roots, cwd) !== null ? cwd : null;
  });

  // Whether `url` is an address Trellis published for this workspace, the
  // only kind of URL a client's `alreadyResolved` may vouch for.
  const isPublishedFor = (cwd: string, url: URL) =>
    trellis.listPreviews(cwd).pipe(
      Effect.map((previews) =>
        previews.some((preview) => {
          try {
            return hostPortOf(new URL(preview.url)) === hostPortOf(url);
          } catch {
            return false;
          }
        }),
      ),
      Effect.mapError((error) => new PreviewTrellisError({ detail: error.message })),
    );

  const publish = (cwd: string, port: number) =>
    trellis
      .preview({ target: cwd, port })
      .pipe(Effect.mapError((error) => new PreviewTrellisError({ detail: error.message })));

  const resolveUrl: TrellisPreview["Service"]["resolveUrl"] = Effect.fn(
    "TrellisPreview.resolveUrl",
  )(function* (threadId, url, options) {
    const port = loopbackPort(url);
    if (port === null) return url;
    // T3's own file previews are served by this server, not the workspace.
    if (yield* isIssuedAssetUrl(url).pipe(Effect.provideService(ServerSecretStore, secrets))) {
      return url;
    }
    const cwd = yield* trellisCwdOf(threadId);
    if (cwd === null) return url;
    if (
      options?.alreadyResolved === true &&
      (yield* isPublishedFor(cwd, new URL(normalizePreviewUrl(url))))
    ) {
      return url;
    }
    const published = yield* publish(cwd, port);
    return rewriteToPreview(url, published.url);
  });

  const resolvePort: TrellisPreview["Service"]["resolvePort"] = Effect.fn(
    "TrellisPreview.resolvePort",
  )(function* (threadId, input) {
    const cwd = yield* trellisCwdOf(threadId);
    if (cwd === null) return null;
    const path = input.path?.startsWith("/") ? input.path : `/${input.path ?? ""}`;
    const published = yield* publish(cwd, input.port);
    return rewriteToPreview(
      `${input.protocol ?? "http"}://localhost:${input.port}${path}`,
      published.url,
    );
  });

  const serversOf = (threadId: ThreadId, configuredUrls: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const cwd = yield* trellisCwdOf(threadId);
      const workspace = cwd === null ? null : trellisWorkspaceOf(yield* trellis.expectedRoots, cwd);
      if (workspace === null) return [];
      return workspaceServers(yield* trellis.ports(workspace), configuredUrls);
    }).pipe(
      // Not running (or no Trellis) means no servers, never the host's.
      Effect.catch((error) =>
        Effect.logDebug("no Trellis workspace ports", { threadId, detail: error.message }).pipe(
          Effect.as([]),
        ),
      ),
    );

  const watchServers: TrellisPreview["Service"]["watchServers"] = Effect.fn(
    "TrellisPreview.watchServers",
  )(function* (threadId, configuredUrls) {
    const inTrellis = yield* trellisCwdOf(threadId).pipe(
      Effect.map((cwd) => cwd !== null),
      // A thread that cannot be placed shows nothing rather than the host's servers.
      Effect.orElseSucceed(() => true),
    );
    if (!inTrellis) return null;
    return Stream.fromEffectSchedule(
      serversOf(threadId, configuredUrls),
      Schedule.spaced(POLL_INTERVAL),
    ).pipe(Stream.changesWith(sameServers));
  });

  return TrellisPreview.of({ resolveUrl, resolvePort, watchServers });
});

export const layer = Layer.effect(TrellisPreview, make);

/** For runtimes without Trellis: every URL is loaded as given. */
export const layerDisabled = Layer.succeed(
  TrellisPreview,
  TrellisPreview.of({
    resolveUrl: (_threadId, url) => Effect.succeed(url),
    resolvePort: () => Effect.succeed(null),
    watchServers: () => Effect.succeed(null),
  }),
);
