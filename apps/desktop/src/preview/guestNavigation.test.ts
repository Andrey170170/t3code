import { describe, expect, it } from "vite-plus/test";

import { guestNavigationNeedsMapping } from "./guestNavigation.ts";

describe("guestNavigationNeedsMapping", () => {
  it("holds back loopback targets on another origin", () => {
    expect(guestNavigationNeedsMapping("http://127.0.0.1:31000/", "http://localhost:8000/")).toBe(
      true,
    );
    expect(guestNavigationNeedsMapping("https://example.com/", "http://127.0.0.2:3000/x")).toBe(
      true,
    );
    expect(guestNavigationNeedsMapping("about:blank", "http://[::1]:5173/")).toBe(true);
  });

  it("lets same-origin and non-loopback navigations load", () => {
    expect(
      guestNavigationNeedsMapping("http://127.0.0.1:31000/", "http://127.0.0.1:31000/next"),
    ).toBe(false);
    expect(guestNavigationNeedsMapping("http://localhost:8000/", "https://example.com/")).toBe(
      false,
    );
    expect(guestNavigationNeedsMapping("http://localhost:8000/", "mailto:a@b.c")).toBe(false);
  });
});
