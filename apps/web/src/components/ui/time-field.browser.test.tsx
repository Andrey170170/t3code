import type { TimestampFormat } from "@t3tools/contracts/settings";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { TimeField } from "./time-field";

let root: Root;
let container: HTMLDivElement;
let committed: string[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  committed = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function ControlledTimeField({
  initial,
  timestampFormat = "24-hour",
}: {
  initial: string;
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

async function render(initial: string, timestampFormat: TimestampFormat = "24-hour") {
  await act(async () =>
    root.render(<ControlledTimeField initial={initial} timestampFormat={timestampFormat} />),
  );
  return container.querySelector<HTMLInputElement>('input[aria-label="Time"]')!;
}

function options() {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
}

describe("TimeField", () => {
  it("opens on the current time, even between slots", async () => {
    const input = await render("19:05");
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
    const input = await render("09:00");
    await userEvent.click(input);
    await vi.waitFor(() => expect(options().length).toBeGreaterThan(0));
    await userEvent.click(options().find((option) => option.textContent === "13:30")!);
    expect(committed).toEqual(["13:30"]);
    expect(input.value).toBe("13:30");
  });

  it("narrows the list to what was typed and commits it with Enter", async () => {
    const input = await render("09:00");
    await userEvent.click(input);
    await userEvent.keyboard("7:30pm");
    await vi.waitFor(() =>
      expect(options().map((option) => option.textContent)).toEqual(["19:30"]),
    );
    await userEvent.keyboard("{Enter}");
    expect(committed).toEqual(["19:30"]);
    expect(input.value).toBe("19:30");
  });

  it("keeps an unambiguous typed time when focus leaves", async () => {
    const input = await render("09:00");
    await userEvent.click(input);
    await userEvent.keyboard("21");
    await userEvent.click(container.querySelector("button:not([data-slot])")!);
    expect(committed).toEqual(["21:00"]);
    await vi.waitFor(() => expect(input.value).toBe("21:00"));
  });

  it("reverts text that is not a time", async () => {
    const input = await render("09:00");
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
    const input = await render("09:00");
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

  it("relabels the shown time when the clock format changes", async () => {
    const input = await render("21:00");
    expect(input.value).toBe("21:00");
    await render("21:00", "12-hour");
    expect(input.value.replace(/\s/g, " ")).toMatch(/^9:00 pm$/i);
  });

  it("lets the time be cleared before typing a new one, reverting if left empty", async () => {
    const input = await render("09:00");
    input.focus();
    await userEvent.keyboard("{Control>}a{/Control}{Backspace}");
    expect(input.value).toBe("");
    await userEvent.keyboard("{Tab}");
    expect(committed).toEqual([]);
    expect(input.value).toBe("09:00");
  });

  it("commits only the clicked item after typing", async () => {
    const input = await render("09:00");
    await userEvent.click(input);
    await userEvent.keyboard("7");
    await vi.waitFor(() => expect(options().length).toBe(4));
    await userEvent.click(options().find((option) => option.textContent === "07:15")!);
    expect(committed).toEqual(["07:15"]);
    expect(input.value).toBe("07:15");
  });
});
