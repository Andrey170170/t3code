"use client";

import type { TimestampFormat } from "@t3tools/contracts/settings";
import { ClockIcon } from "lucide-react";
import { useRef, useState } from "react";

import { parseTimeOfDay, timeOfDayOptions } from "~/timeOfDay";
import { formatTimeOfDay, normalizeTimeEntry, resolveHour12 } from "~/timestampFormat";

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
  const parseDraft = (exact: boolean) =>
    parseTimeOfDay(normalizeTimeEntry(draft ?? "", timestampFormat), hour12, exact);
  const matches = draft === null || draft.trim() === "" ? items : parseDraft(false);
  const formatLabel = (item: string) => formatTimeOfDay(item, timestampFormat);

  return (
    <Combobox<string>
      items={items}
      filteredItems={matches}
      value={value === "" ? null : value}
      inputValue={draft ?? formatLabel(value)}
      autoHighlight
      itemToStringLabel={formatLabel}
      onInputValueChange={(next, details) => {
        // Base UI also clears or refills the input itself (Escape, item
        // press); those fall back to the committed time.
        setDraft(details.reason === "input-change" ? next : null);
      }}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      onOpenChange={(open, details) => {
        if (open) return;
        // Leaving the field keeps an unambiguous typed time rather than
        // silently reverting it; Escape and ambiguous text still revert.
        if (
          draft !== null &&
          (details.reason === "focus-out" || details.reason === "outside-press")
        ) {
          const typed = parseDraft(true);
          if (typed.length === 1 && typed[0] !== value) onValueChange(typed[0]!);
        }
        setDraft(null);
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
