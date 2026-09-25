import { describe, expect, it } from "vite-plus/test";

import { isTrellisManagedPath } from "./Trellis.ts";
import { selectRollbackSnapshot, trellisRestoreScope } from "./TrellisCheckpoints.ts";
import { decideTrellisLaunch, rewriteLoopbackUrl } from "./TrellisProviderSession.ts";
import { trellisTerminalSpawnInput } from "./TrellisPtyAdapter.ts";

const env = { root: "/trellis", bin: "/opt/trellis", shimDir: "/t3/trellis-shims" };
const idea = "/trellis/workspaces/ws-scratch/project/idea-1";

describe("isTrellisManagedPath", () => {
  it("accepts project directories and paths below them only", () => {
    expect(isTrellisManagedPath("/trellis", "/trellis/workspaces/ws-1/project")).toBe(true);
    expect(isTrellisManagedPath("/trellis", `${idea}/src/`)).toBe(true);
    expect(isTrellisManagedPath("/trellis", "/trellis/workspaces/ws-1/rootfs/etc")).toBe(false);
    expect(isTrellisManagedPath("/trellis", "/trellis/workspaces")).toBe(false);
    expect(isTrellisManagedPath("/trellis", "/trellis/workspaces-old/ws-1/project")).toBe(false);
    expect(isTrellisManagedPath("/trellis", "/home/me/code")).toBe(false);
  });
});

describe("decideTrellisLaunch", () => {
  it("keeps sessions on the host when Trellis is disabled or the cwd is elsewhere", () => {
    expect(
      decideTrellisLaunch({ env: null, expectedRoot: null, driverKind: "cursor", cwd: idea }),
    ).toEqual({
      kind: "host",
    });
    expect(
      decideTrellisLaunch({
        env,
        expectedRoot: env.root,
        driverKind: "cursor",
        cwd: "/home/me/code",
      }),
    ).toEqual({
      kind: "host",
    });
    // Probes run without a project cwd.
    expect(
      decideTrellisLaunch({ env, expectedRoot: env.root, driverKind: "codex", cwd: undefined }),
    ).toEqual({
      kind: "host",
    });
  });

  it("refuses a Trellis project path while Trellis is unreachable", () => {
    const decision = decideTrellisLaunch({
      env: null,
      expectedRoot: "/trellis",
      driverKind: "codex",
      cwd: idea,
    });
    expect(decision.kind === "unsupported" && decision.message).toContain("Trellis is not running");
  });

  it("runs Codex and Claude through the shims inside a Trellis project path", () => {
    for (const driverKind of ["codex", "claudeAgent"]) {
      expect(decideTrellisLaunch({ env, expectedRoot: env.root, driverKind, cwd: idea })).toEqual({
        kind: "workspace",
        shimDir: env.shimDir,
      });
    }
  });

  it("refuses other providers and missing shims inside a Trellis project path", () => {
    for (const driverKind of ["cursor", "grok", "opencode", "antigravity"]) {
      const decision = decideTrellisLaunch({ env, expectedRoot: env.root, driverKind, cwd: idea });
      expect(decision.kind).toBe("unsupported");
      expect(decision.kind === "unsupported" && decision.message).toContain(
        "not supported inside Trellis workspaces yet",
      );
    }
    expect(
      decideTrellisLaunch({
        env: { ...env, shimDir: null },
        expectedRoot: env.root,
        driverKind: "codex",
        cwd: idea,
      }).kind,
    ).toBe("unsupported");
  });
});

describe("rewriteLoopbackUrl", () => {
  it("points host loopback URLs at the host from inside the workspace network", () => {
    expect(rewriteLoopbackUrl("http://127.0.0.1:3773/mcp?x=1")).toBe(
      "http://host.containers.internal:3773/mcp?x=1",
    );
    expect(rewriteLoopbackUrl("http://localhost/mcp")).toBe("http://host.containers.internal/mcp");
    expect(rewriteLoopbackUrl("http://[::1]:80")).toBe("http://host.containers.internal:80");
  });

  it("leaves other hosts alone", () => {
    for (const url of [
      "http://100.64.0.3:3773/mcp",
      "https://localhost.example.com/mcp",
      "http://127.0.0.10:3773",
    ]) {
      expect(rewriteLoopbackUrl(url)).toBe(url);
    }
  });
});

