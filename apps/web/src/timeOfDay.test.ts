import { describe, expect, it } from "vite-plus/test";

import { parseTimeOfDay, TIME_OF_DAY_SLOTS, timeOfDayOptions } from "./timeOfDay";

describe("parseTimeOfDay", () => {
  it("reads explicit AM/PM spellings", () => {
    expect(parseTimeOfDay("7pm", true, true)).toEqual(["19:00"]);
    expect(parseTimeOfDay("7:05 p.m.", true)).toEqual(["19:05"]);
    expect(parseTimeOfDay("7:05p", false)).toEqual(["19:05"]);
    expect(parseTimeOfDay("12am", true, true)).toEqual(["00:00"]);
    expect(parseTimeOfDay("12 PM", true, true)).toEqual(["12:00"]);
  });

  it("reads 24-hour and compact entries", () => {
    expect(parseTimeOfDay("19:05", true)).toEqual(["19:05"]);
    expect(parseTimeOfDay("1905", true)).toEqual(["19:05"]);
    expect(parseTimeOfDay("19h05", false)).toEqual(["19:05"]);
    expect(parseTimeOfDay("730pm", true)).toEqual(["19:30"]);
    expect(parseTimeOfDay("0:00", true)).toEqual(["00:00"]);
  });

  it("offers both halves of the day for a bare hour on a 12-hour clock only", () => {
    expect(parseTimeOfDay("7:05", true)).toEqual(["07:05", "19:05"]);
    expect(parseTimeOfDay("7:05", false)).toEqual(["07:05"]);
    expect(parseTimeOfDay("12:30", true)).toEqual(["00:30", "12:30"]);
  });

  it("expands missing or partial minutes to matching quarter hours", () => {
    expect(parseTimeOfDay("7", false)).toEqual(["07:00", "07:15", "07:30", "07:45"]);
    expect(parseTimeOfDay("7:3", true)).toEqual(["07:30", "19:30"]);
    expect(parseTimeOfDay("7:", false)).toEqual(["07:00", "07:15", "07:30", "07:45"]);
  });

  it("reads missing minutes as the hour itself when exact", () => {
    expect(parseTimeOfDay("19", false, true)).toEqual(["19:00"]);
    expect(parseTimeOfDay("7pm", true, true)).toEqual(["19:00"]);
    expect(parseTimeOfDay("7", true, true)).toEqual(["07:00", "19:00"]);
    expect(parseTimeOfDay("7:3", false, true)).toEqual([]);
  });

  it("rejects impossible times and other text", () => {
    expect(parseTimeOfDay("24:00", false)).toEqual([]);
    expect(parseTimeOfDay("7:60", false)).toEqual([]);
    expect(parseTimeOfDay("13pm", true)).toEqual([]);
    expect(parseTimeOfDay("0am", true)).toEqual([]);
    expect(parseTimeOfDay("noon", true)).toEqual([]);
    expect(parseTimeOfDay("", true)).toEqual([]);
  });
});

describe("timeOfDayOptions", () => {
  it("lists every quarter hour of the day", () => {
    expect(TIME_OF_DAY_SLOTS).toHaveLength(96);
    expect(TIME_OF_DAY_SLOTS.at(0)).toBe("00:00");
    expect(TIME_OF_DAY_SLOTS.at(-1)).toBe("23:45");
  });

  it("slots an off-grid value into order so it stays selectable", () => {
    const options = timeOfDayOptions("19:05");
    expect(options).toHaveLength(97);
    expect(options.slice(options.indexOf("19:00"), options.indexOf("19:00") + 3)).toEqual([
      "19:00",
      "19:05",
      "19:15",
    ]);
    expect(timeOfDayOptions("19:15")).toBe(TIME_OF_DAY_SLOTS);
    expect(timeOfDayOptions("")).toBe(TIME_OF_DAY_SLOTS);
  });
});
