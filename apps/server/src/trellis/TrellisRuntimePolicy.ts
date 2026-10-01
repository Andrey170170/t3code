// @effect-diagnostics nodeBuiltinImport:off
/**
 * TrellisRuntimePolicy - runs the providers of Trellis projects inside their
 * workspace.
 *
 * Decorates `RuntimePolicyV2`: for a thread whose project or cwd is a Trellis
 * project path it fills the policy's `launch` (the provider shim, the Trellis
 * primer, the workspace as session key, the loopback host the container
 * reaches T3 by) or fails resolution with the reason the provider cannot run
 * there, which fails the turn with that text. Codex and Claude have shims;
 * any other provider would silently run on the host, so it is refused, as is a
 * thread whose folder (for example a git worktree) lies outside its workspace.
 * Everything else passes through unchanged, and without the Trellis service
 * the decorator is the base policy.
 *
 * @module trellis/TrellisRuntimePolicy
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ClaudeSettings,
  CodexSettings,
  isTrellisLandingPad,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Launch,
} from "../orchestration-v2/ProviderAdapter.ts";
import {
  RuntimePolicyResolveError,
  RuntimePolicyV2,
  type RuntimePolicyV2Shape,
} from "../orchestration-v2/RuntimePolicy.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  TRELLIS_DISABLED_MESSAGE,
  Trellis,
  type TrellisEnv,
  trellisRootOf,
  trellisWorkspaceOf,
} from "./Trellis.ts";

/** How the container reaches the host's loopback (podman's host alias). */
const TRELLIS_LOOPBACK_HOST = "host.containers.internal";

/** Refusal for work in a Trellis project whose folder is outside the workspace. */
export const TRELLIS_OUTSIDE_WORKSPACE_MESSAGE =
  "This thread belongs to a Trellis project but its folder is outside the Trellis workspace (for example a git worktree), so it would run on the host. Start a thread in the project folder instead; use `trellis fork` for parallel work.";

const TRELLIS_LANDING_PAD_MESSAGE =
  "This new idea has no folder yet: send its first message from T3 Code, which creates the idea.";

export const TRELLIS_CUSTOM_HOME_MESSAGE =
  "Trellis workspaces mount only the default ~/.claude and ~/.codex, so a provider instance with a custom home or config directory cannot run inside them yet. Use an instance with the default home for this project.";

export const TRELLIS_NESTED_WORKSPACE_MESSAGE =
  "TRELLIS_WORKSPACE is set in this server's or provider's environment (is T3 itself running inside a Trellis workspace?), so the Trellis shim would run the provider on the host. Unset it for this server or provider instance.";

export const TRELLIS_MANAGED_CODEX_MESSAGE =
  "Managed ChatGPT connections are not supported inside Trellis workspaces yet. Use a Codex CLI login for this project.";

/** Driver kinds with a Trellis shim, and the shim each runs through. */
const SHIMS: Readonly<Record<string, "codex" | "claude">> = {
  codex: "codex",
  claudeAgent: "claude",
};

type TrellisLaunchDecision =
  | { readonly kind: "host" }
  | { readonly kind: "unsupported"; readonly message: string }
  | {
      readonly kind: "workspace";
      readonly executable: string;
      readonly workspaceId: string;
      readonly root: string;
    };

/**
 * Where a provider for `cwd` must run. `expectedRoots` keeps Trellis project
 * paths off the host while Trellis is off (`enabled` false) or unreachable
 * (`env` null). `projectRoot` is the thread's project folder: a thread of a
 * Trellis project whose cwd lies outside that project's workspace is refused
 * rather than run on the host.
 */
/**
 * Appended to the Trellis primer: under T3, checkpoints go through T3's MCP
 * tool, which ends the turn cleanly and continues the thread with the result.
 */
export const TRELLIS_T3_GUIDE =
  "In T3, take a checkpoint of a dedicated project (ideas have none) only with the `trellis_checkpoint` tool of the t3-code MCP server, never by running `trellis checkpoint` (or `trellis fork` without a snapshot, which checkpoints first) in a shell: the stop kills your own turn mid-command, which T3 then records as failed. The tool ends this turn cleanly, takes the checkpoint (which restarts the workspace) and continues this conversation with the result as the next message. Call it as the last action of a turn. It refuses while other threads are mid-turn in the workspace; pass `interrupt: true` to end the turns of your own delegated workers too, who continue after the restart.";

