import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, vi } from "vite-plus/test";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeTestTrellis, TRELLIS_DISABLED_MESSAGE, Trellis, type TrellisEnv } from "./Trellis.ts";
import * as TrellisRuntimePolicy from "./TrellisRuntimePolicy.ts";

const env: TrellisEnv = { root: "/trellis", bin: "/opt/trellis", shimDir: "/t3/trellis-shims" };
const workspaceProject = "/trellis/workspaces/ws-1/project";
const idea = `${workspaceProject}/idea-1`;

const instances: Record<string, ProviderDriverKind> = {
  codex: ProviderDriverKind.make("codex"),
  claudeAgent: ProviderDriverKind.make("claudeAgent"),
  cursor: ProviderDriverKind.make("cursor"),
};

const thread = (input: {
  readonly projectId: string;
  readonly worktreePath?: string;
}): OrchestrationV2AppThread =>
  ({
    id: ThreadId.make("thread-trellis-policy"),
    projectId: ProjectId.make(input.projectId),
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: input.worktreePath ?? null,
  }) as OrchestrationV2AppThread;

const resolve = (input: {
  readonly instance: string;
  readonly projectRoot: string;
  readonly worktreePath?: string;
  readonly trellisEnv?: TrellisEnv | null;
  /** Roots known without asking Trellis; Trellis reports `trellisEnv` when asked. */
  readonly knownRoots?: ReadonlyArray<string>;
  readonly notAskedYet?: boolean;
  /** Symlinks: alias → target. */
  readonly aliases?: Readonly<Record<string, string>>;
  readonly providerInstances?: Parameters<typeof ServerSettingsService.layerTest>[0];
}) => {
  const projectId = "project-trellis-policy";
  const modelSelection = {
    instanceId: ProviderInstanceId.make(input.instance),
    model: "test-model",
  } satisfies ModelSelection;
  const primerTargets: Array<string> = [];
  const layer = TrellisRuntimePolicy.layer.pipe(
    // The base policy: the worktree or the project folder, as V2 resolves it.
    Layer.provide(
      Layer.succeed(RuntimePolicyV2, {
        resolve: (policyInput) =>
          Effect.succeed({
            runtimeMode: policyInput.thread.runtimeMode,
            interactionMode: policyInput.thread.interactionMode,
            cwd: policyInput.thread.worktreePath ?? input.projectRoot,
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () =>
          Effect.succeed(
            Option.some({ workspaceRoot: input.projectRoot } as ProjectStore.ProjectRow),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderInstanceRegistry)({
        getInstance: (instanceId) =>
          Effect.succeed({ driverKind: instances[instanceId] } as ProviderInstance),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        Trellis,
        makeTestTrellis({
          env: input.trellisEnv === undefined ? env : input.trellisEnv,
          expectedRoots: Effect.succeed(input.knownRoots ?? ["/trellis"]),
          ...(input.notAskedYet === true ? { current: Effect.succeed(null) } : {}),
          canonicalPath: (path) => Effect.succeed(input.aliases?.[path] ?? path),
          primer: (target) =>
            Effect.sync(() => {
              primerTargets.push(target);
              return "You are in a Trellis workspace.\n";
            }),
        }),
      ),
    ),
    Layer.provide(ServerSettingsService.layerTest(input.providerInstances ?? {})),
    Layer.provide(NodeServices.layer),
  );
  return RuntimePolicyV2.use((policy) =>
    policy.resolve({
      thread: thread({
        projectId,
        ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
      }),
      modelSelection,
    }),
  ).pipe(
    Effect.provide(layer),
    Effect.map((policy) => ({ policy, primerTargets })),
  );
};

const refusal = (effect: ReturnType<typeof resolve>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => String(error.cause)),
  );

describe("TrellisRuntimePolicy", () => {
  it.effect("launches Codex and Claude of a Trellis project through their shims", () =>
    Effect.gen(function* () {
      for (const [instance, shim] of [
        ["codex", "codex"],
        ["claudeAgent", "claude"],
      ] as const) {
        const { policy, primerTargets } = yield* resolve({ instance, projectRoot: idea });
        assert.equal(policy.cwd, idea);
        assert.deepEqual(policy.launch, {
          executable: `/t3/trellis-shims/${shim}`,
          env: { TRELLIS_ROOT: "/trellis", TRELLIS_SOCKET: "/trellis/state/api.sock" },
          instructions: "You are in a Trellis workspace.",
          sessionKey: "ws-1",
          loopbackHost: "host.containers.internal",
        });
        assert.deepEqual(primerTargets, [idea]);
      }
    }),
  );

  it.effect("asks an enabled Trellis for its root before treating a path as a host path", () =>
    Effect.gen(function* () {
      const { policy } = yield* resolve({
        instance: "codex",
        projectRoot: idea,
        knownRoots: [],
        notAskedYet: true,
      });
      assert.equal(policy.launch?.sessionKey, "ws-1");
    }),
  );

  it.effect("classifies a symlink to a workspace by its target and starts there", () =>
    Effect.gen(function* () {
      const { policy } = yield* resolve({
        instance: "codex",
        projectRoot: "/home/me/idea",
        aliases: { "/home/me/idea": idea },
      });
      assert.equal(policy.cwd, idea);
      assert.equal(policy.launch?.sessionKey, "ws-1");
    }),
  );

  it.effect("refuses a launch the shim would run on the host because of TRELLIS_WORKSPACE", () =>
    Effect.gen(function* () {
      vi.stubEnv("TRELLIS_WORKSPACE", "");
      const message = yield* refusal(resolve({ instance: "codex", projectRoot: idea })).pipe(
        Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
      );
      assert.equal(message, TrellisRuntimePolicy.TRELLIS_NESTED_WORKSPACE_MESSAGE);
    }),
  );

  it.effect("refuses workspaces under an earlier Trellis root", () =>
    Effect.gen(function* () {
      const message = yield* refusal(
        resolve({
          instance: "codex",
          projectRoot: "/old-trellis/workspaces/ws-9/project",
          knownRoots: ["/old-trellis", "/trellis"],
        }),
      );
      assert.include(message, "earlier Trellis root (/old-trellis)");
    }),
  );

  it.effect("passes host projects through without asking for a primer", () =>
    Effect.gen(function* () {
      const { policy, primerTargets } = yield* resolve({
        instance: "cursor",
        projectRoot: "/home/me/code",
      });
      assert.deepEqual(policy, {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/home/me/code",
      });
      assert.deepEqual(primerTargets, []);
    }),
  );

  it.effect("refuses Trellis projects while the integration is off", () =>
    Effect.gen(function* () {
      const message = yield* refusal(
        resolve({ instance: "codex", projectRoot: idea, trellisEnv: null }),
      );
      assert.equal(message, TRELLIS_DISABLED_MESSAGE);
    }),
  );

  it.effect("refuses providers without a Trellis shim", () =>
    Effect.gen(function* () {
      const message = yield* refusal(resolve({ instance: "cursor", projectRoot: idea }));
      assert.include(message, "The cursor provider is not supported inside Trellis workspaces");
    }),
  );

  it.effect("refuses provider instances with a custom home", () =>
    Effect.gen(function* () {
      const claudeHome = yield* refusal(
        resolve({
          instance: "claudeAgent",
          projectRoot: idea,
          providerInstances: {
            providerInstances: {
              [ProviderInstanceId.make("claudeAgent")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                config: { homePath: "/srv/claude-work" },
              },
            },
          },
        }),
      );
      assert.equal(claudeHome, TrellisRuntimePolicy.TRELLIS_CUSTOM_HOME_MESSAGE);
      const managedCodex = yield* refusal(
        resolve({
          instance: "codex",
          projectRoot: idea,
          providerInstances: {
            providerInstances: {
              [ProviderInstanceId.make("codex")]: {
                driver: ProviderDriverKind.make("codex"),
                config: { setupMode: "managed" },
              },
            },
          },
        }),
      );
      assert.equal(managedCodex, TrellisRuntimePolicy.TRELLIS_MANAGED_CODEX_MESSAGE);
      const instanceEnvHome = yield* refusal(
        resolve({
          instance: "codex",
          projectRoot: idea,
          providerInstances: {
            providerInstances: {
              [ProviderInstanceId.make("codex")]: {
                driver: ProviderDriverKind.make("codex"),
                environment: [{ name: "CODEX_HOME", value: "/srv/codex-work", sensitive: false }],
              },
            },
          },
        }),
      );
      assert.equal(instanceEnvHome, TrellisRuntimePolicy.TRELLIS_CUSTOM_HOME_MESSAGE);
      vi.stubEnv("CLAUDE_CONFIG_DIR", "/srv/claude-inherited");
      const inheritedHome = yield* refusal(
        resolve({ instance: "claudeAgent", projectRoot: idea }),
      ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
      assert.equal(inheritedHome, TrellisRuntimePolicy.TRELLIS_CUSTOM_HOME_MESSAGE);
    }),
  );

  it.effect("refuses a Trellis thread whose worktree is outside its workspace", () =>
    Effect.gen(function* () {
      for (const worktreePath of [
        "/home/me/.t3/worktrees/repo/branch",
        "/trellis/workspaces/ws-2/project",
      ]) {
        const message = yield* refusal(
          resolve({ instance: "codex", projectRoot: workspaceProject, worktreePath }),
        );
        assert.equal(message, TrellisRuntimePolicy.TRELLIS_OUTSIDE_WORKSPACE_MESSAGE);
      }
      // Also while Trellis is off: the thread must never fall back to the host.
      const offMessage = yield* refusal(
        resolve({
          instance: "codex",
          projectRoot: workspaceProject,
          worktreePath: "/home/me/.t3/worktrees/repo/branch",
          trellisEnv: null,
        }),
      );
      assert.equal(offMessage, TrellisRuntimePolicy.TRELLIS_OUTSIDE_WORKSPACE_MESSAGE);
    }),
  );
});
