import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { ProviderInstanceId, ProviderDriverKind, CodexThreadError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
});
