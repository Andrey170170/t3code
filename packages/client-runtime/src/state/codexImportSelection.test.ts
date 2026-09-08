import { describe, expect, it } from "vite-plus/test";
import {
  codexProjectSelectionState,
  runCodexImportBatch,
  updateCodexImportSelection,
} from "./codexImportSelection.ts";

describe("Codex import selection", () => {
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
