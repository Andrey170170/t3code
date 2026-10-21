"use client";

import type { TimestampFormat } from "@t3tools/contracts/settings";
import { ClockIcon } from "lucide-react";
import { useRef, useState } from "react";

import { parseTimeOfDay, timeOfDayOptions } from "~/timeOfDay";
import {
  formatTimeOfDay,
  resolveHour12,
  timeOfDayForLabel,
  timeOfDayLabelStartsWith,
} from "~/timestampFormat";

import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "./combobox";

/**
 * Picks a time of day from quarter-hour slots, or takes a typed one such as
 * "7pm" or "19:05". `value` is local `HH:mm`, like `<input type="time">`.
 */
function TimeField({
  value,
  onValueChange,
  timestampFormat,
  ...inputProps
}: {
  value: string;
  onValueChange: (value: string) => void;
  timestampFormat: TimestampFormat;
  id?: string;
  className?: string;
  "aria-label"?: string;
}) {
  // The text being typed, or null while the input shows the committed time.
  const [draft, setDraft] = useState<string | null>(null);
  const focusedBeforePressRef = useRef(false);
  const hour12 = resolveHour12(timestampFormat);
  const items = timeOfDayOptions(value);
  const formatLabel = (item: string) => formatTimeOfDay(item, timestampFormat);
  // Times the typed text could mean: the ASCII forms `parseTimeOfDay` reads,
  // plus any time whose displayed label it is, or else begins.
  const typedTimes = (text: string, exact: boolean) => {
    const parsed = parseTimeOfDay(text, hour12, exact);
    const labelled = timeOfDayForLabel(text, timestampFormat);
    const prefixed =
      exact || parsed.length > 0
        ? []
        : items.filter((item) => timeOfDayLabelStartsWith(item, text, timestampFormat));
    return [...new Set([...parsed, ...(labelled ? [labelled] : []), ...prefixed])].toSorted();
  };
  const matches = draft === null || draft.trim() === "" ? items : typedTimes(draft, false);

  return (
    <Combobox<string>
      items={items}
      filteredItems={matches}
      value={value === "" ? null : value}
      inputValue={draft ?? formatLabel(value)}
      autoHighlight
      itemToStringLabel={formatLabel}
      onInputValueChange={(next, details) => {
        // Typing or deleting edits the draft. Base UI's own rewrites (Escape,
        // item press, close) fall back to the committed time.
        const edited = details.reason === "input-change" || details.reason === "input-clear";
        setDraft(edited ? next : null);
      }}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      onOpenChange={(open, details) => {
        // Leaving the field is settled on blur instead.
        if (!open && details.reason !== "focus-out" && details.reason !== "outside-press") {
          setDraft(null);
        }
      }}
    >
      <ComboboxInput
        {...inputProps}
        triggerIcon={<ClockIcon />}
        triggerLabel="Choose time"
        onBlur={() => {
          // Leaving keeps an unambiguous typed time rather than silently
          // reverting it; ambiguous or invalid text reverts. Blur also covers
          // edits made while the list was closed.
          if (draft === null) return;
          const typed = typedTimes(draft, true);
          if (typed.length === 1 && typed[0] !== value) onValueChange(typed[0]!);
          setDraft(null);
        }}
        onKeyDown={(event) => {
          // With nothing to pick, Enter would submit the surrounding form with
          // the last committed time while the field shows something else.
          const unresolved = draft !== null && (draft.trim() === "" || matches.length === 0);
          if (event.key === "Enter" && unresolved) event.preventDefault();
        }}
        onPointerDown={(event) => {
          focusedBeforePressRef.current = document.activeElement === event.currentTarget;
        }}
        onClick={(event) => {
          // Select on the click that focuses, so typing replaces the shown
          // time; later clicks place the caret as usual.
          if (!focusedBeforePressRef.current) event.currentTarget.select();
          focusedBeforePressRef.current = true;
        }}
      />
      <ComboboxPopup className="tabular-nums">
        <ComboboxEmpty>Enter a time like {hour12 ? "7:30 pm" : "19:30"}</ComboboxEmpty>
        <ComboboxList>
          {(item: string) => (
            <ComboboxItem key={item} value={item}>
              {formatLabel(item)}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

export { TimeField };
