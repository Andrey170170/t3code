import { ProjectId, ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { TrellisError } from "@t3tools/contracts";
import { Trellis, makeTestTrellis } from "./Trellis.ts";
import * as TrellisPreview from "./TrellisPreview.ts";

const ROOT = "/trellis";
const IDEA = `${ROOT}/workspaces/ws-1/project/idea-1`;
const threadId = ThreadId.make("thread-1");

describe("loopbackPort", () => {
  it("detects loopback hosts with explicit and default ports", () => {
    expect(TrellisPreview.loopbackPort("http://localhost:5173/x")).toBe(5173);
    expect(TrellisPreview.loopbackPort("http://127.0.0.1:3000")).toBe(3000);
    expect(TrellisPreview.loopbackPort("http://[::1]:8080/")).toBe(8080);
    expect(TrellisPreview.loopbackPort("http://0.0.0.0:4000")).toBe(4000);
    expect(TrellisPreview.loopbackPort("localhost:5173")).toBe(5173);
    expect(TrellisPreview.loopbackPort("http://localhost/")).toBe(80);
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

describe("TrellisPreview service", () => {
  const makeLayer = (input: {
    readonly workspaceRoot: string;
    readonly fail?: boolean;
    readonly readFails?: boolean;
    readonly missingThread?: boolean;
    readonly published: Array<{ target: string; port: number }>;
  }) => {
    const unused = () => Effect.die(new Error("unused"));
    const env = { root: ROOT, bin: "trellis", shimDir: null };
    return TrellisPreview.layer.pipe(
      Layer.provide(
        Layer.succeed(Trellis, {
          ...makeTestTrellis({ env }),
          current: Effect.succeed(env),
          refresh: Effect.succeed(env),
          expectedRoot: Effect.succeed(ROOT),
          bin: "trellis",
          listWorkspaces: unused,
          listProjects: unused,
          createIdea: unused,
          createProject: unused,
          describe: unused,
          find: unused,
          resolve: unused,
          listSnapshots: unused,
          createSnapshot: unused,
          rollback: unused,
          preview: (request) =>
            input.fail
              ? Effect.fail(new TrellisError({ message: "workspace is not running" }))
              : Effect.sync(() => {
                  input.published.push(request);
                  return { hostPort: 21001, url: "http://node.tailnet.ts.net:21001/" };
                }),
          primer: unused,
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: () =>
            input.readFails
              ? Effect.fail(
                  new PersistenceSqlError({ operation: "test", detail: "database is locked" }),
                )
              : Effect.succeed(
                  input.missingThread
                    ? Option.none()
                    : Option.some({ projectId: ProjectId.make("p"), worktreePath: null } as never),
                ),
          getProjectShellById: () =>
            Effect.succeed(Option.some({ workspaceRoot: input.workspaceRoot } as never)),
        }),
      ),
    );
  };

  const resolve = (url: string, layer: ReturnType<typeof makeLayer>) =>
    Effect.gen(function* () {
      const preview = yield* TrellisPreview.TrellisPreview;
      return yield* preview.resolveUrl(threadId, url);
    }).pipe(Effect.provide(layer));

  it.effect("maps a loopback URL of a Trellis thread to the workspace preview", () =>
    Effect.gen(function* () {
      const published: Array<{ target: string; port: number }> = [];
      const url = yield* resolve(
        "http://localhost:5173/a?b=1#c",
        makeLayer({ workspaceRoot: IDEA, published }),
      );
      expect(url).toBe("http://node.tailnet.ts.net:21001/a?b=1#c");
      expect(published).toEqual([{ target: IDEA, port: 5173 }]);
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
});
