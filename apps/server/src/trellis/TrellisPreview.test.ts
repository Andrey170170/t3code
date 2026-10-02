import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProjectId, ThreadId, TrellisError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { issueAssetUrl } from "../assets/AssetAccess.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { OrchestratorProjectionError, OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectFaviconResolver } from "../project/ProjectFaviconResolver.ts";
import { ProjectService } from "../project/ProjectService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { makeTestTrellis, Trellis, type TrellisPort } from "./Trellis.ts";
import * as TrellisPreview from "./TrellisPreview.ts";

const ROOT = "/trellis";
const IDEA = `${ROOT}/workspaces/ws-1/project/idea-1`;
const OTHER = `${ROOT}/workspaces/ws-2/project`;
const threadId = ThreadId.make("thread-1");

describe("loopbackPort", () => {
  it("detects loopback hosts with explicit and default ports", () => {
    expect(TrellisPreview.loopbackPort("http://localhost:5173/x")).toBe(5173);
    expect(TrellisPreview.loopbackPort("http://127.0.0.1:3000")).toBe(3000);
    expect(TrellisPreview.loopbackPort("http://[::1]:8080/")).toBe(8080);
    expect(TrellisPreview.loopbackPort("http://0.0.0.0:4000")).toBe(4000);
    expect(TrellisPreview.loopbackPort("localhost:5173")).toBe(5173);
    expect(TrellisPreview.loopbackPort("http://localhost/")).toBe(80);
    // Every alias of this machine, not only the common spellings.
    expect(TrellisPreview.loopbackPort("http://127.0.0.2:8000/")).toBe(8000);
    expect(TrellisPreview.loopbackPort("http://localhost.:8000/")).toBe(8000);
    expect(TrellisPreview.loopbackPort("http://LocalHost:8000/")).toBe(8000);
    expect(TrellisPreview.loopbackPort("http://[::ffff:127.0.0.1]:8000/")).toBe(8000);
    expect(TrellisPreview.loopbackPort("http://[::]:8000/")).toBe(8000);
    expect(TrellisPreview.loopbackPort("https://localhost/")).toBe(443);
  });

  it("ignores other hosts", () => {
    expect(TrellisPreview.loopbackPort("https://example.com:5173")).toBeNull();
    expect(TrellisPreview.loopbackPort("http://100.64.0.3:5173")).toBeNull();
    expect(TrellisPreview.loopbackPort("http://localhost.example.com:5173")).toBeNull();
  });
});

describe("rewriteToPreview", () => {
  it("keeps scheme, path, query and fragment", () => {
    expect(
      TrellisPreview.rewriteToPreview(
        "http://localhost:5173/app/page?tab=a&b=2#section",
        "http://node.tailnet.ts.net:21001/",
      ),
    ).toBe("http://node.tailnet.ts.net:21001/app/page?tab=a&b=2#section");
  });
});

// The real signing key store, so asset URLs are checked by signature.
const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-trellis-preview-test-",
});
const AssetLayer = Layer.mergeAll(
  configLayer,
  WorkspacePaths.layer,
  // Media files never consult favicons.
  Layer.mock(ProjectFaviconResolver)({}),
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
).pipe(Layer.provideMerge(NodeServices.layer));

const port = (value: number, address: string, reachable = true): TrellisPort => ({
  port: value,
  address,
  reachable,
  preview: null,
});

describe("workspaceServers", () => {
  it("offers each reachable port once as a localhost server, configured URLs first", () => {
    const servers = TrellisPreview.workspaceServers(
      [
        port(8123, "0.0.0.0"),
        port(5173, "127.0.0.1"),
        port(5173, "::1"),
        port(9000, "10.0.2.100", false),
      ],
      ["http://localhost:8123/docs/"],
    );
    expect(servers.map((server) => [server.port, server.url])).toEqual([
      [5173, "http://localhost:5173"],
      [8123, "http://localhost:8123/docs/"],
    ]);
    expect(servers[0]).toMatchObject({ host: "localhost", pid: null, terminal: null });
  });
});

