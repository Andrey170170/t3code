import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AssetResource } from "./assets.ts";

describe("AssetResource", () => {
  const decode = Schema.decodeUnknownSync(AssetResource);

  it("decodes an absolute temporary image resource", () => {
    expect(
      decode({
        _tag: "temporary-image",
        threadId: "thread-1",
        path: "/tmp/t3-image.png",
      }),
    ).toEqual({
      _tag: "temporary-image",
      threadId: "thread-1",
      path: "/tmp/t3-image.png",
    });
  });

  it("rejects empty and oversized temporary image paths", () => {
    expect(() => decode({ _tag: "temporary-image", threadId: "thread-1", path: "   " })).toThrow();
    expect(() =>
      decode({ _tag: "temporary-image", threadId: "thread-1", path: "x".repeat(1025) }),
    ).toThrow();
  });
});
