import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, vi } from "vite-plus/test";

import {
  claudeProjectSlug,
  hasClaudeTranscript,
  prepareClaudeTranscript,
} from "./TrellisClaudeTranscripts.ts";

const sessionId = "11111111-2222-4333-8444-555555555555";

/** A transcript the SDK accepts: one user message and its reply. */
const transcript = (cwd: string) =>
  [
    {
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: "hello" },
      uuid: "aaaaaaaa-0000-4000-8000-000000000001",
      timestamp: "2026-09-30T00:00:00.000Z",
      cwd,
      sessionId,
      version: "2.1.285",
      userType: "external",
    },
    {
      parentUuid: "aaaaaaaa-0000-4000-8000-000000000001",
      isSidechain: false,
      type: "assistant",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      uuid: "aaaaaaaa-0000-4000-8000-000000000002",
      timestamp: "2026-09-30T00:00:01.000Z",
      cwd,
      sessionId,
      version: "2.1.285",
      userType: "external",
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n") + "\n";

/** A config dir with workspace folders A and B; the session starts in A. */
const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-transcripts-" }),
  );
  const configDir = path.join(root, "config");
  const a = path.join(root, "a");
  const b = path.join(root, "b");
  yield* fileSystem.makeDirectory(a);
  yield* fileSystem.makeDirectory(b);
  const slugA = path.join(configDir, "projects", claudeProjectSlug(a));
  const slugB = path.join(configDir, "projects", claudeProjectSlug(b));
  yield* fileSystem.makeDirectory(path.join(slugA, sessionId, "subagents"), { recursive: true });
  yield* fileSystem.writeFileString(path.join(slugA, `${sessionId}.jsonl`), transcript(a));
  yield* fileSystem.writeFileString(
    path.join(slugA, sessionId, "subagents", "agent-1.jsonl"),
    "{}\n",
  );
  yield* fileSystem.makeDirectory(path.join(slugA, "memory"));
  yield* fileSystem.writeFileString(path.join(slugA, "memory", "MEMORY.md"), "from A\n");
  yield* fileSystem.writeFileString(path.join(slugA, "memory", "notes.md"), "notes\n");
  const read = (file: string) => fileSystem.readFileString(file);
  const exists = (file: string) => fileSystem.exists(file);
  return { fileSystem, path, configDir, a, b, slugA, slugB, read, exists };
});

