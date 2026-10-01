import type { TrellisStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  mapTrellisPreviewUrl,
  previewResolutionOf,
  type TrellisPreviewResolution,
  type TrellisPreviewStatus,
} from "./trellisPreview";

const ready: TrellisStatus = {
  state: "ready",
  root: "/trellis",
  knownRoots: ["/trellis"],
  socketPath: "/trellis/state/api.sock",
};

function map(
  url: string,
  status: TrellisPreviewStatus,
  resolution: TrellisPreviewResolution = { kind: "mapped", url: "http://127.0.0.1:31000/" },
) {
  const asked: Array<string> = [];
  const result = mapTrellisPreviewUrl(url, {
    status: async () => status,
    resolve: async (target) => {
      asked.push(target);
      return resolution;
    },
  });
  return result.then((value) => ({ value, asked }));
}

describe("mapTrellisPreviewUrl", () => {
  it("maps loopback URLs through the server where Trellis may run", async () => {
    const { value, asked } = await map("http://localhost:8000/", { kind: "known", status: ready });
    expect(value).toEqual({ url: "http://127.0.0.1:31000/" });
    expect(asked).toEqual(["http://localhost:8000/"]);
  });

  it("refuses while the environment's Trellis status is unknown", async () => {
    const { value, asked } = await map("http://localhost:8000/", { kind: "unknown" });
    expect("error" in value && value.error?.message).toContain("runs Trellis");
    expect(asked).toEqual([]);
  });

  it("refuses when the server cannot map the port", async () => {
    const { value } = await map(
      "http://localhost:8000/",
      { kind: "known", status: ready },
      { kind: "failed", message: "workspace is not running" },
    );
    expect("error" in value && value.error?.message).toBe("workspace is not running");
  });

  it("refuses when a Trellis server lacks the mapping method", async () => {
    const resolution = previewResolutionOf(
      AsyncResult.failure(Cause.die("Unknown request tag: trellis.resolvePreviewUrl")),
    );
    expect(resolution.kind).toBe("failed");
    const { value } = await map(
      "http://localhost:8000/",
      { kind: "known", status: ready },
      resolution,
    );
    expect("error" in value && value.error?.message).toContain("cannot map");
  });

  it("loads other URLs and environments without Trellis unchanged", async () => {
    expect((await map("https://example.com/", { kind: "unknown" })).value).toEqual({
      url: "https://example.com/",
    });
    expect((await map("http://localhost:8000/", { kind: "unsupported" })).value).toEqual({
      url: "http://localhost:8000/",
    });
    const neverUsed = await map("http://localhost:8000/", {
      kind: "known",
      status: { ...ready, state: "disabled", knownRoots: [] },
    });
    expect(neverUsed.value).toEqual({ url: "http://localhost:8000/" });
    expect(neverUsed.asked).toEqual([]);
  });
});
