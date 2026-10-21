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
  const exactTime = (text: string) => {
    const typed = typedTimes(text, true);
    return typed.length === 1 ? typed[0]! : null;
  };
  const commit = (next: string) => {
    if (next !== value) onValueChange(next);
    setDraft(null);
  };

  return (
    <Combobox<string>
      items={items}
      filteredItems={matches}
      value={value === "" ? null : value}
      inputValue={draft ?? formatLabel(value)}
      autoHighlight
      itemToStringLabel={formatLabel}
      onInputValueChange={(next, details) => {
        // Typing edits the draft; Escape and picking an item end it. Base UI
        // also rewrites the input when the list closes, which would discard
        // the draft before blur settles it, so other reasons are ignored.
        if (details.reason === "input-change") setDraft(next);
        else if (details.reason === "escape-key" || details.reason === "item-press") setDraft(null);
      }}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      onOpenChange={(open, details) => {
        // Escape cancels the draft; any other close keeps it for blur to settle.
        if (!open && details.reason === "escape-key") setDraft(null);
      }}
    >
      <ComboboxInput
        {...inputProps}
        triggerIcon={<ClockIcon />}
        triggerLabel="Choose time"
        onBlur={() => {
          // Leaving keeps an unambiguous typed time. Anything else clears the
          // value, as `<input type="time">` does, so a button pressed next
          // cannot act on the time the field no longer shows. Blur also covers
          // edits made while the list was closed.
          if (draft !== null) commit(exactTime(draft) ?? "");
        }}
        onKeyDown={(event) => {
          // While editing, Enter only picks a time; submitting the surrounding
          // form would send the last committed time while the field shows the
          // draft. Base UI selects the highlighted item from an open list;
          // with the list closed, Enter takes an unambiguous typed time.
          if (event.key !== "Enter" || draft === null) return;
          event.preventDefault();
          if (event.currentTarget.ariaExpanded === "true") return;
          const typed = exactTime(draft);
          if (typed !== null) commit(typed);
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
