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
import * as Option from "effect/Option";
import { afterEach, describe, expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
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
      /** Sent as is instead of `body` as JSON. */
      readonly raw?: string;
    },
  ) {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-trellis-client-"));
    // The conventional `<root>/state/api.sock`, so `<root>` is implied.
    NodeFS.mkdirSync(NodePath.join(dir, "state"));
    const socketPath = NodePath.join(dir, "state", "api.sock");
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
        response.end(result.raw ?? JSON.stringify(result.body));
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
    const layer = (socket: string, enabled = true) =>
      Trellis.layer.pipe(
        Layer.provide(ServerSettings.layerTest({ trellis: { enabled } })),
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
      dir,
      layer,
      socketPath,
      bin,
      missingLayer: layer(NodePath.join(dir, "missing.sock")),
      listen: (enabled = true) =>
        new Promise<ReturnType<typeof layer>>((resolve) =>
          server.listen(socketPath, () => resolve(layer(socketPath, enabled))),
        ),
    };
  }

  it.effect("is disabled when the socket is absent", () =>
    Effect.gen(function* () {
      const harness = setup(() => ({ body: {} }));
      const result = yield* Effect.gen(function* () {
        const trellis = yield* Trellis.Trellis;
        return { refreshed: yield* trellis.refresh, connection: yield* trellis.connection };
      }).pipe(Effect.provide(harness.missingLayer));
      expect(result.refreshed).toBeNull();
      expect(result.connection.state).toBe("unavailable");
    }),
  );

  it.effect("never touches the socket while the integration is off", () =>
    Effect.gen(function* () {
      const harness = setup(() => ({ body: { root: "/trellis" } }));
      const layer = yield* Effect.promise(() => harness.listen(false));
      const result = yield* Effect.gen(function* () {
        const trellis = yield* Trellis.Trellis;
        const refreshed = yield* trellis.refresh;
        const error = yield* trellis.listProjects({ all: true }).pipe(Effect.flip);
        return {
          refreshed,
          error,
          connection: yield* trellis.connection,
          expectedRoots: yield* trellis.expectedRoots,
        };
      }).pipe(Effect.provide(layer));
      expect(result.refreshed).toBeNull();
      expect(result.error.message).toContain("turned off");
      expect(result.connection.state).toBe("disabled");
      // Trellis paths stay recognizable without asking Trellis.
      expect(result.expectedRoots).toContain(
        NodePath.dirname(NodePath.dirname(harness.socketPath)),
      );
      expect(harness.requests).toEqual([]);
    }),
  );

  it.effect("probes an unavailable Trellis once per interval, shared by concurrent callers", () =>
    Effect.gen(function* () {
      const harness = setup(() => ({ status: 503, body: { error: "starting" } }));
      const layer = yield* Effect.promise(() => harness.listen());
      const workspace = NodePath.join(NodePath.dirname(harness.bin), "workspace");
      const alias = NodePath.join(NodePath.dirname(harness.bin), "alias");
      NodeFS.mkdirSync(workspace);
      NodeFS.symlinkSync(workspace, alias);
      const result = yield* Effect.gen(function* () {
        const trellis = yield* Trellis.Trellis;
        const [first] = yield* Effect.all(
          [trellis.discover, trellis.discover, trellis.expectedRoots],
          { concurrency: "unbounded" },
        );
        yield* trellis.expectedRoots;
        const second = yield* trellis.discover;
        return {
          first,
          second,
          canonical: yield* trellis.canonicalPath(alias),
          missing: yield* trellis.canonicalPath(`${alias}-missing`),
        };
      }).pipe(Effect.provide(layer));
      expect(result.first).toBeNull();
      expect(result.second).toBeNull();
      expect(harness.requests.map((request) => request.url)).toEqual(["/v1/status"]);
      expect(result.canonical).toBe(NodeFS.realpathSync(workspace));
      expect(result.missing).toBe(`${alias}-missing`);
    }),
  );

  it.effect("names paths under a symlinked Trellis root as that root", () =>
    Effect.gen(function* () {
      const harness = setup(() => ({ body: {} }));
      // `link` is the configured root; it points at the real one.
      const link = `${harness.dir}-link`;
      NodeFS.symlinkSync(harness.dir, link);
      cleanup.push(() => NodeFS.rmSync(link, { force: true }));
      const project = NodePath.join(harness.dir, "workspaces", "ws-1", "project");
      NodeFS.mkdirSync(project, { recursive: true });
      const alias = NodePath.join(harness.dir, "alias");
      NodeFS.symlinkSync(project, alias);
      const host = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-trellis-host-"));
      cleanup.push(() => NodeFS.rmSync(host, { recursive: true, force: true }));
      const result = yield* Effect.gen(function* () {
        const trellis = yield* Trellis.Trellis;
        return {
          real: yield* trellis.canonicalPath(project),
          alias: yield* trellis.canonicalPath(alias),
          host: yield* trellis.canonicalPath(host),
          refused: yield* Trellis.refuseWorktreeIn(
            Option.some(trellis),
            alias,
            (detail) => detail,
          ).pipe(Effect.flip),
        };
      }).pipe(Effect.provide(harness.layer(NodePath.join(link, "state", "api.sock"), false)));
      const linked = NodePath.join(link, "workspaces", "ws-1", "project");
      expect(result.real).toBe(linked);
      expect(result.alias).toBe(linked);
      expect(result.host).toBe(NodeFS.realpathSync(host));
      expect(result.refused).toBe(Trellis.TRELLIS_WORKTREE_REFUSAL);
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
      const layer = yield* Effect.promise(() => harness.listen());
      const result = yield* Effect.gen(function* () {
        const trellis = yield* Trellis.Trellis;
        yield* trellis.refresh;
        const current = yield* trellis.current;
        const projects = yield* trellis.listProjects({ all: true });
        const error = yield* trellis.describe({ target: "/x", name: "Name" }).pipe(Effect.flip);
        const status = yield* Trellis.readTrellisStatus(trellis);
        return { current, projects, error, status };
      }).pipe(Effect.provide(layer));
      expect(result.current?.root).toBe("/trellis");
      expect(result.status).toEqual({
        state: "ready",
        root: "/trellis",
        knownRoots: ["/trellis", NodePath.dirname(NodePath.dirname(harness.socketPath))],
        socketPath: harness.socketPath,
      });
      expect(result.current?.shimDir).toMatch(/trellis-shims$/);
      expect(result.projects).toEqual([]);
      expect(result.error.message).toBe("unknown target");
      expect(harness.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "GET /v1/status",
        "GET /v1/projects?light=true&all=true",
        "POST /v1/describe",
        // A status read asks Trellis again.
        "GET /v1/status",
      ]);
      expect(harness.requests[2]?.body).toBe(
        '{"target":"/x","name":"Name","source":"user","pin":true}',
      );
    }),
  );

  it.effect("follows the agent homes Trellis reports, also across a restart", () =>
    Effect.gen(function* () {
      let agentHomes: unknown = { claude: "/dev/homes/claude", codex: null };
      const harness = setup(({ url }) =>
        url === "/v1/status"
          ? { body: { root: "/trellis", role: "user", agent_homes: agentHomes } }
          : { body: [] },
      );
      const layer = yield* Effect.promise(() => harness.listen());
      const homes = yield* Effect.gen(function* () {
        const trellis = yield* Trellis.Trellis;
        const first = (yield* trellis.refresh)?.agentHomes;
        agentHomes = { claude: "/home/me/.claude", codex: "/home/me/.codex" };
        const second = (yield* trellis.refresh)?.agentHomes;
        // An older Trellis reports none: the default homes are assumed.
        agentHomes = undefined;
        const third = (yield* trellis.refresh)?.agentHomes;
        return { first, second, third };
      }).pipe(Effect.provide(layer));
      expect(homes).toEqual({
        first: { claude: "/dev/homes/claude", codex: null },
        second: { claude: "/home/me/.claude", codex: "/home/me/.codex" },
        third: undefined,
      });
    }),
  );

  it.effect("tells a checkpoint refused before the stop from one that failed after it", () =>
    Effect.gen(function* () {
      const bodies = [
        // Refused on another thread's open turn: nothing ran.
        {
          error: "checkpoint failed: other threads are mid-turn here: th-2",
          details: { restarted: false, stopped: [], ms: { wait: 0, stop: 0 }, turns: [] },
        },
        // The snapshot failed after the stop; Trellis restarted it while unwinding.
        {
          error: "checkpoint failed: snapshot failed",
          details: {
            restarted: false,
            stopped: [{ pid: 9, cmd: "npm run dev" }],
            ms: { wait: 0, stop: 412 },
          },
        },
      ];
      const harness = setup(({ url }) => {
        if (url === "/v1/status") return { body: { root: "/trellis", role: "user" } };
        return { status: 409, body: bodies.shift() };
      });
      const layer = yield* Effect.promise(() => harness.listen());
      const outcomes = yield* Effect.gen(function* () {
        const trellis = yield* Trellis.Trellis;
        yield* trellis.refresh;
        const input = { target: "/x", thread: "th-1", interrupt: false };
        return [yield* trellis.checkpoint(input), yield* trellis.checkpoint(input)];
      }).pipe(Effect.provide(layer));
      expect(outcomes).toEqual([
        {
          ok: false,
          error: "checkpoint failed: other threads are mid-turn here: th-2",
          restarted: false,
          stopped: [],
        },
        {
          ok: false,
          error: "checkpoint failed: snapshot failed",
          restarted: true,
          stopped: [{ pid: 9, cmd: "npm run dev" }],
        },
      ]);
    }),
  );

  it.effect("names a route an older Trellis lacks, and the status of other bare failures", () =>
    Effect.gen(function* () {
      const harness = setup(({ url }) => {
        if (url === "/v1/status") return { body: { root: "/trellis", role: "user" } };
        // Older Trellis: the route takes POST only, so GET is a bare 405.
        if (url.startsWith("/v1/activities")) return { status: 405, body: null, raw: "" };
        return { status: 502, body: null, raw: "Bad Gateway" };
      });
      const layer = yield* Effect.promise(() => harness.listen());
      const result = yield* Effect.gen(function* () {
        const trellis = yield* Trellis.Trellis;
        yield* trellis.refresh;
        const missing = yield* trellis
          .listActivities({ target: "/x", kind: "rollback" })
          .pipe(Effect.flip);
        const failed = yield* trellis.listProjects({ all: false }).pipe(Effect.flip);
        return { missing, failed };
      }).pipe(Effect.provide(layer));
      expect(result.missing.message).toBe(
        "This Trellis does not support GET /v1/activities, which T3 needs here. Update Trellis to main at or after PR #15 (core/checkpoint, d949d28).",
      );
      expect(result.failed.message).toBe("Trellis answered GET /v1/projects with HTTP 502.");
    }),
  );

  it.effect("lists a workspace's listening ports, and refuses a stopped one", () =>
    Effect.gen(function* () {
      const harness = setup(({ url }) => {
        if (url === "/v1/status") return { body: { root: "/trellis", role: "user" } };
        if (url === "/v1/workspaces/ws-1/ports")
          return {
            body: [
              { port: 8123, address: "0.0.0.0", reachable: true, preview: null },
              {
                port: 5173,
                address: "127.0.0.1",
                reachable: true,
                preview: "http://node:21001/",
              },
            ],
          };
        return { status: 400, body: { error: "workspace ws-2 is not running" } };
      });
      const layer = yield* Effect.promise(() => harness.listen());
      const result = yield* Effect.gen(function* () {
        const trellis = yield* Trellis.Trellis;
        yield* trellis.refresh;
        return {
          ports: yield* trellis.ports("ws-1"),
          stopped: yield* trellis.ports("ws-2").pipe(Effect.flip),
        };
      }).pipe(Effect.provide(layer));
      expect(result.ports).toEqual([
        { port: 8123, address: "0.0.0.0", reachable: true, preview: null },
        { port: 5173, address: "127.0.0.1", reachable: true, preview: "http://node:21001/" },
      ]);
      expect(result.stopped.message).toBe("workspace ws-2 is not running");
    }),
  );

  it.effect("decodes the full status for display, reading absent fields as unknown", () =>
    Effect.gen(function* () {
      let body: unknown = {
        root: "/trellis",
        role: "user",
        version: "0.1.0",
        commit: "abc1234-dirty.5f2e",
        pid: 42,
        started_at: 1_700_000_000,
        uptime_secs: 93_784,
        bases: ["dev", "py"],
        base_states: { dev: "stale", py: "custom" },
        default_base: "dev",
        node: "local",
        missing_providers: ["codex"],
        preview_host: { setting: "tailscale", bind: "100.64.0.2", url_host: "node.tail.ts.net" },
        agent_homes: { claude: "/homes/claude", codex: null },
        running_workspaces: ["ws-a", "ws-b"],
        restart_needed: [{ workspace: "ws-b", reason: "started with another trellis binary" }],
        pending_operations: [
          { id: 1, kind: "rollback", data: { ws: "ws-a" } },
          { id: 2, kind: "graduate", data: { project: "prj-1" } },
          { id: 3, kind: "purge", data: null },
        ],
        disk: { free_bytes: 1_610_612_736, total_bytes: 1_099_511_627_776 },
      };
      const harness = setup(() => ({ body }));
      const layer = yield* Effect.promise(() => harness.listen());
      const result = yield* Effect.gen(function* () {
        const trellis = yield* Trellis.Trellis;
        const full = yield* trellis.details;
        // An older Trellis reports little more than its root.
        body = { root: "/trellis", role: "user" };
        const old = yield* trellis.details;
        // Podman failed: running workspaces and restarts are unknown, not none.
        body = { root: "/trellis", running_workspaces: null, restart_needed: null, disk: null };
        const podmanFailed = yield* trellis.details;
        return { full, old, podmanFailed };
      }).pipe(Effect.provide(layer));
      expect(result.full).toEqual({
        root: "/trellis",
        version: "0.1.0",
        commit: "abc1234-dirty.5f2e",
        uptimeSecs: 93_784,
        bases: ["dev", "py"],
        baseStates: { dev: "stale", py: "custom" },
        buildingBases: [],
        baseBuildFailures: {},
        defaultBase: "dev",
        missingProviders: ["codex"],
        previewHost: { setting: "tailscale", bind: "100.64.0.2", urlHost: "node.tail.ts.net" },
        agentHomes: { claude: "/homes/claude", codex: null },
        runningWorkspaces: [
          { id: "ws-a", name: null },
          { id: "ws-b", name: null },
        ],
        restartNeeded: [{ id: "ws-b", name: null, reason: "started with another trellis binary" }],
        pendingOperations: [
          { kind: "rollback", target: "ws-a" },
          { kind: "graduate", target: "prj-1" },
          { kind: "purge", target: null },
        ],
        disk: { freeBytes: 1_610_612_736, totalBytes: 1_099_511_627_776 },
      });
      const unknown = {
        root: "/trellis",
        version: null,
        commit: null,
        uptimeSecs: null,
        bases: [],
        baseStates: null,
        buildingBases: [],
        baseBuildFailures: {},
        defaultBase: null,
        missingProviders: [],
        previewHost: null,
        agentHomes: null,
        runningWorkspaces: null,
        restartNeeded: null,
        pendingOperations: [],
        disk: null,
      };
      expect(result.old).toEqual(unknown);
      expect(result.podmanFailed).toEqual(unknown);
    }),
  );

  it.effect("builds a base and reports its state, or Trellis's refusal", () =>
    Effect.gen(function* () {
      const harness = setup(({ url, body }) =>
        url !== "/v1/bases/build"
          ? { body: { root: "/trellis" } }
          : body.includes('"dev"')
            ? { body: { name: "dev", path: "/trellis/bases/dev", state: "current" } }
            : { status: 400, body: { error: "no built-in definition for base mine" } },
      );
      const layer = yield* Effect.promise(() => harness.listen());
      const result = yield* Effect.gen(function* () {
        const trellis = yield* Trellis.Trellis;
        const built = yield* trellis.buildBase("dev");
        const refused = yield* trellis.buildBase("mine").pipe(Effect.flip);
        return { built, refused };
      }).pipe(Effect.provide(layer));
      expect(result.built).toEqual({ name: "dev", state: "current" });
      expect(result.refused.message).toBe("no built-in definition for base mine");
      expect(harness.requests.find((request) => request.url === "/v1/bases/build")?.body).toBe(
        '{"name":"dev"}',
      );
    }),
  );
  it.effect("reads and changes the history settings, passing on Trellis's refusals", () =>
    Effect.gen(function* () {
      const values = {
        timer_minutes: 1,
        turn_keep_all_days: 7,
        turn_keep_daily_days: 90,
        timer_keep_all_hours: 2,
        timer_keep_hourly_days: 7,
        idea_trash_days: 30,
        fork_trash_days: 30,
        incoming_days: 30,
      };
      let historyRoute = true;
      const harness = setup(({ method, url, body }) => {
        if (url === "/v1/status") return { body: { root: "/trellis", role: "user" } };
        if (url !== "/v1/settings/history" || !historyRoute) {
          return { status: 404, body: null, raw: "" };
        }
        if (method === "GET") {
          return {
            body: {
              // A key this T3 does not know is ignored; a missing one stays absent.
              values: { ...values, idea_trash_days: 14, future_key: 3, incoming_days: undefined },
              defaults: values,
              snapshots: { timer: 12, turn: 40 },
              last_thinning: { at: 1_700_000_000, removed: 5 },
              free_space: 1,
            },
          };
        }
        const patch = JSON.parse(body) as Record<string, number>;
        if ((patch.turn_keep_daily_days ?? 90) < 7) {
          return {
            status: 400,
            body: {
              error: `turn_keep_daily_days (${patch.turn_keep_daily_days}) must not be shorter than turn_keep_all_days (7)`,
            },
          };
        }
        return { body: { values: { ...values, ...patch }, would_remove: 3 } };
      });
      const layer = yield* Effect.promise(() => harness.listen());
      const result = yield* Effect.gen(function* () {
        const trellis = yield* Trellis.Trellis;
        const settings = yield* trellis.historySettings;
        const updated = yield* trellis.updateHistorySettings({ turnKeepAllDays: 3 });
        const everyKey = yield* trellis.updateHistorySettings({
          timerMinutes: 2,
          turnKeepAllDays: 8,
          turnKeepDailyDays: 91,
          timerKeepAllHours: 3,
          timerKeepHourlyDays: 9,
          ideaTrashDays: 10,
          forkTrashDays: 11,
          incomingDays: 0,
        });
        const refused = yield* trellis
          .updateHistorySettings({ turnKeepDailyDays: 2 })
          .pipe(Effect.flip);
        historyRoute = false;
        const older = yield* trellis.historySettings.pipe(Effect.flip);
        return { settings, updated, everyKey, refused, older };
      }).pipe(Effect.provide(layer));
      const defaults = {
        timerMinutes: 1,
        turnKeepAllDays: 7,
        turnKeepDailyDays: 90,
        timerKeepAllHours: 2,
        timerKeepHourlyDays: 7,
        ideaTrashDays: 30,
        forkTrashDays: 30,
        incomingDays: 30,
      };
      const { incomingDays: _, ...withoutIncoming } = defaults;
      expect(result.settings).toEqual({
        values: { ...withoutIncoming, ideaTrashDays: 14 },
        defaults,
        snapshots: { timer: 12, turn: 40 },
        lastThinning: { at: 1_700_000_000, removed: 5 },
      });
      // Only the changed key goes out, in Trellis's name.
      expect(
        harness.requests
          .filter((request) => request.method === "PUT")
          .map((request) => JSON.parse(request.body)),
      ).toEqual([
        { turn_keep_all_days: 3 },
        {
          timer_minutes: 2,
          turn_keep_all_days: 8,
          turn_keep_daily_days: 91,
          timer_keep_all_hours: 3,
          timer_keep_hourly_days: 9,
          idea_trash_days: 10,
          fork_trash_days: 11,
          incoming_days: 0,
        },
        { turn_keep_daily_days: 2 },
      ]);
      expect(result.everyKey.values).toEqual({
        timerMinutes: 2,
        turnKeepAllDays: 8,
        turnKeepDailyDays: 91,
        timerKeepAllHours: 3,
        timerKeepHourlyDays: 9,
        ideaTrashDays: 10,
        forkTrashDays: 11,
        incomingDays: 0,
      });
      expect(result.updated).toEqual({
        values: { ...defaults, turnKeepAllDays: 3 },
        wouldRemove: 3,
      });
      expect(result.refused.message).toBe(
        "turn_keep_daily_days (2) must not be shorter than turn_keep_all_days (7)",
      );
      expect(result.older.message).toBe(
        "This Trellis does not support GET /v1/settings/history, which T3 needs here. Update Trellis to main at or after PR #40 (records/history-settings, 0bed1e8).",
      );
    }),
  );

  it.effect("runs maintenance through the user socket", () =>
    Effect.gen(function* () {
      const harness = setup(({ url }) =>
        url === "/v1/maintenance" ? { body: { ok: true } } : { body: { root: "/trellis" } },
      );
      const layer = yield* Effect.promise(() => harness.listen());
      yield* Effect.flatMap(Trellis.Trellis, (trellis) => trellis.runMaintenance).pipe(
        Effect.provide(layer),
      );
      expect(
        harness.requests.some(
          (request) => request.method === "POST" && request.url === "/v1/maintenance",
        ),
      ).toBe(true);
    }),
  );
  it.effect("changes where previews listen and reports what could not be bound", () =>
    Effect.gen(function* () {
      const harness = setup(({ url, body }) =>
        url !== "/v1/settings/previews"
          ? { body: { root: "/trellis" } }
          : body.includes('"lan"')
            ? {
                body: {
                  preview_host: { setting: "lan", bind: "192.168.1.5", url_host: "192.168.1.5" },
                  errors: [{ workspace: "ws-a", port: 3000, error: "address in use" }],
                },
              }
            : {
                status: 400,
                body: { error: "preview_host must be lan, tailscale or an IP address" },
              },
      );
      const layer = yield* Effect.promise(() => harness.listen());
      const result = yield* Effect.gen(function* () {
        const trellis = yield* Trellis.Trellis;
        return {
          lan: yield* trellis.setPreviewHost("lan"),
          refused: yield* trellis.setPreviewHost("nowhere").pipe(Effect.flip),
        };
      }).pipe(Effect.provide(layer));
      expect(result.lan).toEqual({
        previewHost: { setting: "lan", bind: "192.168.1.5", urlHost: "192.168.1.5" },
        errors: [{ workspace: "ws-a", port: 3000, error: "address in use" }],
      });
      expect(result.refused.message).toBe("preview_host must be lan, tailscale or an IP address");
      expect(harness.requests.find((request) => request.method === "PUT")?.body).toBe(
        '{"preview_host":"lan"}',
      );
    }),
  );
});

