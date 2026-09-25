import { describe, expect, it } from "vite-plus/test";

import { isTrellisManagedPath } from "./trellis.ts";

describe("isTrellisManagedPath", () => {
  it("accepts project directories and paths below them only", () => {
    expect(isTrellisManagedPath("/trellis", "/trellis/workspaces/ws-1/project")).toBe(true);
    expect(isTrellisManagedPath("/trellis/", "/trellis/workspaces/ws-1/project/idea/src/")).toBe(
      true,
    );
    expect(isTrellisManagedPath("/trellis", "/trellis/workspaces/ws-1/rootfs/etc")).toBe(false);
    expect(isTrellisManagedPath("/trellis", "/trellis/workspaces/ws-1")).toBe(false);
    expect(isTrellisManagedPath("/trellis", "/trellis/workspaces")).toBe(false);
    expect(isTrellisManagedPath("/trellis", "/trellis/workspaces-old/ws-1/project")).toBe(false);
    expect(isTrellisManagedPath("/trellis", "/trellis/workspaces/ws-1/project/../rootfs")).toBe(
      false,
    );
    expect(isTrellisManagedPath("/trellis", "/home/me/code")).toBe(false);
    expect(isTrellisManagedPath("/trellis", "relative/workspaces/ws/project")).toBe(false);
  });
});
