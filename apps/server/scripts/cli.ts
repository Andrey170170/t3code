#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  DEVELOPMENT_ICON_OVERRIDES,
  resolveWebAssetBrandForPackageVersion,
  resolveWebIconOverrides,
} from "../../../scripts/lib/brand-assets.ts";
import { resolveCatalogDependencies } from "../../../scripts/lib/resolve-catalog.ts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import serverPackageJson from "../package.json" with { type: "json" };
import { createPnpmPackArgs, createVpPmPublishArgs } from "./cliArgs.ts";
import {
  ServerCliBuildAssetMissingError,
  ServerCliCommandExitError,
  ServerCliDevelopmentIconSourceMissingError,
  ServerCliDevelopmentIconTargetMissingError,
  ServerCliPublishIconSourceMissingError,
  ServerCliPublishIconTargetMissingError,
} from "./cliErrors.ts";

interface PackageJson {
  name: string;
  repository: {
    type: string;
    url: string;
    directory: string;
  };
  bin: Record<string, string>;
  type: string;
  version: string;
  engines: Record<string, string>;
  files: string[];
  dependencies: Record<string, string>;
  overrides: Record<string, string>;
}

const PackageJsonPrettyJson = fromJsonStringPretty(Schema.Unknown);
const encodePackageJson = Schema.encodeEffect(PackageJsonPrettyJson);

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
type WorkspaceConfig = typeof WorkspaceConfig.Type;
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

const readWorkspaceConfig = Effect.fn("readWorkspaceConfig")(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const repoRoot = yield* RepoRoot;
  const workspaceYaml = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
  return yield* decodeWorkspaceConfig(workspaceYaml);
});

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.StandardCommand) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new ServerCliCommandExitError({
      command: command.command,
      args: command.args,
      cwd: command.options.cwd,
      exitCode,
    });
  }
});

const preparePublishIcons = Effect.fn("preparePublishIcons")(function* (
  repoRoot: string,
  serverDir: string,
  version: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const brand = resolveWebAssetBrandForPackageVersion(version);
  const icons = resolveWebIconOverrides(brand, "dist/client").map((override) => ({
    sourcePath: path.join(repoRoot, override.sourceRelativePath),
    targetPath: path.join(serverDir, override.targetRelativePath),
  }));

  for (const icon of icons) {
    if (!(yield* fs.exists(icon.sourcePath))) {
      return yield* new ServerCliPublishIconSourceMissingError({ sourcePath: icon.sourcePath });
    }
    if (!(yield* fs.exists(icon.targetPath))) {
      return yield* new ServerCliPublishIconTargetMissingError({ targetPath: icon.targetPath });
    }
  }

  return yield* Effect.forEach(icons, (icon) =>
    Effect.all({
      original: fs.readFile(icon.targetPath),
      publish: fs.readFile(icon.sourcePath),
    }).pipe(Effect.map((contents) => ({ ...icon, ...contents }))),
  );
});

const applyDevelopmentIconOverrides = Effect.fn("applyDevelopmentIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of DEVELOPMENT_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new ServerCliDevelopmentIconSourceMissingError({ sourcePath });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new ServerCliDevelopmentIconTargetMissingError({ targetPath });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied development icon overrides to dist/client");
});

// ---------------------------------------------------------------------------
// build subcommand
// ---------------------------------------------------------------------------

const buildCmd = Command.make(
  "build",
  {
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Running tsdown...");
      yield* runCommand(
        ChildProcess.make(process.execPath, ["--run", "build:bundle"], {
          cwd: serverDir,
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: false,
        }),
      );

      const webDist = path.join(repoRoot, "apps/web/dist");
      const clientTarget = path.join(serverDir, "dist/client");

      if (yield* fs.exists(webDist)) {
        yield* fs.copy(webDist, clientTarget);
        yield* applyDevelopmentIconOverrides(repoRoot, serverDir);
        yield* Effect.log("[cli] Bundled web app into dist/client");
      } else {
        yield* Effect.logWarning("[cli] Web dist not found — skipping client bundle.");
      }
    }),
).pipe(Command.withDescription("Build the server package (tsdown + bundle web client)."));

// ---------------------------------------------------------------------------
// package commands
// ---------------------------------------------------------------------------

interface PreparedPackageCommandConfig {
  readonly appVersion: Option.Option<string>;
  readonly verbose: boolean;
  readonly runner: "pnpm" | "vp";
  readonly args: ReadonlyArray<string>;
}

