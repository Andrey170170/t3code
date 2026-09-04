import * as NodeOS from "node:os";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { assert, it, vi } from "vite-plus/test";

import { fixPath, hydratePosixHome } from "./os-jank.ts";

vi.mock("@t3tools/shared/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/shared/shell")>()),
  readPathFromLoginShell: () => "/official/bin:/usr/bin",
}));

effectIt.effect("keeps the capsule's custom Codex ahead of login-shell installations", () =>
  Effect.gen(function* () {
    const env = {
      HOME: "/home/test",
      PATH: "/custom/codex/bin:/usr/bin",
      CHPC_CODEX_BIN: "/custom/codex/bin/codex",
    };
    yield* fixPath().pipe(
      Effect.provideService(HostProcessEnvironment, env),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(NodeServices.layer),
    );
    assert.equal(env.PATH, "/custom/codex/bin:/usr/bin:/official/bin");
  }),
);

effectIt.effect("keeps login-shell precedence outside managed capsules", () =>
  Effect.gen(function* () {
    const env = { HOME: "/home/test", PATH: "/inherited/bin:/usr/bin" };
    yield* fixPath().pipe(
      Effect.provideService(HostProcessEnvironment, env),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(NodeServices.layer),
    );
    assert.equal(env.PATH, "/official/bin:/usr/bin:/inherited/bin");
  }),
);

it("hydrates HOME for minimal service environments from the user account", () => {
  const env: NodeJS.ProcessEnv = {};

  hydratePosixHome(env);

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("hydrates HOME independently of a blank process HOME", () => {
  const originalHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: " " };

  try {
    process.env.HOME = " ";
    hydratePosixHome(env);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, () => {
    throw new Error("HOME lookup should not run");
  });

  assert.equal(env.HOME, "/custom/home");
});
