import { describe, expect, it } from "vite-plus/test";

import { formatBytes, trellisVersionText } from "./TrellisSettings.logic";

describe("formatBytes", () => {
  it("uses the largest binary unit, with one decimal below ten", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1_610_612_736)).toBe("1.5 GB");
    expect(formatBytes(128_849_018_880)).toBe("120 GB");
    expect(formatBytes(1_099_511_627_776)).toBe("1 TB");
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
