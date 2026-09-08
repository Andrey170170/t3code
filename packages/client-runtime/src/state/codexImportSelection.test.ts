import { describe, expect, it } from "vite-plus/test";
import {
  codexImportProjectCwd,
  codexImportWorktree,
  codexProjectSelectionState,
  resolveCodexImportCheckout,
  runCodexImportBatch,
  updateCodexImportSelection,
} from "./codexImportSelection.ts";

describe("Codex import selection", () => {
  it("groups main and linked checkouts under one project while retaining native runtime directories", () => {
    const main = { cwd: "/repos/app", projectCwd: "/repos/app" };
    const worktree = {
      cwd: "/worktrees/app-feature/src",
      projectCwd: "/repos/app",
      worktreePath: "/worktrees/app-feature",
      worktreeBranch: "feature/import",
    };
    const detached = {
      cwd: "/worktrees/app-review",
      projectCwd: "/repos/app",
      worktreePath: "/worktrees/app-review",
      worktreeBranch: null,
    };
    const unrelated = { cwd: "/elsewhere/app" };
    const candidates = [main, worktree, detached, unrelated];
    expect(new Set(candidates.map(codexImportProjectCwd))).toEqual(
      new Set(["/repos/app", "/elsewhere/app"]),
    );
    expect(candidates.filter((item) => codexImportProjectCwd(item) === "/repos/app")).toHaveLength(
      3,
    );
    expect(worktree.cwd).toBe("/worktrees/app-feature/src");
    expect(codexImportWorktree(worktree)).toEqual({
      path: "/worktrees/app-feature",
      label: "feature/import",
    });
    expect(codexImportWorktree(detached)).toEqual({
      path: "/worktrees/app-review",
      label: "worktrees/app-review",
    });
    const managedLabels = ["a307", "b918"].map(
      (id) =>
        codexImportWorktree({
          cwd: `/codex/worktrees/${id}/app`,
          projectCwd: "/repos/app",
          worktreePath: `/codex/worktrees/${id}/app`,
          worktreeBranch: null,
        })?.label,
    );
    expect(managedLabels).toEqual(["a307/app", "b918/app"]);
  });
  it("does not infer a worktree from a main checkout subdirectory or missing metadata", () => {
    expect(codexImportWorktree({ cwd: "/repos/app/src", projectCwd: "/repos/app" })).toBeNull();
    expect(
      codexImportWorktree({
        cwd: "/repos/app",
        projectCwd: "/repos/app",
        worktreePath: "/repos/app",
        worktreeBranch: "main",
      }),
    ).toBeNull();
    expect(codexImportProjectCwd({ cwd: "/repos/unknown" })).toBe("/repos/unknown");
    expect(
      codexImportWorktree({
        cwd: "C:\\trees\\feature",
        projectCwd: "C:\\repos\\app",
        worktreePath: "C:\\trees\\feature",
        worktreeBranch: " ",
      }),
    ).toEqual({ path: "C:\\trees\\feature", label: "trees/feature" });
  });
  it("requires explicit same-project checkout choice for removed worktrees, without defaulting to main", () => {
    const removed = { cwd: "/removed/feature", projectCwd: "/repos/app", worktreeMissing: true };
    const checkouts = [{ cwd: "/repos/app" }, { cwd: "/worktrees/available" }];
    expect(resolveCodexImportCheckout(removed, undefined, checkouts)).toEqual({
      kind: "choose-checkout",
    });
    expect(resolveCodexImportCheckout(removed, "/unrelated/repo", checkouts)).toEqual({
      kind: "choose-checkout",
    });
    expect(resolveCodexImportCheckout(removed, "/repos/app", checkouts)).toEqual({
      kind: "chosen-checkout",
      cwdOverride: "/repos/app",
    });
    expect(resolveCodexImportCheckout(removed, "/worktrees/available", checkouts)).toEqual({
      kind: "chosen-checkout",
      cwdOverride: "/worktrees/available",
    });
    expect(
      resolveCodexImportCheckout(removed, "/worktrees/available", [{ cwd: "/repos/app" }]),
    ).toEqual({ kind: "choose-checkout" });
  });
  it("applies a bulk project choice only to removed worktrees, preserving existing runtime folders", () => {
    const checkouts = [{ cwd: "/repos/app" }];
    const rows = [
      { cwd: "/removed/a", projectCwd: "/repos/app", worktreeMissing: true },
      { cwd: "/removed/b", projectCwd: "/repos/app", worktreeMissing: true },
      { cwd: "/worktrees/existing", projectCwd: "/repos/app", worktreeMissing: false },
      { cwd: "/repos/app/src", projectCwd: "/repos/app" },
    ];
    const resolved = rows.map((row) => resolveCodexImportCheckout(row, "/repos/app", checkouts));
    expect(resolved).toEqual([
      { kind: "chosen-checkout", cwdOverride: "/repos/app" },
      { kind: "chosen-checkout", cwdOverride: "/repos/app" },
      { kind: "original" },
      { kind: "original" },
    ]);
  });
  it("does not mistake a selected first page or incomplete catalog for a whole project", () => {
    expect(codexProjectSelectionState(50, 120, true)).toEqual({
      checked: false,
      indeterminate: true,
    });
    expect(codexProjectSelectionState(50, 50, false)).toEqual({
      checked: false,
      indeterminate: true,
    });
    expect(codexProjectSelectionState(120, 120, true)).toEqual({
      checked: true,
      indeterminate: false,
    });
    expect(codexProjectSelectionState(0, 0, true)).toEqual({
      checked: false,
      indeterminate: false,
    });
  });
  it("preserves hidden selections while clearing or adding a filtered project", () => {
    const selection = new Map([
      ["other-project", "other"],
      ["hidden", "hidden"],
      ["match", "match"],
    ]);
    const cleared = updateCodexImportSelection(selection, [["match", "match"]], false);
    expect([...cleared.keys()]).toEqual(["other-project", "hidden"]);
    const added = updateCodexImportSelection(
      cleared,
      [
        ["match", "match"],
        ["next-page", "next"],
      ],
      true,
    );
    expect(added.size).toBe(4);
    expect(selection.size).toBe(3);
  });
  it("runs at most two imports and reports partial failures without losing later items", async () => {
    let active = 0;
    let maxActive = 0;
    const settled: Array<[number, boolean]> = [];
    await runCodexImportBatch(
      [1, 2, 3, 4],
      async (item) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
        if (item === 2) throw new Error("busy");
        return item;
      },
      (item, result) => {
        settled.push([item, result.ok]);
      },
    );
    expect(maxActive).toBe(2);
    expect(settled.toSorted((a, b) => a[0] - b[0])).toEqual([
      [1, true],
      [2, false],
      [3, true],
      [4, true],
    ]);
  });
});
