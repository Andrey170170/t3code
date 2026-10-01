import { describe, expect, it } from "vite-plus/test";

import {
  isLoopbackHostname,
  isLoopbackHost,
  newPreviewTabId,
  normalizePreviewUrl,
  PreviewUrlNormalizationError,
} from "./preview.ts";

describe("newPreviewTabId", () => {
  it("returns a unique tab id every call", () => {
    const a = newPreviewTabId();
    const b = newPreviewTabId();
    expect(a).not.toBe(b);
    expect(a.startsWith("tab_")).toBe(true);
  });
});

describe("isLoopbackHost", () => {
  it.each(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"])("%s is loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(["example.com", "192.168.1.10", "10.0.0.1", ""])("%s is not loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("normalizePreviewUrl", () => {
  it("treats bare loopback hosts as http", () => {
    expect(normalizePreviewUrl("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizePreviewUrl("127.0.0.1:3000")).toBe("http://127.0.0.1:3000/");
  });

  it("treats bare public hosts as https", () => {
    expect(normalizePreviewUrl("example.com")).toBe("https://example.com/");
  });

  it("respects explicit schemes", () => {
    expect(normalizePreviewUrl("https://localhost:5173")).toBe("https://localhost:5173/");
    expect(normalizePreviewUrl("http://example.com/path?q=1")).toBe("http://example.com/path?q=1");
  });

  it("rejects empty input", () => {
    try {
      normalizePreviewUrl("   ");
      expect.unreachable("expected URL normalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PreviewUrlNormalizationError);
      expect(error).toMatchObject({ inputLength: 3, reason: "empty" });
      expect(error).not.toHaveProperty("rawUrl");
      expect("cause" in (error as object)).toBe(false);
    }
  });

  it("rejects unsupported protocols", () => {
    try {
      normalizePreviewUrl("ftp://example.com");
      expect.unreachable("expected URL normalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PreviewUrlNormalizationError);
      expect(error).toMatchObject({
        inputLength: "ftp://example.com".length,
        reason: "unsupported-protocol",
        protocol: "ftp:",
      });
    }
  });

  it("rejects unparseable input without retaining credentials or tokens", () => {
    const rawUrl = "https://user:password@example.com:bad/path?access_token=secret#fragment";
    try {
      normalizePreviewUrl(rawUrl);
      expect.unreachable("expected URL normalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PreviewUrlNormalizationError);
      expect(error).toMatchObject({
        inputLength: rawUrl.length,
        reason: "parse",
        protocol: "https:",
      });
      expect(error).not.toHaveProperty("rawUrl");
      expect((error as PreviewUrlNormalizationError).cause).toBeInstanceOf(Error);
      expect((error as PreviewUrlNormalizationError).message).not.toContain(
        ((error as PreviewUrlNormalizationError).cause as Error).message,
      );
      expect((error as PreviewUrlNormalizationError).message).not.toMatch(
        /user|password|access_token|secret|fragment/,
      );
    }
  });
});

describe("isLoopbackHostname", () => {
  it("recognizes every loopback spelling a URL can carry", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "localhost.",
      "app.localhost",
      "127.0.0.1",
      "127.0.0.2",
      "127.255.255.254",
      "0.0.0.0",
      "[::1]",
      "::1",
      "[::]",
      "[0:0:0:0:0:0:0:1]",
      "[::ffff:127.0.0.1]",
      "[::ffff:7f00:2]",
      "::ffff:127.1.2.3",
      "[::127.0.0.1]",
    ]) {
      expect(isLoopbackHostname(host), host).toBe(true);
    }
  });

  it("leaves other hosts alone", () => {
    for (const host of [
      "example.com",
      "localhost.example.com",
      "128.0.0.1",
      "10.0.0.1",
      "100.64.0.3",
      "[::2]",
      "[::ffff:10.0.0.1]",
      "[fe80::1]",
      "127.0.0.256",
    ]) {
      expect(isLoopbackHostname(host), host).toBe(false);
    }
  });

  it("agrees with URL parsing of numeric and mapped forms", () => {
    for (const url of [
      "http://127.1:8000/",
      "http://0x7f.0.0.1/",
      "http://[::ffff:127.0.0.1]:8000/",
    ]) {
      expect(isLoopbackHostname(new URL(url).hostname), url).toBe(true);
    }
  });
});