describe("TrellisPreview service", () => {
  const makeLayer = (input: {
    readonly workspaceRoot: string;
    readonly worktreePath?: string;
    readonly fail?: boolean;
    readonly readFails?: boolean;
    readonly missingThread?: boolean;
    readonly published: Array<{ target: string; port: number }>;
    /** Addresses Trellis has already published, by target. */
    readonly previews?: Readonly<Record<string, ReadonlyArray<string>>>;
    /** Ports listening per workspace id; a workspace absent here is not running. */
    readonly ports?: Readonly<Record<string, ReadonlyArray<TrellisPort>>>;
  }) =>
    TrellisPreview.layer.pipe(
      Layer.provide(
        Layer.succeed(
          Trellis,
          makeTestTrellis({
            preview: (request) =>
              input.fail
                ? Effect.fail(new TrellisError({ message: "workspace is not running" }))
                : Effect.sync(() => {
                    input.published.push(request);
                    return { hostPort: 21001, url: "http://node.tailnet.ts.net:21001/" };
                  }),
            listPreviews: (target) =>
              Effect.succeed((input.previews?.[target] ?? []).map((url) => ({ url }))),
            ports: (workspace) => {
              const ports = input.ports?.[workspace];
              return ports === undefined
                ? Effect.fail(
                    new TrellisError({ message: `workspace ${workspace} is not running` }),
                  )
                : Effect.succeed(ports);
            },
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(OrchestratorV2)({
          getThreadShell: (id) =>
            input.readFails
              ? Effect.fail(new OrchestratorProjectionError({ threadId: id }))
              : Effect.succeed(
                  input.missingThread
                    ? null
                    : ({
                        projectId: ProjectId.make("p"),
                        worktreePath: input.worktreePath ?? null,
                      } as never),
                ),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectService)({
          getById: () =>
            Effect.succeed(Option.some({ workspaceRoot: input.workspaceRoot } as never)),
        }),
      ),
      Layer.provideMerge(AssetLayer),
    );

  const resolve = (url: string, layer: ReturnType<typeof makeLayer>) =>
    Effect.gen(function* () {
      const preview = yield* TrellisPreview.TrellisPreview;
      return yield* preview.resolveUrl(threadId, url);
    }).pipe(Effect.provide(layer));

  it.effect("maps a loopback URL of a Trellis thread to the workspace preview", () =>
    Effect.gen(function* () {
      const published: Array<{ target: string; port: number }> = [];
      const url = yield* resolve(
        "http://localhost:8000/a?b=1#c",
        makeLayer({ workspaceRoot: IDEA, published }),
      );
      expect(url).toBe("http://node.tailnet.ts.net:21001/a?b=1#c");
      expect(published).toEqual([{ target: IDEA, port: 8000 }]);
    }),
  );

  it.effect("leaves other URLs and non-Trellis threads unchanged", () =>
    Effect.gen(function* () {
      const published: Array<{ target: string; port: number }> = [];
      expect(
        yield* resolve("https://example.com/", makeLayer({ workspaceRoot: IDEA, published })),
      ).toBe("https://example.com/");
      expect(
        yield* resolve(
          "http://localhost:5173/",
          makeLayer({ workspaceRoot: "/home/me/code", published }),
        ),
      ).toBe("http://localhost:5173/");
      expect(published).toEqual([]);
    }),
  );

  it.effect("refuses a Trellis project's thread that runs in an external worktree", () =>
    Effect.gen(function* () {
      const published: Array<{ target: string; port: number }> = [];
      const error = yield* resolve(
        "http://localhost:8000/",
        makeLayer({ workspaceRoot: IDEA, worktreePath: "/home/me/wt", published }),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("PreviewTrellisError");
      expect(error.message).toContain("outside its Trellis workspace");
      expect(published).toEqual([]);
    }),
  );

  it.effect("maps loopback aliases, not only localhost", () =>
    Effect.gen(function* () {
      for (const url of [
        "http://127.0.0.2:8000/",
        "http://localhost.:8000/",
        "http://[::ffff:127.0.0.1]:8000/",
      ]) {
        const published: Array<{ target: string; port: number }> = [];
        expect(yield* resolve(url, makeLayer({ workspaceRoot: IDEA, published }))).toBe(
          "http://node.tailnet.ts.net:21001/",
        );
        expect(published).toEqual([{ target: IDEA, port: 8000 }]);
      }
    }),
  );

  it.effect("maps once: only a flagged address published for this workspace loads as given", () =>
    Effect.gen(function* () {
      const published: Array<{ target: string; port: number }> = [];
      // Workspace port 3000 is published on host port 5000.
      const layer = makeLayer({
        workspaceRoot: IDEA,
        published,
        previews: { [IDEA]: ["http://127.0.0.1:5000/"], [OTHER]: ["http://127.0.0.1:5001/"] },
      });
      const resolveWith = (url: string, alreadyResolved?: boolean) =>
        Effect.gen(function* () {
          const preview = yield* TrellisPreview.TrellisPreview;
          return yield* preview.resolveUrl(threadId, url, { alreadyResolved });
        }).pipe(Effect.provide(layer));

      // The earlier hop's result, flagged, loads as given.
      expect(yield* resolveWith("http://127.0.0.1:5000/x", true)).toBe("http://127.0.0.1:5000/x");
      expect(published).toEqual([]);
      // Unflagged, `localhost:5000` is the workspace's own port 5000, not the relay for 3000.
      expect(yield* resolveWith("http://localhost:5000/")).toBe(
        "http://node.tailnet.ts.net:21001/",
      );
      expect(published).toEqual([{ target: IDEA, port: 5000 }]);
      // The flag vouches only for this workspace's published addresses.
      expect(yield* resolveWith("http://127.0.0.1:5001/", true)).toBe(
        "http://node.tailnet.ts.net:21001/",
      );
      expect(yield* resolveWith("http://localhost:5000/", true)).toBe(
        "http://node.tailnet.ts.net:21001/",
      );
      expect(published).toEqual([
        { target: IDEA, port: 5000 },
        { target: IDEA, port: 5001 },
        { target: IDEA, port: 5000 },
      ]);
    }),
  );

  it.effect("loads T3's own signed asset URLs, and only those, as given", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trellis-asset-" });
      const file = path.join(dir, "report.html");
      yield* fileSystem.writeFileString(file, "<p>report</p>");
      const asset = yield* issueAssetUrl({
        resource: { _tag: "media-file", threadId, path: file },
      });
      const published: Array<{ target: string; port: number }> = [];
      const layer = makeLayer({ workspaceRoot: IDEA, published });
      const assetUrl = `http://localhost:3773${asset.relativeUrl}`;
      expect(yield* resolve(assetUrl, layer)).toBe(assetUrl);
      expect(published).toEqual([]);
      // The path alone proves nothing: a forged token is a workspace URL.
      const forged = "http://localhost:3773/api/assets/forged.token/report.html";
      expect(yield* resolve(forged, layer)).toBe(
        "http://node.tailnet.ts.net:21001/api/assets/forged.token/report.html",
      );
      expect(published).toEqual([{ target: IDEA, port: 3773 }]);
    }).pipe(Effect.provide(AssetLayer), Effect.scoped),
  );

  it.effect("fails instead of falling back to the host when Trellis cannot publish", () =>
    Effect.gen(function* () {
      const error = yield* resolve(
        "http://localhost:5173/",
        makeLayer({ workspaceRoot: IDEA, fail: true, published: [] }),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("PreviewTrellisError");
      expect(error.message).toContain("workspace is not running");
    }),
  );

  it.effect("fails on a read-model error instead of loading the host's localhost", () =>
    Effect.gen(function* () {
      const layer = makeLayer({ workspaceRoot: IDEA, readFails: true, published: [] });
      const error = yield* resolve("http://localhost:5173/", layer).pipe(Effect.flip);
      expect(error._tag).toBe("PreviewTrellisError");
      // Non-loopback URLs never need the read model.
      expect(yield* resolve("https://example.com/", layer)).toBe("https://example.com/");
    }),
  );

  it.effect("leaves the URL unchanged for a thread that does not exist", () =>
    Effect.gen(function* () {
      const url = yield* resolve(
        "http://localhost:5173/",
        makeLayer({ workspaceRoot: IDEA, missingThread: true, published: [] }),
      );
      expect(url).toBe("http://localhost:5173/");
    }),
  );

  it.effect("maps an environment port target", () =>
    Effect.gen(function* () {
      const url = yield* Effect.gen(function* () {
        const preview = yield* TrellisPreview.TrellisPreview;
        return yield* preview.resolvePort(threadId, { port: 5173, path: "settings?x=1" });
      }).pipe(Effect.provide(makeLayer({ workspaceRoot: IDEA, published: [] })));
      expect(url).toBe("http://node.tailnet.ts.net:21001/settings?x=1");
    }),
  );
  const firstServers = (layer: ReturnType<typeof makeLayer>) =>
    Effect.gen(function* () {
      const preview = yield* TrellisPreview.TrellisPreview;
      const stream = yield* preview.watchServers(threadId, []);
      if (stream === null) return null;
      return yield* stream.pipe(Stream.take(1), Stream.runCollect);
    }).pipe(Effect.provide(layer));

  it.effect(
    "discovers a Trellis thread's servers in its workspace, a host thread's on the host",
    () =>
      Effect.gen(function* () {
        const ports = { "ws-1": [port(8123, "0.0.0.0")], "ws-2": [port(3000, "127.0.0.1")] };
        const trellisServers = yield* firstServers(
          makeLayer({ workspaceRoot: IDEA, published: [], ports }),
        );
        expect(trellisServers?.map((servers) => servers.map((server) => server.url))).toEqual([
          ["http://localhost:8123"],
        ]);
        // null: the caller keeps the host scanner's results.
        expect(
          yield* firstServers(makeLayer({ workspaceRoot: "/home/me/code", published: [], ports })),
        ).toBeNull();
      }),
  );

  it.effect("shows no servers, never the host's, when the workspace cannot be asked", () =>
    Effect.gen(function* () {
      // Not running.
      expect(yield* firstServers(makeLayer({ workspaceRoot: IDEA, published: [] }))).toEqual([[]]);
      // Its localhost is neither the workspace's nor safely the host's.
      expect(
        yield* firstServers(
          makeLayer({
            workspaceRoot: IDEA,
            worktreePath: "/home/me/wt",
            published: [],
            ports: { "ws-1": [port(8123, "0.0.0.0")] },
          }),
        ),
      ).toEqual([[]]);
    }),
  );
});
