// @effect-diagnostics nodeBuiltinImport:off
/**
 * Live check that a Claude session keeps its hidden reasoning when it moves
 * between Trellis workspaces: run with `TRELLIS_SPIKE=1` against a development
 * Trellis (for example `eval "$(TRELLIS_DEV_ROOT=/trellis/dev-t3 scripts/dev.sh
 * env)"` in the Trellis repo) with two workspaces, the paths in
 * `TRELLIS_SPIKE_A` and `TRELLIS_SPIKE_B` (default: the dev-t3 spike projects)
 * and a Claude login. It costs two Haiku turns.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { forkSession, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import { claudeSessionDirectory, prepareClaudeTranscript } from "./TrellisClaudeTranscripts.ts";

const spike = process.env.TRELLIS_SPIKE === "1";
const workspaceA = process.env.TRELLIS_SPIKE_A ?? "/trellis/dev-t3/workspaces/ws-r7wx5vdv/project";
const workspaceB = process.env.TRELLIS_SPIKE_B ?? "/trellis/dev-t3/workspaces/ws-cfbiimgf/project";
const shim = process.env.TRELLIS_SPIKE_SHIM ?? "/trellis/dev-t3/shims/claude";
const configDir = process.env.CLAUDE_CONFIG_DIR ?? NodePath.join(NodeOS.homedir(), ".claude");

/** One turn the way ClaudeAdapterV2 drives it, through the Trellis shim. */
async function turn(input: {
  readonly sessionId: string;
  readonly resume: boolean;
  readonly cwd: string;
  readonly prompt: string;
}) {
  const texts: Array<string> = [];
  for await (const message of query({
    prompt: input.prompt,
    options: {
      model: "claude-haiku-4-5",
      cwd: input.cwd,
      additionalDirectories: [input.cwd],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      thinking: { type: "adaptive", display: "summarized" },
      settings: { showThinkingSummaries: true },
      extraArgs: { "thinking-display": "summarized" },
      systemPrompt: { type: "preset", preset: "claude_code" },
      pathToClaudeCodeExecutable: shim,
      ...(input.resume ? { resume: input.sessionId } : { sessionId: input.sessionId }),
    },
  }) as AsyncIterable<SDKMessage>) {
    if (message.type !== "assistant") continue;
    for (const block of message.message.content) {
      if (block.type === "text") texts.push(block.text);
    }
  }
  return texts.join("\n").trim();
}

/** The thinking text of a transcript, read as Claude Code wrote it. */
function thinkingOf(transcriptPath: string): string {
  return NodeFS.readFileSync(transcriptPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const entry = JSON.parse(line) as {
        readonly type?: string;
        readonly message?: { readonly content?: unknown };
      };
      const content = entry.type === "assistant" ? entry.message?.content : undefined;
      return Array.isArray(content)
        ? content.flatMap((block: { type?: string; thinking?: string }) =>
            block.type === "thinking" && typeof block.thinking === "string" ? [block.thinking] : [],
          )
        : [];
    })
    .join("\n");
}

describe.skipIf(!spike)("TrellisClaudeTranscripts spike", () => {
  it.effect(
    "keeps a thinking-only recall across a move between workspaces",
    () =>
      Effect.gen(function* () {
        const sessionId = NodeCrypto.randomUUID();
        const first = yield* Effect.promise(() =>
          turn({
            sessionId,
            resume: false,
            cwd: workspaceA,
            prompt:
              "Think of a random six-letter English word in your reasoning only. Never write it in a reply until asked. Reply only: ok",
          }),
        );
        const directoryA = yield* claudeSessionDirectory({ configDir, cwd: workspaceA });
        const thinking = thinkingOf(NodePath.join(directoryA, `${sessionId}.jsonl`));
        yield* Effect.log(`turn 1 (${workspaceA}): ${first}\nthinking: ${thinking.slice(0, 400)}`);

        yield* prepareClaudeTranscript({ configDir, sessionId, cwd: workspaceB });
        const directoryB = yield* claudeSessionDirectory({ configDir, cwd: workspaceB });
        expect(NodeFS.existsSync(NodePath.join(directoryB, `${sessionId}.jsonl`))).toBe(true);

        const answer = yield* Effect.promise(() =>
          turn({
            sessionId,
            resume: true,
            cwd: workspaceB,
            prompt: "Which six-letter word did you pick? Reply with the word only.",
          }),
        );
        const word = answer.replace(/[^a-zA-Z]/g, "").toLowerCase();
        yield* Effect.log(`turn 2 (${workspaceB}): ${answer}`);
        expect(word).toHaveLength(6);
        expect(thinking.toLowerCase()).toContain(word);
        expect(first.toLowerCase()).not.toContain(word);

        const forked = yield* Effect.promise(() => forkSession(sessionId, { dir: workspaceB }));
        yield* Effect.log(`forked from ${workspaceB}: ${forked.sessionId}`);
        expect(forked.sessionId).not.toBe(sessionId);
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 600_000 },
  );
});
