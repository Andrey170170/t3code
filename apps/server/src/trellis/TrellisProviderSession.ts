// @effect-diagnostics nodeBuiltinImport:off
/**
 * TrellisProviderSession - per-thread launch settings for providers whose cwd
 * is a Trellis project path.
 *
 * ProviderService decides the launch before starting a session and records it
 * here; adapters read it when they spawn, the same way they read
 * `McpProviderSession`. Codex and Claude run through Trellis shims, which exec
 * the provider inside the workspace container. Other providers would silently
 * run on the host, so they are refused.
 *
 * @module trellis/TrellisProviderSession
 */
import * as NodePath from "node:path";

import type { ThreadId } from "@t3tools/contracts";

import { isTrellisManagedPath, TRELLIS_DISABLED_MESSAGE, type TrellisEnv } from "./Trellis.ts";

export interface TrellisProviderSessionConfig {
  /** Directory holding the `codex` and `claude` shims. */
  readonly shimDir: string;
  /** Trellis orientation appended to the provider's system/developer context. */
  readonly primer: string | null;
}

export type TrellisLaunchDecision =
  | { readonly kind: "host" }
  | { readonly kind: "unsupported"; readonly message: string }
  | { readonly kind: "workspace"; readonly shimDir: string };

// Driver kinds that have a Trellis shim.
const SUPPORTED_DRIVERS: ReadonlySet<string> = new Set(["codex", "claudeAgent"]);

/** Refusal for work in a Trellis project whose folder is outside the workspace. */
export const TRELLIS_OUTSIDE_WORKSPACE_MESSAGE =
  "This thread belongs to a Trellis project but its folder is outside the Trellis workspace (for example a git worktree), so it would run on the host. Start a thread in the project folder instead; use `trellis fork` for parallel work.";

/**
 * Where a provider session for `cwd` must run. `expectedRoot` keeps Trellis
 * project paths off the host while Trellis is off (`enabled` false) or
 * unreachable (`env` null).
 * `projectRoot` is the thread's project folder: a thread of a Trellis project
 * whose cwd lies elsewhere is refused rather than run on the host.
 */
export function decideTrellisLaunch(input: {
  readonly env: TrellisEnv | null;
  /** The integration setting; defaults to on. */
  readonly enabled?: boolean;
  readonly expectedRoot: string | null;
  readonly driverKind: string;
  readonly cwd: string | undefined;
  readonly projectRoot?: string | undefined;
}): TrellisLaunchDecision {
  const { env, cwd } = input;
  const root = env?.root ?? input.expectedRoot;
  if (root === null || cwd === undefined) {
    return { kind: "host" };
  }
  if (!isTrellisManagedPath(root, cwd)) {
    return input.projectRoot !== undefined && isTrellisManagedPath(root, input.projectRoot)
      ? { kind: "unsupported", message: TRELLIS_OUTSIDE_WORKSPACE_MESSAGE }
      : { kind: "host" };
  }
  if (input.enabled === false) {
    return { kind: "unsupported", message: TRELLIS_DISABLED_MESSAGE };
  }
  if (env === null) {
    return {
      kind: "unsupported",
      message:
        "Trellis is not running, so this project's workspace is unavailable. Start Trellis and try again.",
    };
  }
  if (!SUPPORTED_DRIVERS.has(input.driverKind)) {
    return {
      kind: "unsupported",
      message: `The ${input.driverKind} provider is not supported inside Trellis workspaces yet. Use Codex or Claude for this project.`,
    };
  }
  if (env.shimDir === null) {
    return {
      kind: "unsupported",
      message:
        "Trellis provider shims are unavailable, so the provider cannot run inside the workspace. Check that `trellis shims` works and see the server log.",
    };
  }
  return { kind: "workspace", shimDir: env.shimDir };
}

export function trellisShimPath(
  config: TrellisProviderSessionConfig,
  provider: "codex" | "claude",
) {
  return NodePath.join(config.shimDir, provider);
}

const LOOPBACK_URL = /^([a-z][a-z0-9+.-]*:\/\/)(?:127\.0\.0\.1|localhost|\[::1\])(?=[:/?#]|$)/i;

/**
 * Workspaces run in a private network namespace where loopback is the
 * container itself; the host's loopback is reachable as
 * `host.containers.internal`. Other URLs are returned unchanged.
 */
export function rewriteLoopbackUrl(url: string): string {
  return url.replace(LOOPBACK_URL, "$1host.containers.internal");
}

const sessionsByThread = new Map<ThreadId, TrellisProviderSessionConfig>();

export function setTrellisProviderSession(
  threadId: ThreadId,
  config: TrellisProviderSessionConfig,
): void {
  sessionsByThread.set(threadId, config);
}

export function readTrellisProviderSession(
  threadId: ThreadId,
): TrellisProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearTrellisProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}
