import { assert, describe, it } from "@effect/vitest";

import { createPnpmPackArgs, createVpPmPublishArgs } from "./cliArgs.ts";

describe("server CLI package-manager arguments", () => {
  it("constructs a local pack command with an explicit output path", () => {
    assert.deepEqual(createPnpmPackArgs("/tmp/t3.tgz"), [
      "pack",
      "--filter",
      "t3",
      "--out",
      "/tmp/t3.tgz",
      "--json",
    ]);
  });

  it("preserves publish options", () => {
    assert.deepEqual(
      createVpPmPublishArgs({
        access: "public",
        tag: "next",
        provenance: true,
        dryRun: true,
      }),
      [
        "publish",
        "--filter",
        "t3",
        "--access",
        "public",
        "--tag",
        "next",
        "--no-git-checks",
        "--provenance",
        "--dry-run",
      ],
    );
  });
});
