// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { it } from "@effect/vitest";
import { afterEach, describe, expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import * as Trellis from "./Trellis.ts";

// Talks to a fake Trellis API on a real Unix socket.
describe("Trellis client", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    while (cleanup.length > 0) cleanup.pop()?.();
  });

  function setup(
    handler: (request: { method: string; url: string; body: string }) => {
      readonly status?: number;
      readonly body: unknown;
    },
  ) {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-trellis-client-"));
    const socketPath = NodePath.join(dir, "api.sock");
    const requests: Array<{ method: string; url: string; body: string }> = [];
    const server = NodeHttp.createServer((request, response) => {
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const entry = {
          method: request.method ?? "",
          url: request.url ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        };
        requests.push(entry);
        const result = handler(entry);
        response.writeHead(result.status ?? 200, { "content-type": "application/json" });
        response.end(JSON.stringify(result.body));
      });
    });
    // A stand-in for `trellis shims --dir <dir>`.
    const bin = NodePath.join(dir, "trellis");
    NodeFS.writeFileSync(bin, '#!/bin/sh\nmkdir -p "$3" && touch "$3/codex" "$3/claude"\n', {
      mode: 0o755,
    });
    cleanup.push(() => {
      server.close();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    });
    const layer = (socket: string) =>
      Trellis.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-trellis-client-" })),
        Layer.provide(NodeServices.layer),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { TRELLIS_SOCKET: socket, TRELLIS_BIN: bin } }),
          ),
        ),
      );
    return {
      requests,
      socketPath,
      bin,
      missingLayer: layer(NodePath.join(dir, "missing.sock")),
      listen: () =>
        new Promise<ReturnType<typeof layer>>((resolve) =>
          server.listen(socketPath, () => resolve(layer(socketPath))),
        ),
    };
  }

  it.effect("is disabled when the socket is absent", () =>
    Effect.gen(function* () {
      const harness = setup(() => ({ body: {} }));
      const current = yield* Effect.gen(function* () {
        const trellis = yield* Trellis.Trellis;
        return yield* trellis.current;
      }).pipe(Effect.provide(harness.missingLayer));
      expect(current).toBeNull();
    }),
  );

  it.effect("reads status, creates shims and decodes responses and errors", () =>
    Effect.gen(function* () {
      const harness = setup(({ url }) => {
        if (url === "/v1/status") return { body: { root: "/trellis", role: "user" } };
        if (url.startsWith("/v1/describe"))
          return { status: 404, body: { error: "unknown target" } };
        return { body: [] };
      });
      const layer = yield* Effect.promise(harness.listen);
      const result = yield* Effect.gen(function* () {
        const trellis = yield* Trellis.Trellis;
        const current = yield* trellis.current;
        const projects = yield* trellis.listProjects({ all: true });
        const error = yield* trellis.describe({ target: "/x", name: "Name" }).pipe(Effect.flip);
        return { current, projects, error };
      }).pipe(Effect.provide(layer));
      expect(result.current?.root).toBe("/trellis");
      expect(result.current?.shimDir).toMatch(/trellis-shims$/);
      expect(result.projects).toEqual([]);
      expect(result.error.message).toBe("unknown target");
      expect(harness.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "GET /v1/status",
        "GET /v1/projects?light=true&all=true",
        "POST /v1/describe",
      ]);
      expect(harness.requests[2]?.body).toBe('{"target":"/x","name":"Name","pin":true}');
    }),
  );
});