describe("parseKnownRoots", () => {
  it("keeps absolute roots and drops `/`, which would claim every host path", () => {
    expect(Trellis.parseKnownRoots("/trellis\n/\n//\nrelative\n /trellis/dev/ \n\n")).toEqual([
      "/trellis",
      "/trellis/dev",
    ]);
  });
});

describe("refuseWorktreeIn", () => {
  const trellis = Option.some(
    Trellis.makeTestTrellis({ expectedRoots: Effect.succeed(["/trellis"]) }),
  );
  it.effect("refuses git worktrees of Trellis project paths only", () =>
    Effect.gen(function* () {
      const refused = yield* Trellis.refuseWorktreeIn(
        trellis,
        "/trellis/workspaces/ws-1/project",
        (detail) => detail,
      ).pipe(Effect.flip);
      expect(refused).toBe(Trellis.TRELLIS_WORKTREE_REFUSAL);
      yield* Trellis.refuseWorktreeIn(trellis, "/home/me/code", (detail) => detail);
      // A symlink to a workspace path is refused as the path it resolves to.
      const aliased = Option.some(
        Trellis.makeTestTrellis({
          expectedRoots: Effect.succeed(["/trellis"]),
          canonicalPath: (path) =>
            Effect.succeed(
              path === "/home/me/idea" ? "/trellis/workspaces/ws-1/project/idea" : path,
            ),
        }),
      );
      const refusedAlias = yield* Trellis.refuseWorktreeIn(
        aliased,
        "/home/me/idea",
        (detail) => detail,
      ).pipe(Effect.flip);
      expect(refusedAlias).toBe(Trellis.TRELLIS_WORKTREE_REFUSAL);
      yield* Trellis.refuseWorktreeIn(
        Option.none(),
        "/trellis/workspaces/ws-1/project",
        (detail) => detail,
      );
    }),
  );
});

