import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  assetState: {
    _tag: "Success" as const,
    url: "https://environment.test/api/assets/signed/workspace-image.png",
  } as
    | { readonly _tag: "Loading" }
    | { readonly _tag: "Failure" }
    | { readonly _tag: "Success"; readonly url: string },
  temporaryAssetState: null as
    | null
    | { readonly _tag: "Loading" }
    | { readonly _tag: "Failure" }
    | { readonly _tag: "Success"; readonly url: string },
  prepared: true,
  assetRequests: [] as Array<{ readonly environmentId: unknown; readonly resource: unknown }>,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => undefined }));
vi.mock("../assets/assetUrls", () => ({
  useAssetUrlState: (environmentId: unknown, resource: unknown) => {
    testState.assetRequests.push({ environmentId, resource });
    if (
      (resource as { readonly _tag?: string } | null)?._tag === "temporary-image" &&
      testState.temporaryAssetState
    ) {
      return testState.temporaryAssetState;
    }
    return testState.assetState;
  },
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => undefined }));
vi.mock("../state/entities", () => ({
  useActiveEnvironmentId: () => "environment-test",
}));
vi.mock("../state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/session")>();
  const Option = await import("effect/Option");
  return {
    ...actual,
    usePreparedConnection: () =>
      testState.prepared
        ? Option.some({ httpBaseUrl: "https://environment.test/" })
        : Option.none(),
  };
});
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("~/lib/openPullRequestLink", () => ({ useOpenChangeRequestLink: () => vi.fn() }));

import ChatMarkdown, { orderedListGutterStyle } from "./ChatMarkdown";

const threadRef = {
  environmentId: "environment-test" as EnvironmentId,
  threadId: "thread-test" as ThreadId,
} satisfies ScopedThreadRef;

function renderMarkdown(
  text: string,
  options: {
    readonly cwd?: string | undefined;
    readonly threadRef?: ScopedThreadRef | undefined;
    readonly managedAttachmentUrlById?: ReadonlyMap<string, string> | undefined;
  } = {},
): string {
  return renderToStaticMarkup(
    <ChatMarkdown
      text={text}
      cwd={options.cwd}
      threadRef={options.threadRef}
      managedAttachmentUrlById={options.managedAttachmentUrlById}
    />,
  );
}

