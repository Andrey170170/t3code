import type { TimestampFormat } from "@t3tools/contracts/settings";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

describe("timeOfDayForLabel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // Each has a quirk: day periods before the time, local digits, "19 h 05",
  // 0-based or 24-based hours, a one-letter period, a spaced period.
  const locales = ["en-US", "en-GB", "zh-CN", "ko-KR", "ja-JP", "fi-FI", "fr-CA", "bg-BG"].concat([
    "ar-EG",
    "hi-IN",
    "gd",
    "kab",
    "en-US-u-hc-h24",
  ]);
  it.each(locales.flatMap((locale) => ["locale", "12-hour", "24-hour"].map((f) => [locale, f])))(
    "reads every %s %s label back as its own time",
    async (locale, format) => {
      vi.stubGlobal("window", { desktopBridge: { getSystemLocale: () => locale } });
      vi.resetModules();
      const { formatTimeOfDay, timeOfDayForLabel } = await import("./timestampFormat");
      const { toTimeOfDay } = await import("./timeOfDay");
      const timestampFormat = format as TimestampFormat;
      for (let minutes = 0; minutes < 24 * 60; minutes += 1) {
        const time = toTimeOfDay(Math.floor(minutes / 60), minutes % 60);
        const label = formatTimeOfDay(time, timestampFormat);
        expect(timeOfDayForLabel(label, timestampFormat), label).toBe(time);
        // Typed back with ordinary spaces and without invisible marks.
        const typed = label
          .replace(/\p{Cf}/gu, "")
          .replace(/\s/g, " ")
          .toUpperCase();
        expect(timeOfDayForLabel(typed, timestampFormat), typed).toBe(time);
      }
    },
  );

  it("labels only HH:mm times", async () => {
    vi.stubGlobal("window", { desktopBridge: { getSystemLocale: () => "en-GB" } });
    vi.resetModules();
    const { formatTimeOfDay } = await import("./timestampFormat");
    expect(formatTimeOfDay("15:44", "locale")).toBe("15:44");
    expect(formatTimeOfDay("", "locale")).toBe("");
    expect(formatTimeOfDay("25:00", "locale")).toBe("");
  });

  it("matches the start of a localized label", async () => {
    vi.stubGlobal("window", { desktopBridge: { getSystemLocale: () => "zh-CN" } });
    vi.resetModules();
    const { timeOfDayLabelStartsWith } = await import("./timestampFormat");
    expect(timeOfDayLabelStartsWith("19:00", "下午7", "12-hour")).toBe(true);
    expect(timeOfDayLabelStartsWith("07:00", "下午7", "12-hour")).toBe(false);
  });
});
