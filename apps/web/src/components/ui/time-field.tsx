"use client";

import type { TimestampFormat } from "@t3tools/contracts/settings";
import { ClockIcon } from "lucide-react";
import { useRef, useState } from "react";

import { parseTimeOfDay, timeOfDayOptions } from "~/timeOfDay";
import { formatTimeOfDay, resolveHour12 } from "~/timestampFormat";

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
  const [inputValue, setInputValue] = useState("");
  const focusedBeforePressRef = useRef(false);
  const hour12 = resolveHour12(timestampFormat);
  const items = timeOfDayOptions(value);
  const query = inputValue.trim();
  const matches = query === "" ? items : parseTimeOfDay(query, hour12);
  const formatLabel = (item: string) => formatTimeOfDay(item, timestampFormat);

  return (
    <Combobox<string>
      items={items}
      filteredItems={matches}
      value={value === "" ? null : value}
      autoHighlight
      itemToStringLabel={formatLabel}
      onInputValueChange={setInputValue}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      onOpenChange={(open, details) => {
        if (open || (details.reason !== "focus-out" && details.reason !== "outside-press")) return;
        // Leaving the field keeps an unambiguous typed time rather than
        // silently reverting it; Escape and ambiguous text still revert.
        const typed = parseTimeOfDay(query, hour12, true);
        if (typed.length === 1 && typed[0] !== value) onValueChange(typed[0]!);
      }}
    >
      <ComboboxInput
        {...inputProps}
        triggerIcon={<ClockIcon />}
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