describe("ChatMarkdown workspace images", () => {
  beforeEach(() => {
    testState.assetState = {
      _tag: "Success",
      url: "https://environment.test/api/assets/signed/workspace-image.png",
    };
    testState.prepared = true;
    testState.temporaryAssetState = null;
    testState.assetRequests = [];
  });

  it("renders a cwd-relative image through the thread workspace asset capability", () => {
    const html = renderMarkdown("![Result](artifacts/result.png)", {
      cwd: "/workspace/project",
      threadRef,
    });

    expect(testState.assetRequests).toEqual([
      {
        environmentId: threadRef.environmentId,
        resource: {
          _tag: "workspace-file",
          threadId: threadRef.threadId,
          path: "/workspace/project/artifacts/result.png",
        },
      },
    ]);
    expect(html).toContain('src="https://environment.test/api/assets/signed/workspace-image.png"');
    expect(html).toContain('alt="Result"');
  });

  it("renders an absolute image through the thread workspace asset capability without a cwd", () => {
    renderMarkdown("![Result](/workspace/project/artifacts/result.png)", { threadRef });

    expect(testState.assetRequests).toEqual([
      {
        environmentId: threadRef.environmentId,
        resource: {
          _tag: "temporary-image",
          threadId: threadRef.threadId,
          path: "/workspace/project/artifacts/result.png",
        },
      },
      {
        environmentId: threadRef.environmentId,
        resource: {
          _tag: "workspace-file",
          threadId: threadRef.threadId,
          path: "/workspace/project/artifacts/result.png",
        },
      },
    ]);
  });

  it.each([
    "/gpfs/projects/team/artifacts/result.png",
    "/lustre/scratch/team/artifacts/result.png",
  ])("routes the portable POSIX path %s through workspace assets", (path) => {
    renderMarkdown(`![Result](${path})`, { threadRef });

    expect(testState.assetRequests).toEqual([
      {
        environmentId: threadRef.environmentId,
        resource: { _tag: "temporary-image", threadId: threadRef.threadId, path },
      },
      {
        environmentId: threadRef.environmentId,
        resource: {
          _tag: "workspace-file",
          threadId: threadRef.threadId,
          path,
        },
      },
    ]);
  });

  it.each([
    {
      source: "file:///workspace/project/artifacts/result.png",
      expectedPath: "/workspace/project/artifacts/result.png",
    },
    {
      source: "C:/workspace/project/artifacts/result.png",
      expectedPath: "C:/workspace/project/artifacts/result.png",
    },
  ])("routes the local image URI $source through workspace assets", (input) => {
    renderMarkdown(`![Result](${input.source})`, { threadRef });

    expect(testState.assetRequests).toEqual([
      {
        environmentId: threadRef.environmentId,
        resource: {
          _tag: "temporary-image",
          threadId: threadRef.threadId,
          path: input.expectedPath,
        },
      },
      {
        environmentId: threadRef.environmentId,
        resource: {
          _tag: "workspace-file",
          threadId: threadRef.threadId,
          path: input.expectedPath,
        },
      },
    ]);
  });

  it("shows a non-broken unavailable state when a workspace asset request fails", () => {
    testState.assetState = { _tag: "Failure" };

    const html = renderMarkdown("![Private result](/tmp/private-result.png)", { threadRef });

    expect(testState.assetRequests).toHaveLength(2);
    expect(html).toContain("Private result — image unavailable");
    expect(html).toContain('aria-label="Private result (image unavailable)"');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("/tmp/private-result.png");
  });

  it("renders an owned environment temporary image through its exact-file asset", () => {
    const temporaryUrl = "https://environment.test/api/assets/signed/temporary-image.png";
    testState.temporaryAssetState = { _tag: "Success", url: temporaryUrl };
    testState.assetState = { _tag: "Failure" };

    const html = renderMarkdown("![Generated](/tmp/agent-generated.png)", { threadRef });

    expect(testState.assetRequests).toEqual([
      {
        environmentId: threadRef.environmentId,
        resource: {
          _tag: "temporary-image",
          threadId: threadRef.threadId,
          path: "/tmp/agent-generated.png",
        },
      },
      {
        environmentId: threadRef.environmentId,
        resource: {
          _tag: "workspace-file",
          threadId: threadRef.threadId,
          path: "/tmp/agent-generated.png",
        },
      },
    ]);
    expect(html).toContain(`src="${temporaryUrl}"`);
  });

  it.each([
    "/srv/t3/userdata/attachments",
    "C:/Users/test/AppData/Local/T3/userdata/attachments",
    String.raw`\\server\share\T3\userdata\attachments`,
  ])(
    "uses only a current-thread managed attachment URL for an attachment-store path at %s",
    (dir) => {
      const attachmentId = "thread-test-00000000-0000-4000-8000-000000000001";
      const attachmentUrl = "https://environment.test/api/assets/signed/attachment.png";
      const html = renderMarkdown(`![Attached](${dir}/${attachmentId}.png)`, {
        threadRef,
        managedAttachmentUrlById: new Map([[attachmentId, attachmentUrl]]),
      });

      expect(testState.assetRequests).toEqual([]);
      expect(html).toContain(`src="${attachmentUrl}"`);
    },
  );

  it("does not replace a remote URL that resembles a managed attachment path", () => {
    const attachmentId = "thread-test-00000000-0000-4000-8000-000000000001";
    const attachmentUrl = "https://environment.test/api/assets/signed/attachment.png";
    const remoteUrl = `https://images.example/attachments/${attachmentId}.png`;
    const html = renderMarkdown(`![Remote](${remoteUrl})`, {
      threadRef,
      managedAttachmentUrlById: new Map([[attachmentId, attachmentUrl]]),
    });

    expect(testState.assetRequests).toEqual([]);
    expect(html).toContain(`src="${remoteUrl}"`);
    expect(html).not.toContain(attachmentUrl);
  });

  it("does not resolve an attachment-store path absent from the current thread", () => {
    testState.assetState = { _tag: "Failure" };
    testState.temporaryAssetState = { _tag: "Failure" };
    const knownUrl = "https://environment.test/api/assets/signed/known-attachment.png";

    const html = renderMarkdown("![Unknown](/srv/t3/userdata/attachments/unknown-attachment.png)", {
      threadRef,
      managedAttachmentUrlById: new Map([["known-attachment", knownUrl]]),
    });

    expect(testState.assetRequests).toHaveLength(2);
    expect(html).toContain("Unknown — image unavailable");
    expect(html).not.toContain(knownUrl);
  });

  it.each([
    {
      missing: "thread",
      cwd: "/workspace/project",
      threadRef: undefined,
      prepared: true,
    },
    {
      missing: "environment connection",
      cwd: "/workspace/project",
      threadRef,
      prepared: false,
    },
    {
      missing: "cwd",
      cwd: undefined,
      threadRef,
      prepared: true,
    },
  ])("shows an unavailable state without an asset request when $missing is absent", (input) => {
    testState.prepared = input.prepared;

    const html = renderMarkdown("![Result](artifacts/result.png)", {
      cwd: input.cwd,
      threadRef: input.threadRef,
    });

    expect(testState.assetRequests).toEqual([]);
    expect(html).toContain("Result — image unavailable");
    expect(html).not.toContain("<img");
  });

  it("leaves remote and data images unchanged without requesting workspace assets", () => {
    const html = renderMarkdown(
      "![Remote](https://images.example/result.png)\n\n![Inline](data:image/png;base64,AA==)",
      { cwd: "/workspace/project", threadRef },
    );

    expect(testState.assetRequests).toEqual([]);
    expect(html).toContain('src="https://images.example/result.png"');
    // react-markdown's default URL transform strips data URLs. The workspace
    // image renderer must not reclassify or otherwise change that behavior.
    expect(html).toContain('<img alt="Inline"');
    expect(html).not.toContain("data:image/png");
  });

  it("leaves root-relative app image URLs unchanged", () => {
    const html = renderMarkdown("![App logo](/assets/brand/logo.png)", {
      cwd: "/workspace/project",
      threadRef,
    });

    expect(testState.assetRequests).toEqual([]);
    expect(html).toContain('src="/assets/brand/logo.png"');
  });
});

describe("orderedListGutterStyle", () => {
  it("leaves the default gutter alone for single-digit lists", () => {
    expect(orderedListGutterStyle(9, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for two-digit lists", () => {
    expect(orderedListGutterStyle(99, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for a two-digit list that starts above 1", () => {
    // start=50 + 49 items => last marker is "98", still two digits.
    expect(orderedListGutterStyle(49, 50)).toBeUndefined();
  });

  it("widens the gutter once the last marker reaches three digits", () => {
    // item 100 is the bug from #6512: a 100-item list starting at 1.
    expect(orderedListGutterStyle(100, undefined)).toEqual({ "--list-gutter": "4ch" });
  });

  it("accounts for a non-default start attribute", () => {
    // start=95 + 9 items => last marker is "103", three digits.
    expect(orderedListGutterStyle(9, 95)).toEqual({ "--list-gutter": "4ch" });
  });

  it("scales further for four-digit markers", () => {
    expect(orderedListGutterStyle(1000, undefined)).toEqual({ "--list-gutter": "5ch" });
  });

  it("treats a missing/zero item count as a single item", () => {
    expect(orderedListGutterStyle(0, undefined)).toBeUndefined();
  });
});
