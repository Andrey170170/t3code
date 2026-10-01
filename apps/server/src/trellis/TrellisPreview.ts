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
 * Hooks: the `preview.open`/`preview.navigate` WS handlers, the
 * `trellis.resolvePreviewUrl` RPC (the address bar of an open tab) and the
 * `preview_open`/`preview_navigate` MCP tools.
 *
 * @module trellis/TrellisPreview
 */
import { PreviewTrellisError, type ThreadId } from "@t3tools/contracts";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { Trellis, trellisRootOf } from "./Trellis.ts";

/** The port of a loopback `http(s)` URL, or null for any other URL. */
export function loopbackPort(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(normalizePreviewUrl(url));
  } catch {
    return null;
  }
  if (!isLoopbackHost(parsed.hostname)) return null;
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

export class TrellisPreview extends Context.Service<
  TrellisPreview,
  {
    /** `url` as the browser should load it for `threadId`. */
    readonly resolveUrl: (
      threadId: ThreadId,
      url: string,
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
  }
>()("t3/trellis/TrellisPreview") {}

const readFailure = (what: string) =>
  new PreviewTrellisError({ detail: `could not read ${what} to find its workspace` });

const make = Effect.gen(function* () {
  const trellis = yield* Trellis;
  const orchestrator = yield* OrchestratorV2;
  const projects = yield* ProjectService;

  // The Trellis folder the thread runs in (worktree first), or null.
  const trellisCwdOf = Effect.fn("TrellisPreview.trellisCwdOf")(function* (threadId: ThreadId) {
    const roots = yield* trellis.expectedRoots;
    if (roots.length === 0) return null;
    // A read failure must not fall back to the host's localhost.
    const thread = yield* orchestrator
      .getThreadShell(threadId)
      .pipe(Effect.mapError(() => readFailure("the thread")));
    if (thread === null) return null;
    const path =
      thread.worktreePath ??
      (yield* projects.getById(thread.projectId).pipe(
        Effect.map((project) => Option.getOrNull(project)?.workspaceRoot ?? null),
        Effect.mapError(() => readFailure("the project")),
      ));
    if (path === null) return null;
    // Classified by realpath, as the runtime policy does.
    const cwd = yield* trellis.canonicalPath(path);
    return trellisRootOf(roots, cwd) !== null ? cwd : null;
  });

  const publish = (cwd: string, port: number) =>
    trellis
      .preview({ target: cwd, port })
      .pipe(Effect.mapError((error) => new PreviewTrellisError({ detail: error.message })));

  const resolveUrl: TrellisPreview["Service"]["resolveUrl"] = Effect.fn(
    "TrellisPreview.resolveUrl",
  )(function* (threadId, url) {
    const port = loopbackPort(url);
    if (port === null) return url;
    const cwd = yield* trellisCwdOf(threadId);
    if (cwd === null) return url;
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

  return TrellisPreview.of({ resolveUrl, resolvePort });
});

export const layer = Layer.effect(TrellisPreview, make);

/** For runtimes without Trellis: every URL is loaded as given. */
export const layerDisabled = Layer.succeed(
  TrellisPreview,
  TrellisPreview.of({
    resolveUrl: (_threadId, url) => Effect.succeed(url),
    resolvePort: () => Effect.succeed(null),
  }),
);
