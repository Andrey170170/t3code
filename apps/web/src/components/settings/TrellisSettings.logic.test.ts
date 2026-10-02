import { describe, expect, it } from "vite-plus/test";

import {
  formatBytes,
  historyDefaultNote,
  historyEdit,
  lastThinningText,
  snapshotCountsText,
  staleDetailsNotice,
  trellisVersionText,
  wouldRemoveText,
} from "./TrellisSettings.logic";

describe("formatBytes", () => {
  it("uses the largest decimal unit, with one decimal below ten", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1_500_000_000)).toBe("1.5 GB");
    expect(formatBytes(120_000_000_000)).toBe("120 GB");
    expect(formatBytes(1_000_000_000_000)).toBe("1 TB");
  });
});

describe("staleDetailsNotice", () => {
  const formatTime = (epochMs: number) => `t=${epochMs}`;

  it("flags shown details whose refresh failed, with the reason and their time", () => {
    expect(
      staleDetailsNotice({
        hasData: true,
        error: "Trellis is unavailable",
        updatedAt: 5,
        formatTime,
      }),
    ).toBe("Could not refresh: Trellis is unavailable. Showing details from t=5.");
  });

  it("says nothing for current details or when there are none to mark", () => {
    expect(staleDetailsNotice({ hasData: true, error: null, updatedAt: 5, formatTime })).toBeNull();
    expect(
      staleDetailsNotice({ hasData: false, error: "down", updatedAt: 0, formatTime }),
    ).toBeNull();
  });
});

describe("trellisVersionText", () => {
  it("shows the commit beside the version and tolerates either being unreported", () => {
    expect(trellisVersionText({ version: "0.1.0", commit: "abc1234-dirty" })).toBe(
      "0.1.0 (abc1234-dirty)",
    );
    expect(trellisVersionText({ version: "0.1.0", commit: null })).toBe("0.1.0");
    expect(trellisVersionText({ version: null, commit: null })).toBeNull();
  });
});

describe("historyEdit", () => {
  it("sends only the edited key, and nothing when the value did not change", () => {
    expect(historyEdit("ideaTrashDays", 14, 30)).toEqual({
      kind: "change",
      patch: { ideaTrashDays: 14 },
    });
    expect(historyEdit("timerMinutes", 0, 1)).toEqual({
      kind: "change",
      patch: { timerMinutes: 0 },
    });
    expect(historyEdit("ideaTrashDays", 30, 30)).toEqual({ kind: "unchanged" });
  });

  it("refuses an empty field, a fraction or a negative number before sending", () => {
    for (const input of [null, 2.5, -1, Number.NaN]) {
      expect(historyEdit("turnKeepAllDays", input, 7)).toEqual({
        kind: "invalid",
        message: "Enter a whole number, 0 or more.",
      });
    }
  });
});

describe("history display", () => {
  it("names the default only when the value differs from a known one", () => {
    expect(historyDefaultNote(14, 30, "day")).toBe("Default: 30 days");
    expect(historyDefaultNote(0, 1, "minute")).toBe("Default: 1 minute");
    expect(historyDefaultNote(30, 30, "day")).toBeNull();
    expect(historyDefaultNote(14, undefined, "day")).toBeNull();
  });

  it("mentions removals only when the next thinning would remove some", () => {
    expect(wouldRemoveText(0)).toBeNull();
    expect(wouldRemoveText(1)).toBe("The next thinning removes 1 snapshot.");
    expect(wouldRemoveText(12)).toBe("The next thinning removes 12 snapshots.");
  });

  it("totals snapshots and lists kinds, most first", () => {
    expect(snapshotCountsText({ timer: 12, turn: 40, label: 1 })).toEqual({
      total: 53,
      byKind: "40 turn · 12 timer · 1 label",
    });
    expect(snapshotCountsText({})).toEqual({ total: 0, byKind: null });
  });

  it("describes the last thinning, or its absence", () => {
    const formatTime = (unixSeconds: number) => `t=${unixSeconds}`;
    expect(lastThinningText(null, formatTime)).toBe("Not since Trellis started");
    expect(lastThinningText({ at: 5, removed: 1 }, formatTime)).toBe("t=5, removed 1 snapshot");
  });
});