const runPreparedPackageCommand = Effect.fn("runPreparedPackageCommand")(function* (
  config: PreparedPackageCommandConfig,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const repoRoot = yield* RepoRoot;
  const serverDir = path.join(repoRoot, "apps/server");
  const packageJsonPath = path.join(serverDir, "package.json");

  // Both local packages and published packages must contain the complete build.
  for (const relPath of ["dist/bin.mjs", "dist/service-launcher.mjs", "dist/client/index.html"]) {
    const abs = path.join(serverDir, relPath);
    if (!(yield* fs.exists(abs))) {
      return yield* new ServerCliBuildAssetMissingError({ assetPath: abs });
    }
  }

  yield* Effect.acquireUseRelease(
    // Acquire: resolve package metadata and read every original before mutation.
    Effect.gen(function* () {
      const version = Option.getOrElse(config.appVersion, () => serverPackageJson.version);
      const workspaceConfig = yield* readWorkspaceConfig();
      const workspaceCatalog = workspaceConfig.catalog ?? {};
      const workspaceOverrides = workspaceConfig.overrides ?? {};
      const pkg: PackageJson = {
        name: serverPackageJson.name,
        repository: serverPackageJson.repository,
        bin: serverPackageJson.bin,
        type: serverPackageJson.type,
        version,
        engines: serverPackageJson.engines,
        files: serverPackageJson.files,
        dependencies: resolveCatalogDependencies(
          serverPackageJson.dependencies,
          workspaceCatalog,
          "apps/server",
        ),
        overrides: resolveCatalogDependencies(workspaceOverrides, workspaceCatalog, "apps/server"),
      };

      return {
        packageJsonString: yield* encodePackageJson(pkg),
        originalPackageJson: yield* fs.readFile(packageJsonPath),
        icons: yield* preparePublishIcons(repoRoot, serverDir, version),
      };
    }),
    // Use: run from the workspace root so pnpm-only workspace config,
    // including override selectors, is interpreted correctly.
    (resource) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(packageJsonPath, `${resource.packageJsonString}\n`);
        for (const icon of resource.icons) {
          yield* fs.writeFile(icon.targetPath, icon.publish);
        }
        yield* Effect.log("[cli] Applied package metadata and publish icon overrides");

        const localVp = path.join(repoRoot, "node_modules", ".bin", "vp");
        const command = config.runner === "vp" ? localVp : "corepack";
        const args = config.runner === "vp" ? ["pm", ...config.args] : ["pnpm", ...config.args];
        const spawnCommand = yield* resolveSpawnCommand(command, args);

        yield* Effect.log(`[cli] Running: ${command} ${args.join(" ")}`);
        yield* runCommand(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: repoRoot,
            stdout: config.verbose ? "inherit" : "ignore",
            stderr: "inherit",
            shell: spawnCommand.shell,
          }),
        );
      }),
    // Release: restore every file even if applying overrides or the command fails.
    (resource) =>
      Effect.gen(function* () {
        yield* fs.writeFile(packageJsonPath, resource.originalPackageJson);
        for (const icon of resource.icons) {
          yield* fs.writeFile(icon.targetPath, icon.original);
        }
        if (config.verbose) yield* Effect.log("[cli] Restored original package assets");
      }),
  );
});

const publishCmd = Command.make(
  "publish",
  {
    tag: Flag.string("tag").pipe(Flag.withDefault("latest")),
    access: Flag.string("access").pipe(Flag.withDefault("public")),
    appVersion: Flag.string("app-version").pipe(Flag.optional),
    provenance: Flag.boolean("provenance").pipe(Flag.withDefault(false)),
    dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    runPreparedPackageCommand({
      appVersion: config.appVersion,
      verbose: config.verbose,
      runner: "vp",
      args: createVpPmPublishArgs(config),
    }),
).pipe(Command.withDescription("Publish the server package to npm."));

const packCmd = Command.make(
  "pack",
  {
    appVersion: Flag.string("app-version").pipe(Flag.optional),
    out: Flag.string("out"),
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    runPreparedPackageCommand({
      appVersion: config.appVersion,
      verbose: config.verbose,
      runner: "pnpm",
      args: createPnpmPackArgs(config.out),
    }),
).pipe(Command.withDescription("Create a local server package archive."));

// ---------------------------------------------------------------------------
// root command
// ---------------------------------------------------------------------------

const cli = Command.make("cli").pipe(
  Command.withDescription("T3 server build, pack & publish CLI."),
  Command.withSubcommands([buildCmd, packCmd, publishCmd]),
);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
  NodeRuntime.runMain,
);
