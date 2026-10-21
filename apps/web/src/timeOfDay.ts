// A time of day is a local wall-clock `HH:mm` string, the value format of
// `<input type="time">` that the snooze and scheduled-task contracts already use.

const SLOT_MINUTES = [0, 15, 30, 45] as const;
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function pad(part: number): string {
  return String(part).padStart(2, "0");
}

export function toTimeOfDay(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}

const TIME_OF_DAY_SLOTS: ReadonlyArray<string> = Array.from({ length: 24 }, (_, hour) =>
  SLOT_MINUTES.map((minute) => toTimeOfDay(hour, minute)),
).flat();

export function isTimeOfDay(value: string): boolean {
  return TIME_OF_DAY_PATTERN.test(value);
}

/** The quarter-hour slots, plus `value` in order when it falls between them. */
export function timeOfDayOptions(value: string): ReadonlyArray<string> {
  if (!isTimeOfDay(value) || TIME_OF_DAY_SLOTS.includes(value)) return TIME_OF_DAY_SLOTS;
  return [...TIME_OF_DAY_SLOTS, value].toSorted();
}

const MERIDIEM = String.raw`\s*(?:([ap])\.?\s*m?\.?)?`;
// Separated minutes may be partial ("7:3"). Compact entries ("730", "1905")
// backtrack so their last two digits are the minutes.
const ENTRY_PATTERN = new RegExp(
  String.raw`^(\d{1,2})(?:[:.h](\d{0,2})|(\d{2}))?${MERIDIEM}$`,
  "i",
);

function hourCandidates(hour: number, meridiem: string | undefined, hour12: boolean): number[] {
  if (meridiem) {
    if (hour < 1 || hour > 12) return [];
    return [(hour % 12) + (meridiem.toLowerCase() === "p" ? 12 : 0)];
  }
  if (hour > 23) return [];
  if (hour12 && hour >= 1 && hour <= 12) return [hour % 12, (hour % 12) + 12];
  return [hour];
}

/**
 * Every time a typed entry could mean, earliest first. On a 12-hour clock an
 * hour without AM/PM reads as both. Missing or partial minutes ("7", "7:3")
 * expand to the matching quarter-hour slots, unless `exact`, which reads
 * missing minutes as :00 and rejects partial ones.
 */
export function parseTimeOfDay(
  text: string,
  hour12: boolean,
  exact = false,
): ReadonlyArray<string> {
  const match = ENTRY_PATTERN.exec(text.trim());
  if (!match) return [];
  const [, hourText, separatedMinutes, compactMinutes, meridiem] = match;
  const minuteText = separatedMinutes ?? compactMinutes ?? "";
  let minutes: number[];
  if (minuteText.length === 2) minutes = Number(minuteText) < 60 ? [Number(minuteText)] : [];
  else if (exact) minutes = minuteText === "" ? [0] : [];
  else minutes = SLOT_MINUTES.filter((minute) => pad(minute).startsWith(minuteText));
  return hourCandidates(Number(hourText), meridiem, hour12).flatMap((hour) =>
    minutes.map((minute) => toTimeOfDay(hour, minute)),
  );
}
