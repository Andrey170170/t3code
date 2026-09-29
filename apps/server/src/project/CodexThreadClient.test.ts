import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { ProviderInstanceId, ProviderDriverKind, CodexThreadError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import { CodexInstallation } from "../provider/CodexInstallation.ts";
import { layerTest } from "../serverSettings.ts";
import { makeCodexThreadClient } from "./CodexThreadClient.ts";
import { withCodexAppServerClient } from "../provider/Layers/CodexProvider.ts";

vi.mock("../provider/Layers/CodexProvider.ts", () => ({ withCodexAppServerClient: vi.fn() }));

const settings = layerTest({
  providerInstances: {
    [ProviderInstanceId.make("codex")]: {
      driver: ProviderDriverKind.make("codex"),
      config: { homePath: "/tmp/t3-thread-client-home" },
    },
    [ProviderInstanceId.make("alias")]: {
      driver: ProviderDriverKind.make("codex"),
      enabled: false,
      config: {
        homePath: "/tmp/t3-thread-client-home",
        shadowHomePath: "/tmp/t3-thread-client-overlay",
      },
    },
    [ProviderInstanceId.make("isolated")]: {
      driver: ProviderDriverKind.make("codex"),
      config: { homePath: "/tmp/t3-thread-client-isolated" },
    },
    [ProviderInstanceId.make("custom")]: {
      driver: ProviderDriverKind.make("codex"),
      environment: [
        { name: "CODEX_HOME", value: "/tmp/t3-thread-client-env" },
        { name: "T3CODE_CODEX_LAUNCH_ARGS", value: "--enable example" },
      ],
      config: { binaryPath: "/tmp/custom-codex" },
    },
  },
});
const services = Layer.merge(NodeServices.layer, settings);

describe("CodexThreadClient", () => {
  it.effect("resolves the built-in Codex provider when settings omit providerInstances", () =>
    Effect.gen(function* () {
      const client = yield* makeCodexThreadClient;
      const home = yield* client.resolveNativeHomeIdentity(ProviderInstanceId.make("codex"));
      expect(home).toBe("codex:home:/tmp/t3-thread-client-legacy-default");
    }).pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          layerTest({ providers: { codex: { homePath: "/tmp/t3-thread-client-legacy-default" } } }),
        ),
      ),
    ),
  );

  it.effect("deduplicates shared-home overlays but keeps isolated homes separate", () =>
    Effect.gen(function* () {
      const client = yield* makeCodexThreadClient;
      const direct = yield* client.resolveNativeHomeIdentity(ProviderInstanceId.make("codex"));
      expect(yield* client.resolveNativeHomeIdentity(ProviderInstanceId.make("alias"))).toBe(
        direct,
      );
      expect(yield* client.resolveNativeHomeIdentity(ProviderInstanceId.make("isolated"))).not.toBe(
        direct,
      );
      expect(yield* client.resolveNativeHomeIdentity(ProviderInstanceId.make("custom"))).toBe(
        "codex:home:/tmp/t3-thread-client-env",
      );
    }).pipe(Effect.provide(services)),
  );

  it.effect(
    "uses provider launch settings and releases the process after a failed history request",
    () =>
      Effect.gen(function* () {
        let released = false;
        const requested: string[] = [];
        vi.mocked(withCodexAppServerClient).mockImplementation(() =>
          Effect.acquireRelease(
            Effect.succeed({
              client: {
                raw: {
                  request: (method: string) => {
                    requested.push(method);
                    return Effect.fail(new CodexThreadError({ message: "history failed" }));
                  },
                },
              },
              initialize: {},
            } as unknown as Effect.Success<ReturnType<typeof withCodexAppServerClient>>),
            () =>
              Effect.sync(() => {
                released = true;
              }),
          ),
        );
        const client = yield* makeCodexThreadClient;
        const result = yield* client
          .withClient(ProviderInstanceId.make("custom"), (history) => history.list({}))
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(released).toBe(true);
        expect(requested).toEqual(["thread/list"]);
        expect(withCodexAppServerClient).toHaveBeenLastCalledWith(
          expect.objectContaining({
            binaryPath: "/tmp/custom-codex",
            homePath: "/tmp/t3-thread-client-env",
            launchArgs: "--enable example",
            environment: expect.objectContaining({ CODEX_HOME: "/tmp/t3-thread-client-env" }),
          }),
        );
      }).pipe(Effect.provide(services)),
  );

  it.effect("rejects missing and disabled providers before starting a process", () =>
    Effect.gen(function* () {
      vi.mocked(withCodexAppServerClient).mockClear();
      const client = yield* makeCodexThreadClient;
      for (const id of ["missing", "alias"]) {
        const result = yield* client
          .withClient(ProviderInstanceId.make(id), () => Effect.void)
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
      expect(withCodexAppServerClient).not.toHaveBeenCalled();
    }).pipe(Effect.provide(services)),
  );

  it.effect("keeps managed history identity on the native home despite CODEX_HOME overrides", () =>
    Effect.gen(function* () {
      vi.mocked(withCodexAppServerClient).mockClear();
      const client = yield* makeCodexThreadClient;
      const nativeHome = yield* client.resolveNativeHomeIdentity(ProviderInstanceId.make("cli"));
      for (const id of ["codex", "codex-work"]) {
        expect(yield* client.resolveNativeHomeIdentity(ProviderInstanceId.make(id))).toBe(
          nativeHome,
        );
      }
      expect(withCodexAppServerClient).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        Layer.merge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-managed-history-identity-" }),
          layerTest({
            providerInstances: {
              [ProviderInstanceId.make("cli")]: {
                driver: ProviderDriverKind.make("codex"),
                config: {},
              },
              ...Object.fromEntries(
                ["codex", "codex-work"].map((id) => [
                  ProviderInstanceId.make(id),
                  {
                    driver: ProviderDriverKind.make("codex"),
                    environment: [{ name: "CODEX_HOME", value: "/tmp/ambient-codex-home" }],
                    config: { setupMode: "managed" },
                  },
                ]),
              ),
            },
          }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.scoped,
    ),
  );

  for (const id of ["codex", "codex-work"])
    it.effect(`uses the acquired executable and managed home for ${id} history without auth`, () =>
      Effect.gen(function* () {
        vi.mocked(withCodexAppServerClient).mockClear();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const serverConfig = yield* ServerConfig;
        const ambientHome = process.env.CODEX_HOME;
        const sharedHome = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-managed-history-home-",
        });
        let leases = 0;
        const acquire = vi.fn(() =>
          Effect.acquireRelease(
            Effect.sync(() => {
              leases++;
              return {
                executablePath: "/managed/codex/bin/codex",
                source: "managed" as const,
                version: "0.159.0",
                managedVersionDirectory: "/managed/codex",
              };
            }),
            () =>
              Effect.sync(() => {
                leases--;
              }),
          ),
        );
        vi.mocked(withCodexAppServerClient).mockImplementation(() =>
          Effect.succeed({
            client: {
              raw: {
                request: (method: string) => {
                  expect(method).toBe("thread/list");
                  expect(leases).toBe(1);
                  return Effect.succeed({ data: [], nextCursor: null });
                },
              },
            },
            initialize: {},
          } as unknown as Effect.Success<ReturnType<typeof withCodexAppServerClient>>),
        );
        const client = yield* makeCodexThreadClient.pipe(
          Effect.provide(
            Layer.merge(
              layerTest({
                providerInstances: {
                  [ProviderInstanceId.make(id)]: {
                    driver: ProviderDriverKind.make("codex"),
                    environment: [{ name: "CODEX_HOME", value: "/tmp/ambient-codex-home" }],
                    config: {
                      setupMode: "managed",
                      homePath: sharedHome,
                      binaryPath: "/legacy/codex",
                    },
                  },
                  [ProviderInstanceId.make("disabled-managed")]: {
                    driver: ProviderDriverKind.make("codex"),
                    enabled: false,
                    config: { setupMode: "managed", homePath: sharedHome },
                  },
                },
              }),
              Layer.mock(CodexInstallation)({ managedDirectory: "/managed/codex", acquire }),
            ),
          ),
        );
        expect(yield* client.resolveNativeHomeIdentity(ProviderInstanceId.make(id))).toBe(
          `codex:home:${sharedHome}`,
        );
        expect(acquire).not.toHaveBeenCalled();
        const disabled = yield* client
          .withClient(ProviderInstanceId.make("disabled-managed"), () => Effect.void)
          .pipe(Effect.result);
        expect(disabled._tag).toBe("Failure");
        expect(process.env.CODEX_HOME).toBe(ambientHome);
        expect(acquire).not.toHaveBeenCalled();
        expect(withCodexAppServerClient).not.toHaveBeenCalled();
        const history = yield* client.withClient(ProviderInstanceId.make(id), (history) =>
          history.list({}),
        );
        expect(history.data).toEqual([]);
        const homePath =
          id === "codex"
            ? sharedHome
            : path.join(serverConfig.stateDir, "providers", "codex", id, "shadow");
        expect(withCodexAppServerClient).toHaveBeenLastCalledWith(
          expect.objectContaining({
            binaryPath: "/managed/codex/bin/codex",
            homePath,
            environment: expect.objectContaining({ CODEX_HOME: homePath }),
          }),
        );
        expect(leases).toBe(0);
        expect(acquire).toHaveBeenCalledOnce();
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-managed-history-runtime-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
        Effect.scoped,
      ),
    );
});