describe("refuseOfflineTrellisProjectDelete", () => {
  it.effect(
    "refuses projects under a recorded Trellis root, and when the record is unreadable",
    () =>
      Effect.gen(function* () {
        const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-trellis-cli-"));
        NodeFS.writeFileSync(NodePath.join(stateDir, "trellis-root"), "/trellis\n");
        const refusal = yield* Trellis.refuseOfflineTrellisProjectDelete({
          stateDir,
          workspaceRoot: "/trellis/workspaces/ws-1/project",
          title: "Engine",
        }).pipe(Effect.flip);
        expect(refusal.message).toContain("Trellis trash");
        yield* Trellis.refuseOfflineTrellisProjectDelete({
          stateDir,
          workspaceRoot: "/home/me/code",
          title: "Code",
        });
        // A root file that exists but cannot be read refuses; a missing one allows.
        NodeFS.rmSync(NodePath.join(stateDir, "trellis-root"));
        NodeFS.mkdirSync(NodePath.join(stateDir, "trellis-root"));
        const unreadable = yield* Trellis.refuseOfflineTrellisProjectDelete({
          stateDir,
          workspaceRoot: "/home/me/code",
          title: "Code",
        }).pipe(Effect.flip);
        expect(unreadable.message).toContain("Could not read the recorded Trellis roots");
        NodeFS.rmSync(NodePath.join(stateDir, "trellis-root"), { recursive: true });
        yield* Trellis.refuseOfflineTrellisProjectDelete({
          stateDir,
          workspaceRoot: "/trellis/workspaces/ws-1/project",
          title: "Engine",
        });
        NodeFS.rmSync(stateDir, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
