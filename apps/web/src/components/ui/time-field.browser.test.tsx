import type { TimestampFormat } from "@t3tools/contracts/settings";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render, type Screen } from "../../../test/render";
import { TimeField } from "./time-field";

function ControlledTimeField({
  initial,
  committed,
  timestampFormat = "24-hour",
  onSubmit,
}: {
  initial: string;
  committed: string[];
  timestampFormat?: TimestampFormat;
  onSubmit?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.(value);
      }}
    >
      {/* Above the field, where the open list cannot cover it. */}
      <button type="submit">Snooze</button>
      <TimeField
        aria-label="Time"
        timestampFormat={timestampFormat}
        value={value}
        onValueChange={(next) => {
          committed.push(next);
          setValue(next);
        }}
      />
      <button type="button">Elsewhere</button>
    </form>
  );
}

function timeInput(screen: Screen) {
  return screen.container.querySelector<HTMLInputElement>('input[aria-label="Time"]')!;
}

function options() {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
}

describe("TimeField", () => {
  it("opens on the current time, even between slots", async () => {
    const committed: string[] = [];
    await using screen = await render(
      <ControlledTimeField initial="19:05" committed={committed} />,
    );
    const input = timeInput(screen);
    expect(input.value).toBe("19:05");
    await userEvent.click(input);
    await vi.waitFor(() => expect(options()).toHaveLength(97));
    const selected = options().find((option) => option.getAttribute("aria-selected") === "true");
    expect(selected?.textContent).toBe("19:05");
    expect(selected?.hasAttribute("data-highlighted")).toBe(true);
    // The focusing click selects the shown time so typing replaces it.
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it("commits a picked slot", async () => {
    const committed: string[] = [];
    await using screen = await render(
      <ControlledTimeField initial="09:00" committed={committed} />,
    );
    const input = timeInput(screen);
    await userEvent.click(input);
    await vi.waitFor(() => expect(options().length).toBeGreaterThan(0));
    await userEvent.click(options().find((option) => option.textContent === "13:30")!);
    expect(committed).toEqual(["13:30"]);
    expect(input.value).toBe("13:30");
  });

  it("narrows the list to what was typed and commits it with Enter", async () => {
    const committed: string[] = [];
    await using screen = await render(
      <ControlledTimeField initial="09:00" committed={committed} />,
    );
    const input = timeInput(screen);
    await userEvent.click(input);
    await userEvent.keyboard("7:30pm");
    await vi.waitFor(() =>
      expect(options().map((option) => option.textContent)).toEqual(["19:30"]),
    );
    await userEvent.keyboard("{Enter}");
    expect(committed).toEqual(["19:30"]);
    expect(input.value).toBe("19:30");
  });

  it("replaces the shown time when reached with Tab", async () => {
    const committed: string[] = [];
    await using screen = await render(
      <ControlledTimeField initial="09:00" committed={committed} />,
    );
    const input = timeInput(screen);
    screen.container.querySelector<HTMLButtonElement>('button[type="submit"]')!.focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(input);
    await userEvent.keyboard("21{Tab}");
    expect(committed).toEqual(["21:00"]);
  });

  it("does not submit its form while the typed text is not a time", async () => {
    const committed: string[] = [];
    let submits = 0;
    await using screen = await render(
      <ControlledTimeField
        initial="09:00"
        committed={committed}
        onSubmit={() => {
          submits += 1;
        }}
      />,
    );
    const input = timeInput(screen);
    input.focus();
    await userEvent.keyboard("{Control>}a{/Control}{Backspace}{Enter}");
    await userEvent.keyboard("soon{Enter}");
    // Shift+Enter skips Base UI's item selection, leaving the draft unpicked.
    await userEvent.keyboard("{Control>}a{/Control}21{Shift>}{Enter}{/Shift}");
    expect(submits).toBe(0);
    await userEvent.keyboard("{Control>}a{/Control}21{Enter}");
    expect(committed).toEqual(["21:00"]);
    await userEvent.keyboard("{Enter}");
    expect(submits).toBe(1);
  });

  it("keeps an unambiguous typed time when focus leaves", async () => {
    const committed: string[] = [];
    await using screen = await render(
      <ControlledTimeField initial="09:00" committed={committed} />,
    );
    const input = timeInput(screen);
    await userEvent.click(input);
    await userEvent.keyboard("21");
    await userEvent.click(screen.container.querySelector("button:not([data-slot])")!);
    expect(committed).toEqual(["21:00"]);
    await vi.waitFor(() => expect(input.value).toBe("21:00"));
  });

  it("clears the value when text that is not a time is left", async () => {
    const committed: string[] = [];
    await using screen = await render(
      <ControlledTimeField initial="09:00" committed={committed} />,
    );
    const input = timeInput(screen);
    await userEvent.click(input);
    await userEvent.keyboard("soon");
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="combobox-empty"]')?.textContent).toBe(
        "Enter a time like 19:30",
      ),
    );
    await userEvent.keyboard("{Tab}");
    expect(committed).toEqual([""]);
    expect(input.value).toBe("");
  });

  it("submits no time when a button is pressed while the text is not a time", async () => {
    const committed: string[] = [];
    const submitted: string[] = [];
    await using screen = await render(
      <ControlledTimeField
        initial="09:00"
        committed={committed}
        onSubmit={(value) => submitted.push(value)}
      />,
    );
    await userEvent.click(timeInput(screen));
    await userEvent.keyboard("soon");
    await userEvent.click(screen.container.querySelector('button[type="submit"]')!);
    expect(submitted).toEqual([""]);
  });

  it("keeps showing the time when Escape is pressed with the list closed", async () => {
    const committed: string[] = [];
    await using screen = await render(
      <ControlledTimeField initial="09:00" committed={committed} />,
    );
    const input = timeInput(screen);
    input.focus();
    await userEvent.keyboard("{Escape}");
    expect(input.value).toBe("09:00");
    await userEvent.click(input);
    await vi.waitFor(() => expect(options().length).toBeGreaterThan(0));
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(options()).toHaveLength(0));
    await userEvent.keyboard("{Escape}");
    expect(input.value).toBe("09:00");
    expect(committed).toEqual([]);
  });

  it("reverts a typed draft on Escape", async () => {
    const committed: string[] = [];
    await using screen = await render(
      <ControlledTimeField initial="09:00" committed={committed} />,
    );
    const input = timeInput(screen);
    await userEvent.click(input);
    await userEvent.keyboard("21");
    await vi.waitFor(() => expect(options().length).toBeGreaterThan(0));
    await userEvent.keyboard("{Escape}");
    expect(input.value).toBe("09:00");
    await userEvent.keyboard("soon{Escape}");
    expect(input.value).toBe("09:00");
    await userEvent.keyboard("{Tab}");
    expect(committed).toEqual([]);
  });

  it("keeps a typed time when the list is closed with its button", async () => {
    const committed: string[] = [];
    let submits = 0;
    await using screen = await render(
      <ControlledTimeField
        initial="09:00"
        committed={committed}
        onSubmit={() => {
          submits += 1;
        }}
      />,
    );
    const input = timeInput(screen);
    const closeList = async () => {
      await vi.waitFor(() => expect(options().length).toBeGreaterThan(0));
      await userEvent.click(screen.container.querySelector('button[aria-label="Choose time"]')!);
      await vi.waitFor(() => expect(options()).toHaveLength(0));
    };
    await userEvent.click(input);
    await userEvent.keyboard("21");
    await closeList();
    expect(input.value).toBe("21");
    await userEvent.keyboard("{Tab}");
    expect(committed).toEqual(["21:00"]);
    // Enter commits a typed time too, though Base UI only picks from an open list.
    await userEvent.click(input);
    await userEvent.keyboard("{Control>}a{/Control}7:45pm");
    await closeList();
    await userEvent.keyboard("{Enter}");
    expect(committed).toEqual(["21:00", "19:45"]);
    expect(input.value).toBe("19:45");
    expect(submits).toBe(0);
  });

  it("relabels the shown time when the clock format changes", async () => {
    const committed: string[] = [];
    await using screen = await render(
      <ControlledTimeField initial="21:00" committed={committed} />,
    );
    const input = timeInput(screen);
    expect(input.value).toBe("21:00");
    await screen.rerender(
      <ControlledTimeField initial="21:00" committed={committed} timestampFormat="12-hour" />,
    );
    expect(input.value.replace(/\s/g, " ")).toMatch(/^9:00 pm$/i);
  });

  it("lets the time be cleared", async () => {
    const committed: string[] = [];
    await using screen = await render(
      <ControlledTimeField initial="09:00" committed={committed} />,
    );
    const input = timeInput(screen);
    input.focus();
    await userEvent.keyboard("{Control>}a{/Control}{Backspace}");
    expect(input.value).toBe("");
    await userEvent.keyboard("{Tab}");
    expect(committed).toEqual([""]);
    expect(input.value).toBe("");
  });

  it("commits only the clicked item after typing", async () => {
    const committed: string[] = [];
    await using screen = await render(
      <ControlledTimeField initial="09:00" committed={committed} />,
    );
    const input = timeInput(screen);
    await userEvent.click(input);
    await userEvent.keyboard("7");
    await vi.waitFor(() => expect(options().length).toBe(4));
    await userEvent.click(options().find((option) => option.textContent === "07:15")!);
    expect(committed).toEqual(["07:15"]);
    expect(input.value).toBe("07:15");
  });
});
