import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId, type ProviderEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { makeCodexSessionRuntime, type CodexSideChatEvent } from "./CodexSessionRuntime.ts";

const makeRuntime = (failInject = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-side-test-" });
    const log = path.join(dir, "requests.jsonl");
    const source = yield* fs.readFileString(
      path.join(import.meta.dirname, "fixtures/codex-side-chat-peer.mjs"),
    );
    const binaryPath = yield* Effect.sync(() =>
      writeFakeCli({ directory: dir, name: "codex-peer", source }),
    );
    const runtimeScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(runtimeScope, Exit.void));
    const runtime = yield* makeCodexSessionRuntime({
      threadId: ThreadId.make("t3-parent"),
      binaryPath,
      cwd: dir,
      runtimeMode: "approval-required",
      appServerArgs: ["-c", 'mcp_servers.t3-code.url="http://localhost/mcp"'],
      mcpCapabilities: new Set(["pull-requests", "device"]),
      environment: {
        ...process.env,
        SIDE_TEST_LOG: log,
        ...(failInject ? { SIDE_TEST_FAIL_INJECT: "1" } : {}),
      },
    }).pipe(Effect.provideService(Scope.Scope, runtimeScope));
    yield* runtime.start();
    return {
      runtime,
      readRequests: fs.readFileString(log).pipe(
        Effect.map((contents) =>
          contents
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> }),
        ),
      ),
    };
  });

it.layer(NodeServices.layer)("native Codex side conversations", (it) => {
  it.effect(
    "isolates side streaming and approvals, preserves parent session, and detaches on close",
    () =>
      Effect.gen(function* () {
        const { runtime, readRequests } = yield* makeRuntime();
        const parentEvents: ProviderEvent[] = [];
        const sideEvents: CodexSideChatEvent[] = [];
        const approval = yield* Deferred.make<ProviderEvent>();
        const completed = yield* Deferred.make<void>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              parentEvents.push(event);
            }),
          ),
          Effect.forkScoped,
        );
        yield* runtime.sideChatEvents.pipe(
          Stream.runForEach((entry) =>
            Effect.gen(function* () {
              sideEvents.push(entry);
              if (entry.event.kind === "request") yield* Deferred.succeed(approval, entry.event);
              if (entry.event.method === "turn/completed")
                yield* Deferred.succeed(completed, undefined);
            }),
          ),
          Effect.forkScoped,
        );
        const parentBefore = yield* runtime.getSession;
        const side = yield* runtime.openSideChat;
        assert.equal((yield* runtime.openSideChat).id, side.id);
        assert.equal(side.effort, "high");
        yield* runtime.sendSideChat(side.id, {
          input: "Question",
          model: "gpt-5.3-codex",
          effort: "low",
          runtimeMode: "full-access",
          interactionMode: "plan",
        });
        const request = yield* Deferred.await(approval);
        assert.isDefined(request.requestId);
        yield* runtime.respondToRequest(request.requestId!, "accept");
        yield* Deferred.await(completed);
        assert.deepEqual(yield* runtime.getSession, parentBefore);
        assert.isFalse(
          parentEvents.some(
            (event) =>
              event.kind === "request" ||
              event.method === "turn/started" ||
              event.textDelta === "Side answer",
          ),
        );
        assert.isTrue(
          sideEvents.some(({ event }) => event.method === "item/requestApproval/decision"),
        );
        assert.isTrue(sideEvents.some(({ event }) => event.textDelta === "Side answer"));
        yield* runtime.sendSideChat(side.id, { input: "hold" });
        yield* runtime.closeSideChat(side.id);
        const stale = yield* runtime
          .sendSideChat(side.id, { input: "After close" })
          .pipe(Effect.flip);
        assert.match(stale.message, /side chat has ended/);
        const requests = yield* readRequests;
        assert.equal(requests.filter((request) => request.method === "thread/fork").length, 1);
        const fork = requests.find((request) => request.method === "thread/fork")!;
        assert.equal(fork.params.ephemeral, true);
        assert.equal(fork.params.excludeTurns, true);
        assert.match(String(fork.params.developerInstructions), /Existing developer policy/);
        assert.match(
          String(fork.params.developerInstructions),
          /inherited fork history is provided only as reference/,
        );
        assert.deepEqual(
          requests.slice(-2).map((request) => request.method),
          ["turn/interrupt", "thread/unsubscribe"],
        );
        const turn = requests.find((request) => request.method === "turn/start")!;
        const collaborationMode = turn.params.collaborationMode as {
          settings: { developer_instructions: string };
        };
        assert.include(collaborationMode.settings.developer_instructions, "device_list");
        assert.notInclude(collaborationMode.settings.developer_instructions, "preview_status");
        assert.equal(turn.params.effort, "low");
        assert.deepEqual(turn.params.sandboxPolicy, { type: "dangerFullAccess" });
      }),
  );

  it.effect("unsubscribes a fork when hidden-boundary injection fails", () =>
    Effect.gen(function* () {
      const { runtime, readRequests } = yield* makeRuntime(true);
      const result = yield* runtime.openSideChat.pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.deepEqual(
        (yield* readRequests).slice(-2).map((request) => request.method),
        ["thread/inject_items", "thread/unsubscribe"],
      );
      assert.equal(
        (yield* runtime.getSession).resumeCursor &&
          ((yield* runtime.getSession).resumeCursor as { threadId: string }).threadId,
        "parent",
      );
    }),
  );
});
