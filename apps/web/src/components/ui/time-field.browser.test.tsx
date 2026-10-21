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
}: {
  initial: string;
  committed: string[];
  timestampFormat?: TimestampFormat;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
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
    </>
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
      { router: false },
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
      { router: false },
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
      { router: false },
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
      <>
        <button type="button">Before</button>
        <ControlledTimeField initial="09:00" committed={committed} />
      </>,
      { router: false },
    );
    const input = timeInput(screen);
    screen.container.querySelector<HTMLButtonElement>("button")!.focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(input);
    await userEvent.keyboard("21{Tab}");
    expect(committed).toEqual(["21:00"]);
  });

  it("does not submit its form while the typed text is not a time", async () => {
    const committed: string[] = [];
    let submits = 0;
    await using screen = await render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submits += 1;
        }}
      >
        <ControlledTimeField initial="09:00" committed={committed} />
        <button type="submit">Snooze</button>
      </form>,
      { router: false },
    );
    const input = timeInput(screen);
    input.focus();
    await userEvent.keyboard("{Control>}a{/Control}{Backspace}{Enter}");
    await userEvent.keyboard("soon{Enter}");
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
      { router: false },
    );
    const input = timeInput(screen);
    await userEvent.click(input);
    await userEvent.keyboard("21");
    await userEvent.click(screen.container.querySelector("button:not([data-slot])")!);
    expect(committed).toEqual(["21:00"]);
    await vi.waitFor(() => expect(input.value).toBe("21:00"));
  });

  it("reverts text that is not a time", async () => {
    const committed: string[] = [];
    await using screen = await render(
      <ControlledTimeField initial="09:00" committed={committed} />,
      { router: false },
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
    expect(committed).toEqual([]);
    await vi.waitFor(() => expect(input.value).toBe("09:00"));
  });

  it("keeps showing the time when Escape is pressed with the list closed", async () => {
    const committed: string[] = [];
    await using screen = await render(
      <ControlledTimeField initial="09:00" committed={committed} />,
      { router: false },
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
      { router: false },
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

  it("relabels the shown time when the clock format changes", async () => {
    const committed: string[] = [];
    await using screen = await render(
      <ControlledTimeField initial="21:00" committed={committed} />,
      { router: false },
    );
    const input = timeInput(screen);
    expect(input.value).toBe("21:00");
    await screen.rerender(
      <ControlledTimeField initial="21:00" committed={committed} timestampFormat="12-hour" />,
    );
    expect(input.value.replace(/\s/g, " ")).toMatch(/^9:00 pm$/i);
  });

  it("lets the time be cleared before typing a new one, reverting if left empty", async () => {
    const committed: string[] = [];
    await using screen = await render(
      <ControlledTimeField initial="09:00" committed={committed} />,
      { router: false },
    );
    const input = timeInput(screen);
    input.focus();
    await userEvent.keyboard("{Control>}a{/Control}{Backspace}");
    expect(input.value).toBe("");
    await userEvent.keyboard("{Tab}");
    expect(committed).toEqual([]);
    expect(input.value).toBe("09:00");
  });

  it("commits only the clicked item after typing", async () => {
    const committed: string[] = [];
    await using screen = await render(
      <ControlledTimeField initial="09:00" committed={committed} />,
      { router: false },
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
