import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { runExclusiveTrellisIdea, trellisIdeaPendingAtom } from "./trellis";

describe("runExclusiveTrellisIdea", () => {
  const envA = EnvironmentId.make("env-a");
  const envB = EnvironmentId.make("env-b");

  it("runs one creation per environment at a time and releases it afterwards", async () => {
    const registry = AtomRegistry.make();
    let calls = 0;
    let finish = () => {};
    const create = () => {
      calls += 1;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    };

    const first = runExclusiveTrellisIdea(registry, envA, create);
    expect(registry.get(trellisIdeaPendingAtom).includes(envA)).toBe(true);
    expect(await runExclusiveTrellisIdea(registry, envA, create)).toBe(false);
    expect(calls).toBe(1);

    finish();
    expect(await first).toBe(true);
    expect(registry.get(trellisIdeaPendingAtom).includes(envA)).toBe(false);
  });

  it("does not block other environments and releases after a failure", async () => {
    const registry = AtomRegistry.make();
    let release = () => {};
    const pendingA = runExclusiveTrellisIdea(
      registry,
      envA,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    expect(await runExclusiveTrellisIdea(registry, envB, async () => {})).toBe(true);

    await expect(
      runExclusiveTrellisIdea(registry, envB, () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(registry.get(trellisIdeaPendingAtom).includes(envB)).toBe(false);

    release();
    await pendingA;
  });
});
