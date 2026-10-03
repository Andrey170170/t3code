import { describe, expect, it } from "vite-plus/test";

import {
  formatBytes,
  previewHostChoice,
  previewHostSetting,
  staleDetailsNotice,
  trellisVersionText,
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

describe("preview host", () => {
  it("shows a setting as its choice and sends a choice as a setting", () => {
    expect(previewHostChoice("lan")).toBe("lan");
    expect(previewHostChoice("tailscale")).toBe("tailscale");
    expect(previewHostChoice("127.0.0.1")).toBe("local");
    expect(previewHostChoice("10.0.0.7")).toBe("custom");
    expect(previewHostSetting("local", "")).toBe("127.0.0.1");
    expect(previewHostSetting("tailscale", "ignored")).toBe("tailscale");
    expect(previewHostSetting("custom", " 10.0.0.7 ")).toBe("10.0.0.7");
    expect(previewHostSetting("custom", "  ")).toBeNull();
  });
});