describe("TrellisClaudeTranscripts", () => {
  it("names project directories as Claude Code does", () => {
    assert.equal(
      claudeProjectSlug("/trellis/workspaces/ws-1/project"),
      "-trellis-workspaces-ws-1-project",
    );
    const long = `/${"x".repeat(250)}`;
    assert.match(claudeProjectSlug(long), /^-x{199}-[0-9a-z]+$/);
  });

  it.effect("moves the transcript beside the new cwd and copies memory without overwriting", () =>
    Effect.gen(function* () {
      const { fileSystem, path, configDir, b, slugA, slugB, read, exists } = yield* setup;
      yield* fileSystem.makeDirectory(path.join(slugB, "memory"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(slugB, "memory", "MEMORY.md"), "from B\n");

      yield* prepareClaudeTranscript({ configDir, sessionId, cwd: b });

      assert.isTrue(yield* exists(path.join(slugB, `${sessionId}.jsonl`)));
      assert.isTrue(yield* exists(path.join(slugB, sessionId, "subagents", "agent-1.jsonl")));
      assert.isFalse(yield* exists(path.join(slugA, `${sessionId}.jsonl`)));
      assert.isFalse(yield* exists(path.join(slugA, sessionId)));
      assert.equal(yield* read(path.join(slugB, "memory", "MEMORY.md")), "from B\n");
      assert.equal(yield* read(path.join(slugB, "memory", "notes.md")), "notes\n");
      // The old directory keeps its own memory.
      assert.equal(yield* read(path.join(slugA, "memory", "MEMORY.md")), "from A\n");
      assert.isTrue(yield* hasClaudeTranscript({ configDir, sessionId, cwd: b }));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finishes an interrupted relocation and is a no-op once done", () =>
    Effect.gen(function* () {
      const { fileSystem, path, configDir, b, slugA, slugB, read, exists } = yield* setup;
      // Interrupted after the transcript moved, before its directory did.
      yield* fileSystem.makeDirectory(slugB, { recursive: true });
      yield* fileSystem.rename(
        path.join(slugA, `${sessionId}.jsonl`),
        path.join(slugB, `${sessionId}.jsonl`),
      );

      yield* prepareClaudeTranscript({ configDir, sessionId, cwd: b });
      assert.isTrue(yield* exists(path.join(slugB, sessionId, "subagents", "agent-1.jsonl")));
      assert.equal(yield* read(path.join(slugB, "memory", "notes.md")), "notes\n");

      // Done: a further call changes nothing, even for files the memory lost.
      yield* fileSystem.remove(path.join(slugB, "memory", "notes.md"));
      yield* prepareClaudeTranscript({ configDir, sessionId, cwd: b });
      assert.isFalse(yield* exists(path.join(slugB, "memory", "notes.md")));
      assert.isTrue(yield* exists(path.join(slugB, `${sessionId}.jsonl`)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("completes a memory copy that was interrupted mid-file", () =>
    Effect.gen(function* () {
      const { fileSystem, path, configDir, b, slugB, read, exists } = yield* setup;
      // A crash during the copy left only the partial file beside the target.
      yield* fileSystem.makeDirectory(path.join(slugB, "memory"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(slugB, "memory", ".notes.md.trellis-copy"), "no");

      yield* prepareClaudeTranscript({ configDir, sessionId, cwd: b });
      assert.equal(yield* read(path.join(slugB, "memory", "notes.md")), "notes\n");
      assert.isFalse(yield* exists(path.join(slugB, "memory", ".notes.md.trellis-copy")));
      assert.isTrue(yield* exists(path.join(slugB, `${sessionId}.jsonl`)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("relocates two sessions into one directory at once", () =>
    Effect.gen(function* () {
      const { fileSystem, path, configDir, b, slugA, slugB, read, exists } = yield* setup;
      const other = "22222222-2222-4333-8444-555555555555";
      yield* fileSystem.writeFileString(path.join(slugA, `${other}.jsonl`), transcript(b));

      yield* Effect.all(
        [sessionId, other].map((id) =>
          prepareClaudeTranscript({ configDir, sessionId: id, cwd: b }),
        ),
        { concurrency: "unbounded" },
      );
      assert.isTrue(yield* exists(path.join(slugB, `${sessionId}.jsonl`)));
      assert.isTrue(yield* exists(path.join(slugB, `${other}.jsonl`)));
      assert.equal(yield* read(path.join(slugB, "memory", "MEMORY.md")), "from A\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails on a collision without moving anything", () =>
    Effect.gen(function* () {
      const { fileSystem, path, configDir, b, slugA, slugB, read } = yield* setup;
      yield* fileSystem.makeDirectory(slugB, { recursive: true });
      yield* fileSystem.writeFileString(path.join(slugB, `${sessionId}.jsonl`), "other\n");

      const error = yield* prepareClaudeTranscript({ configDir, sessionId, cwd: b }).pipe(
        Effect.flip,
      );
      assert.include(error.message, "more than one project directory");
      assert.equal(yield* read(path.join(slugB, `${sessionId}.jsonl`)), "other\n");
      assert.include(yield* read(path.join(slugA, `${sessionId}.jsonl`)), '"hello"');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lets a fork in the new directory find the relocated session", () =>
    Effect.gen(function* () {
      const { configDir, b } = yield* setup;
      // The SDK finds sessions under CLAUDE_CONFIG_DIR.
      vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
      const before = yield* Effect.promise(() =>
        forkSession(sessionId, { dir: b }).then(
          () => "forked",
          (error: Error) => error.message,
        ),
      );
      assert.include(before, "not found");
      yield* prepareClaudeTranscript({ configDir, sessionId, cwd: b });
      const forked = yield* Effect.promise(() => forkSession(sessionId, { dir: b }));
      assert.notEqual(forked.sessionId, sessionId);
    }).pipe(
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );
});
