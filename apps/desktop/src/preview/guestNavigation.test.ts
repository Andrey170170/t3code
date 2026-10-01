import { describe, expect, it } from "vite-plus/test";

import { guestNavigationNeedsMapping, guestWindowOpenAction } from "./guestNavigation.ts";
import { previewWindowOpenAction } from "./Manager.ts";

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

describe("guestWindowOpenAction", () => {
  const page = "http://127.0.0.1:31000/";
  const open = (url: string) =>
    guestWindowOpenAction(page, url, previewWindowOpenAction({ url, disposition: "new-window" }));

  it("maps a loopback popup before it can open", () => {
    expect(open("http://localhost:3000")).toBe("map");
    expect(open("http://127.0.0.2:3000/")).toBe("map");
  });

  it("keeps public OAuth popups and same-origin opens", () => {
    expect(open("https://accounts.google.com/o/oauth2/v2/auth?client_id=x")).toBe(
      previewWindowOpenAction({
        url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
        disposition: "new-window",
      }),
    );
    expect(open("https://accounts.google.com/o/oauth2/v2/auth?client_id=x")).not.toBe("map");
    expect(open(`${page}next`)).not.toBe("map");
  });
});

describe("redirects", () => {
  it("judges a redirect against the navigation it belongs to", () => {
    // A fresh tab loading a mapped address that redirects within its origin.
    expect(
      guestNavigationNeedsMapping("http://127.0.0.1:31000/", "http://127.0.0.1:31000/login"),
    ).toBe(false);
    // A redirect to another loopback origin is mapped.
    expect(guestNavigationNeedsMapping("http://127.0.0.1:31000/", "http://localhost:8001/")).toBe(
      true,
    );
  });
});
