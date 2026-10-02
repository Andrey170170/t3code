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
  type TrellisAgentHomes,
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

/**
 * Refusal for a provider instance whose home Trellis does not mount: the
 * provider would run in the workspace without its login and history.
 */
export const trellisHomeRefusal = (
  provider: "Claude" | "Codex",
  home: string,
  mounted: string | null,
): string =>
  mounted === null
    ? `Trellis mounts no ${provider} home into its workspaces, so ${provider} cannot run inside them. Configure the ${provider} home in Trellis's config.json.`
    : `This ${provider} instance uses the home ${home}, but Trellis mounts ${mounted} into its workspaces. Use an instance whose home is ${mounted} for this project, or change the home Trellis mounts.`;

export const TRELLIS_SHADOW_HOME_MESSAGE =
  "A Codex instance with a shadow home cannot run inside Trellis workspaces, which mount only the Codex home itself. Use an instance without a shadow home for this project.";

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
 * tool, which ends the turn cleanly and continues the thread with the result,
 * and workers get forks through `delegate_task`.
 */
export const TRELLIS_T3_GUIDE =
  'In T3, take a checkpoint of a dedicated project (ideas have none) only with the `trellis_checkpoint` tool of the t3-code MCP server, never by running `trellis checkpoint` (or `trellis fork` without a snapshot, which checkpoints first) in a shell: the stop kills your own turn mid-command, which T3 then records as failed. The tool ends this turn cleanly, takes the checkpoint (which restarts the workspace) and continues this conversation with the result as the next message. Call it as the last action of a turn. It refuses while other threads are mid-turn in the workspace; pass `interrupt: true` to end the turns of your own delegated workers too, who continue after the restart. Likewise, graduate an idea into its own project only with the `trellis_graduate` tool (a tool call, never `trellis graduate` in a shell): it ends this turn, moves this thread into the new project and continues it there. To give a delegated worker its own fork of this workspace, call `delegate_task` with `workspace: {fork: {from: "latest"}}` (or a checkpoint id from `trellis snapshots`; `services: "all"` starts declared services in it): a spawn never stops the workspace, so to fork from the current state call `trellis_checkpoint` first, then spawn as many workers as you need from it. The worker\'s final message becomes its fork\'s summary. To merge its work, run `trellis merge-brief FORK` (fetch its bookmark from the incoming copy, carry environment changes over by hand), then `trellis merged FORK SNAP`. Discard forks you are done with using the `trellis_discard_fork` tool, which can also ask the user to purge one; never purge yourself.';

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
 * container mounts the provider homes Trellis reports (`agentHomes`; the
 * defaults when it reports none) at their host paths, so the home the
 * provider is given (its settings, then its environment merged over the
 * server's, then the default, resolved as the adapters do) must be exactly
 * a mounted path: a symlink to it, a literal `~` or a relative path does not
 * exist in the container. An inherited `TRELLIS_WORKSPACE` is refused too, as
 * it makes the shim fall back to the host.
 */
function instanceLaunchRefusal(
  driverKind: string,
  instance: ProviderInstanceConfig | undefined,
  homeDir: string,
  hostEnvironment: NodeJS.ProcessEnv,
  agentHomes: TrellisAgentHomes | undefined,
): string | null {
  // The environment the provider starts with: the instance's merged over the
  // inherited one (instance values are home-expanded, inherited ones are not).
  const environment = mergeProviderInstanceEnvironment(instance?.environment, hostEnvironment);
  // The shim runs the host binary whenever this is set, even empty.
  if (environment.TRELLIS_WORKSPACE !== undefined) {
    return TRELLIS_NESTED_WORKSPACE_MESSAGE;
  }
  const homeOf = (configured: string | undefined, variable: string, defaultDir: string) => {
    if (configured !== undefined && configured.trim().length > 0) {
      return NodePath.resolve(expandHomePath(configured.trim()));
    }
    const value = environment[variable]?.trim() ?? "";
    if (value.length === 0) return NodePath.join(homeDir, defaultDir);
    return NodePath.isAbsolute(value) ? NodePath.resolve(value) : value;
  };
  const check = (provider: "Claude" | "Codex", home: string, mounted: string | null) =>
    mounted !== null && NodePath.resolve(mounted) === home
      ? null
      : trellisHomeRefusal(provider, home, mounted);
  if (driverKind === "codex") {
    const config = decodeCodexSettings(instance?.config ?? {});
    if (Option.isSome(config) && config.value.setupMode === "managed") {
      return TRELLIS_MANAGED_CODEX_MESSAGE;
    }
    if (Option.isSome(config) && config.value.shadowHomePath.trim().length > 0) {
      return TRELLIS_SHADOW_HOME_MESSAGE;
    }
    return check(
      "Codex",
      homeOf(Option.getOrUndefined(config)?.homePath, "CODEX_HOME", ".codex"),
      agentHomes === undefined ? NodePath.join(homeDir, ".codex") : agentHomes.codex,
    );
  }
  if (driverKind === "claudeAgent") {
    const config = decodeClaudeSettings(instance?.config ?? {});
    return check(
      "Claude",
      homeOf(Option.getOrUndefined(config)?.homePath, "CLAUDE_CONFIG_DIR", ".claude"),
      agentHomes === undefined ? NodePath.join(homeDir, ".claude") : agentHomes.claude,
    );
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
          env?.agentHomes,
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