describe("trellisTerminalSpawnInput", () => {
  const input = { shell: "/bin/zsh", cwd: idea, cols: 80, rows: 24, env: {} };

  it("opens a login bash inside the workspace for a Trellis project path", () => {
    expect(trellisTerminalSpawnInput(env, input)).toEqual({
      ...input,
      shell: "/opt/trellis",
      args: ["exec", "--tty", "--cwd", idea, "--", "bash", "-l"],
    });
  });

  it("spawns other terminals unchanged", () => {
    const host = { ...input, cwd: "/home/me/code" };
    expect(trellisTerminalSpawnInput(env, host)).toBe(host);
    expect(trellisTerminalSpawnInput({ root: null, bin: env.bin }, input)).toBe(input);
  });
});

describe("selectRollbackSnapshot", () => {
  const snapshot = (id: string, thread: string | null, turn: string | null) => ({
    id,
    workspace_id: "ws-scratch",
    seq: 0,
    kind: "turn",
    thread,
    turn,
    created_at: 0,
  });
  const snapshots = [
    snapshot("snap-other", "thread-2", "baseline"),
    snapshot("snap-base", "thread-1", "baseline"),
    snapshot("snap-t1", "thread-1", "turn-1"),
    snapshot("snap-timer", null, null),
    snapshot("snap-t2", "thread-1", "turn-2"),
  ];
  const checkpoints = [
    { checkpointTurnCount: 1, turnId: "turn-1" },
    { checkpointTurnCount: 2, turnId: "turn-2" },
  ];

  it("maps checkpoint 0 to the thread's baseline and N to its turn snapshot", () => {
    const select = (turnCount: number) =>
      selectRollbackSnapshot({ threadId: "thread-1", turnCount, checkpoints, snapshots });
    expect(select(0)).toEqual({ _tag: "Found", snapshotId: "snap-base" });
    expect(select(1)).toEqual({ _tag: "Found", snapshotId: "snap-t1" });
    expect(select(2)).toEqual({ _tag: "Found", snapshotId: "snap-t2" });
  });

  it("reports a missing snapshot instead of choosing a nearby one", () => {
    expect(
      selectRollbackSnapshot({
        threadId: "thread-3",
        turnCount: 0,
        checkpoints: [],
        snapshots,
      })._tag,
    ).toBe("Missing");
    expect(
      selectRollbackSnapshot({
        threadId: "thread-1",
        turnCount: 3,
        checkpoints: [...checkpoints, { checkpointTurnCount: 3, turnId: "turn-3" }],
        snapshots,
      })._tag,
    ).toBe("Missing");
  });
});

describe("trellisRestoreScope", () => {
  const workspace = (kind: string) => ({
    id: "ws-1",
    kind,
    name: "main",
    path: "/trellis/workspaces/ws-1/project",
    deleted_at: null,
  });
  const project = (kind: string) => ({
    id: "p",
    kind,
    name: "n",
    description: "",
    workspace_id: "ws-1",
    path: `/trellis/workspaces/ws-1/project${kind === "idea" ? "/idea-1" : ""}`,
    deleted_at: null,
    graduated_to: null,
    workspaces: [],
  });

  it("restores only the idea folder in scratch and the whole workspace otherwise", () => {
    expect(
      trellisRestoreScope({ workspace: workspace("scratch"), project: project("idea") }),
    ).toEqual({ path: "/trellis/workspaces/ws-1/project/idea-1", restartsWorkspace: false });
    expect(
      trellisRestoreScope({ workspace: workspace("dedicated"), project: project("project") }),
    ).toEqual({ path: "/trellis/workspaces/ws-1/project", restartsWorkspace: true });
    // A scratch path outside any idea would roll back every idea.
    expect(trellisRestoreScope({ workspace: workspace("scratch"), project: null })).toBeNull();
  });
});