function decideTrellisLaunch(input: {
  readonly env: TrellisEnv | null;
  /** The integration setting; required so a caller cannot fail open. */
  readonly enabled: boolean;
  readonly expectedRoots: ReadonlyArray<string>;
  readonly driverKind: string;
  readonly cwd: string | undefined;
  readonly projectRoot?: string | undefined;
}): TrellisLaunchDecision {
  const { env, cwd } = input;
  const roots = env === null ? input.expectedRoots : [env.root, ...input.expectedRoots];
  const projectWorkspace =
    input.projectRoot === undefined ? null : trellisWorkspaceOf(roots, input.projectRoot);
  if (cwd === undefined) {
    return projectWorkspace === null
      ? { kind: "host" }
      : { kind: "unsupported", message: TRELLIS_OUTSIDE_WORKSPACE_MESSAGE };
  }
  const workspaceId = trellisWorkspaceOf(roots, cwd);
  if (workspaceId === null) {
    return projectWorkspace === null
      ? { kind: "host" }
      : { kind: "unsupported", message: TRELLIS_OUTSIDE_WORKSPACE_MESSAGE };
  }
  if (projectWorkspace !== null && projectWorkspace !== workspaceId) {
    return { kind: "unsupported", message: TRELLIS_OUTSIDE_WORKSPACE_MESSAGE };
  }
  if (!input.enabled) {
    return { kind: "unsupported", message: TRELLIS_DISABLED_MESSAGE };
  }
  if (env === null) {
    return {
      kind: "unsupported",
      message:
        "Trellis is not running, so this project's workspace is unavailable. Start Trellis and try again.",
    };
  }
  // The shim only enters workspaces of the running Trellis's root.
  const root = trellisRootOf(roots, cwd);
  if (root !== env.root) {
    return {
      kind: "unsupported",
      message: `This project lives under an earlier Trellis root (${root}), not under the running Trellis's root (${env.root}), so its workspace is unavailable.`,
    };
  }
  const shim = SHIMS[input.driverKind];
  if (shim === undefined) {
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
  return {
    kind: "workspace",
    executable: NodePath.join(env.shimDir, shim),
    workspaceId,
    root: env.root,
  };
}

const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

/**
 * Why a provider instance cannot run inside a workspace, or null. The
 * container mounts only the default provider homes at their host paths, so a
 * home set in the instance settings, the instance environment or the
 * environment the server inherited is refused; so is an inherited
 * `TRELLIS_WORKSPACE`, which makes the shim fall back to the host.
 */
function instanceLaunchRefusal(
  driverKind: string,
  instance: ProviderInstanceConfig | undefined,
  homeDir: string,
  hostEnvironment: NodeJS.ProcessEnv,
): string | null {
  const isCustomHome = (value: string | undefined, defaultDir: string) =>
    value !== undefined &&
    value.trim().length > 0 &&
    NodePath.resolve(expandHomePath(value.trim())) !== NodePath.join(homeDir, defaultDir);
  // The environment the provider starts with: the instance's merged over the inherited one.
  const environment = mergeProviderInstanceEnvironment(instance?.environment, hostEnvironment);
  const environmentValue = (name: string) => environment[name];
  // The shim runs the host binary whenever this is set, even empty.
  if (environmentValue("TRELLIS_WORKSPACE") !== undefined) {
    return TRELLIS_NESTED_WORKSPACE_MESSAGE;
  }
  if (driverKind === "codex") {
    const config = decodeCodexSettings(instance?.config ?? {});
    if (Option.isSome(config) && config.value.setupMode === "managed") {
      return TRELLIS_MANAGED_CODEX_MESSAGE;
    }
    const custom =
      (Option.isSome(config) &&
        (isCustomHome(config.value.homePath, ".codex") ||
          config.value.shadowHomePath.trim().length > 0)) ||
      isCustomHome(environmentValue("CODEX_HOME"), ".codex");
    return custom ? TRELLIS_CUSTOM_HOME_MESSAGE : null;
  }
  if (driverKind === "claudeAgent") {
    const config = decodeClaudeSettings(instance?.config ?? {});
    const custom =
      (Option.isSome(config) && isCustomHome(config.value.homePath, ".claude")) ||
      isCustomHome(environmentValue("CLAUDE_CONFIG_DIR"), ".claude");
    return custom ? TRELLIS_CUSTOM_HOME_MESSAGE : null;
  }
  return null;
}

/** `RuntimePolicyV2` with Trellis launches; provide the base policy beneath it. */
export const layer: Layer.Layer<
  RuntimePolicyV2,
  never,
  RuntimePolicyV2 | ProjectStoreV2 | ProviderInstanceRegistry
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicyV2;
    const trellisOption = yield* Effect.serviceOption(Trellis);
    const settingsOption = yield* Effect.serviceOption(ServerSettingsService);
    if (Option.isNone(trellisOption)) return base;
    if (Option.isNone(settingsOption)) {
      return yield* Effect.die(new Error("TrellisRuntimePolicy needs ServerSettingsService."));
    }
    const trellis = trellisOption.value;
    const serverSettings = settingsOption.value;
    const projects = yield* ProjectStoreV2;
    const instances = yield* ProviderInstanceRegistry;

    const resolve: RuntimePolicyV2Shape["resolve"] = Effect.fn("TrellisRuntimePolicy.resolve")(
      function* (input) {
        const policy = yield* base.resolve(input);
        const refuse = (message: string) =>
          new RuntimePolicyResolveError({
            projectId: input.thread.projectId,
            providerInstanceId: input.modelSelection.instanceId,
            cause: message,
          });
        // A new idea's draft runs nowhere: its first send moves it into the idea.
        if (isTrellisLandingPad(input.thread.projectId)) {
          return yield* refuse(TRELLIS_LANDING_PAD_MESSAGE);
        }
        const canonical = (path: string | null | undefined) =>
          path == null ? Effect.succeed(undefined) : trellis.canonicalPath(path);
        // Classified by realpath: a symlink to a workspace path is that path.
        const projectRoot = yield* projects.get(input.thread.projectId).pipe(
          Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot),
          Effect.orElseSucceed(() => undefined),
          Effect.flatMap(canonical),
        );
        const cwd = yield* canonical(policy.cwd);
        // Ask an enabled Trellis that is not known to be up first (once per
        // interval): its live root may be the only one marking this path.
        const enabled = yield* trellis.enabled;
        const env = yield* trellis.discover;
        const roots = yield* trellis.expectedRoots;
        const involved = [cwd, projectRoot].some(
          (path) =>
            path !== undefined &&
            trellisRootOf(env === null ? roots : [env.root, ...roots], path) !== null,
        );
        if (!involved) return policy;

        const instance = yield* instances.getInstance(input.modelSelection.instanceId);
        const driverKind = instance?.driverKind ?? String(input.modelSelection.instanceId);
        const decision = decideTrellisLaunch({
          env,
          enabled,
          expectedRoots: roots,
          driverKind,
          cwd,
          projectRoot,
        });
        if (decision.kind === "host") return policy;
        if (decision.kind === "unsupported") return yield* refuse(decision.message);

        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError((error) => refuse(error.message)),
        );
        const homeRefusal = instanceLaunchRefusal(
          driverKind,
          deriveProviderInstanceConfigMap(settings)[input.modelSelection.instanceId],
          NodeOS.homedir(),
          process.env,
        );
        if (homeRefusal !== null) return yield* refuse(homeRefusal);

        const primer = yield* trellis.primer(cwd ?? "").pipe(
          Effect.map((text) => text.trim()),
          Effect.catch((error) =>
            Effect.logWarning("Trellis primer unavailable; starting without it", {
              threadId: input.thread.id,
              detail: error.message,
            }).pipe(Effect.as("")),
          ),
        );
        // The shim and Trellis CLI resolve the same root and service as T3.
        const { socketPath } = yield* trellis.connection;
        const instructions = [primer, TRELLIS_T3_GUIDE].filter((text) => text.length > 0);
        const launch: ProviderAdapterV2Launch = {
          executable: decision.executable,
          env: {
            TRELLIS_ROOT: decision.root,
            TRELLIS_SOCKET: socketPath,
            // `trellis checkpoint` run by the agent excludes its own turn. A
            // Codex app-server serves every thread of the workspace, so a
            // thread id in its environment would name the wrong thread.
            ...(driverKind === "claudeAgent" ? { TRELLIS_THREAD: input.thread.id } : {}),
          },
          instructions: instructions.join("\n\n"),
          sessionKey: decision.workspaceId,
          loopbackHost: TRELLIS_LOOPBACK_HOST,
        };
        // The provider starts in the canonical path, which exists in the container.
        return ProviderAdapterV2RuntimePolicy.make({ ...policy, cwd: cwd ?? policy.cwd, launch });
      },
    );
    return RuntimePolicyV2.of({ resolve });
  }),
);
