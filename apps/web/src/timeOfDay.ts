// A time of day is a local wall-clock `HH:mm` string, the value format of
// `<input type="time">` that the snooze and scheduled-task contracts already use.

const SLOT_MINUTES = [0, 15, 30, 45] as const;
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function pad(part: number): string {
  return String(part).padStart(2, "0");
}

function toTimeOfDay(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}

export const TIME_OF_DAY_SLOTS: ReadonlyArray<string> = Array.from({ length: 24 }, (_, hour) =>
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
const SEPARATED_PATTERN = new RegExp(String.raw`^(\d{1,2})[:.h](\d{0,2})${MERIDIEM}$`, "i");
const COMPACT_PATTERN = new RegExp(String.raw`^(\d{1,4})${MERIDIEM}$`, "i");

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
  const input = text.trim();
  let hourText: string;
  let minuteText: string;
  let meridiem: string | undefined;
  const separated = SEPARATED_PATTERN.exec(input);
  if (separated) {
    hourText = separated[1]!;
    minuteText = separated[2]!;
    meridiem = separated[3];
  } else {
    const compact = COMPACT_PATTERN.exec(input);
    if (!compact) return [];
    const digits = compact[1]!;
    // "730" and "1905" carry their minutes in the last two digits.
    hourText = digits.length > 2 ? digits.slice(0, -2) : digits;
    minuteText = digits.length > 2 ? digits.slice(-2) : "";
    meridiem = compact[2];
  }
  let minutes: number[];
  if (minuteText.length === 2) minutes = Number(minuteText) < 60 ? [Number(minuteText)] : [];
  else if (exact) minutes = minuteText === "" ? [0] : [];
  else minutes = SLOT_MINUTES.filter((minute) => pad(minute).startsWith(minuteText));
  return hourCandidates(Number(hourText), meridiem, hour12).flatMap((hour) =>
    minutes.map((minute) => toTimeOfDay(hour, minute)),
  );
}
