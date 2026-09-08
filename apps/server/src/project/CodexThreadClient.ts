import { CodexSettings, CodexThreadError, type ProviderInstanceId } from "@t3tools/contracts";
import { makeThreadHistory } from "effect-codex-app-server/thread-history";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { expandHomePath } from "../pathExpansion.ts";
import {
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "../provider/Drivers/CodexHomeLayout.ts";
import { withCodexAppServerClient } from "../provider/Layers/CodexProvider.ts";
import { resolveCodexLaunchArgs } from "../provider/Layers/codexLaunchArgs.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";

type ThreadHistory = ReturnType<typeof makeThreadHistory>;
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);

export class CodexThreadClient extends Context.Service<
  CodexThreadClient,
  {
    readonly resolveNativeHomeIdentity: (
      id: ProviderInstanceId,
    ) => Effect.Effect<string, CodexThreadError>;
    readonly withClient: <A, E, R>(
      id: ProviderInstanceId,
      use: (history: ThreadHistory) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | CodexThreadError, R>;
  }
>()("t3/project/CodexThreadClient") {}

const clientError = (cause: unknown) =>
  new CodexThreadError({
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const makeCodexThreadClient = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const resolve = Effect.fn("CodexThreadClient.resolve")(function* (id: ProviderInstanceId) {
    const settings = yield* settingsService.getSettings;
    const instance = settings.providerInstances[id];
    if (!instance || instance.driver !== "codex") {
      return yield* new CodexThreadError({ message: `Codex provider '${id}' is not configured.` });
    }
    const config = yield* decodeCodexSettings(instance.config ?? {});
    const environment = mergeProviderInstanceEnvironment(instance.environment);
    // Auth overlays share history with their source home. Without an overlay,
    // an environment override is also the home actually used by the driver.
    const layout = yield* resolveCodexHomeLayout({
      ...config,
      homePath:
        config.homePath.trim() ||
        (config.shadowHomePath.trim() ? "" : (environment.CODEX_HOME ?? "")),
    }).pipe(Effect.provideService(Path.Path, path));
    return { instance, config, environment, layout };
  }, Effect.mapError(clientError));

  const resolveNativeHomeIdentity = Effect.fn("CodexThreadClient.resolveNativeHomeIdentity")(
    function* (id: ProviderInstanceId) {
      const { layout } = yield* resolve(id);
      const canonical = yield* fileSystem
        .realPath(layout.sharedHomePath)
        .pipe(
          Effect.catch((error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(layout.sharedHomePath)
              : Effect.fail(clientError(error)),
          ),
        );
      return `codex:home:${canonical}`;
    },
  );

  const withClient = <A, E, R>(
    id: ProviderInstanceId,
    use: (history: ThreadHistory) => Effect.Effect<A, E, R>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { instance, config, environment, layout } = yield* resolve(id);
        if (instance.enabled === false) {
          return yield* new CodexThreadError({ message: `Codex provider '${id}' is disabled.` });
        }
        yield* materializeCodexShadowHome(layout).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.mapError(clientError),
        );
        const { client } = yield* withCodexAppServerClient({
          binaryPath: expandHomePath(config.binaryPath),
          homePath: layout.effectiveHomePath,
          launchArgs: resolveCodexLaunchArgs(config.launchArgs, environment),
          cwd: process.cwd(),
          environment,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.timeout("30 seconds"),
          Effect.mapError(clientError),
        );
        return yield* use(makeThreadHistory(client.raw)).pipe(
          Effect.timeoutOrElse({
            duration: "60 seconds",
            orElse: () =>
              Effect.fail(
                new CodexThreadError({ message: "Codex thread history request timed out." }),
              ),
          }),
        );
      }),
    );

  return CodexThreadClient.of({ resolveNativeHomeIdentity, withClient });
});

export const CodexThreadClientLive = Layer.effect(CodexThreadClient, makeCodexThreadClient);
