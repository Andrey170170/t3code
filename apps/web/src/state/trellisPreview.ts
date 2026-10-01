import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { PreviewTrellisError, type ScopedThreadRef, type TrellisStatus } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, type AtomRegistry } from "effect/unstable/reactivity";

import { isLoopbackPreviewUrl } from "~/lib/trellis";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { trellisEnvironment } from "./trellis";

/**
 * A loopback preview URL of a Trellis thread could not be mapped to its
 * workspace. The preview must not load: `localhost` there would be the
 * wrong machine.
 */
export class TrellisPreviewMappingError extends Error {
  readonly _tag = "TrellisPreviewMappingError";
}

/** What the environment says about Trellis, as far as preview mapping cares. */
export type TrellisPreviewStatus =
  | { readonly kind: "known"; readonly status: TrellisStatus }
  /** The server predates Trellis: it rejected the method itself. */
  | { readonly kind: "unsupported" }
  /** Not answered in time, or failed for another reason. */
  | { readonly kind: "unknown" };

export type TrellisPreviewResolution =
  | { readonly kind: "mapped"; readonly url: string }
  | { readonly kind: "interrupted" }
  | { readonly kind: "failed"; readonly message: string };

const isPreviewTrellisError = Schema.is(PreviewTrellisError);
const UNKNOWN_METHOD = "Unknown request tag";

const isUnknownMethod = (cause: Cause.Cause<unknown>) =>
  Cause.pretty(cause).includes(UNKNOWN_METHOD);

/**
 * `url` as the browser should load it in a thread, or a mapping error. Only
 * loopback URLs are asked about, and only in environments that may run
 * Trellis; an environment whose Trellis status is not known yet fails closed.
 */
export async function mapTrellisPreviewUrl(
  url: string,
  deps: {
    readonly status: () => Promise<TrellisPreviewStatus>;
    readonly resolve: (url: string) => Promise<TrellisPreviewResolution>;
  },
): Promise<{ readonly url: string } | { readonly error: TrellisPreviewMappingError | null }> {
  if (!isLoopbackPreviewUrl(url)) return { url };
  const status = await deps.status();
  if (status.kind === "unsupported") return { url };
  if (status.kind === "unknown") {
    return {
      error: new TrellisPreviewMappingError(
        "Could not tell whether this environment runs Trellis. Try again once it is connected.",
      ),
    };
  }
  if (status.status.state === "disabled" && status.status.knownRoots.length === 0) return { url };
  const resolution = await deps.resolve(url);
  switch (resolution.kind) {
    case "mapped":
      return { url: resolution.url };
    case "interrupted":
      return { error: null };
    case "failed":
      return { error: new TrellisPreviewMappingError(resolution.message) };
  }
}

/** The environment's Trellis status, refetched unless a settled one is cached. */
function loadTrellisPreviewStatus(
  registry: AtomRegistry.AtomRegistry,
  environmentId: ScopedThreadRef["environmentId"],
  timeoutMs = 5_000,
): Promise<TrellisPreviewStatus> {
  const atom = trellisEnvironment.status({ environmentId, input: {} });
  const classify = (
    result: AsyncResult.AsyncResult<TrellisStatus, unknown>,
  ): TrellisPreviewStatus | null => {
    if (result.waiting) return null;
    if (AsyncResult.isSuccess(result)) return { kind: "known", status: result.value };
    if (AsyncResult.isFailure(result)) {
      return isUnknownMethod(result.cause) ? { kind: "unsupported" } : { kind: "unknown" };
    }
    return null;
  };
  const cached = classify(registry.get(atom));
  if (cached?.kind === "known") return Promise.resolve(cached);
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const finish = (status: TrellisPreviewStatus) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(status);
    };
    const timer = setTimeout(() => {
      const value = Option.getOrNull(AsyncResult.value(registry.get(atom)));
      finish(value === null ? { kind: "unknown" } : { kind: "known", status: value });
    }, timeoutMs);
    unsubscribe = registry.subscribe(atom, (result) => {
      const status = classify(result);
      if (status !== null) finish(status);
    });
    registry.refresh(atom);
  });
}

/**
 * What a `trellis.resolvePreviewUrl` result means for the preview. Only ever
 * asked once the environment's status says it runs Trellis, so a missing or
 * failing method refuses rather than loading the host's port.
 */
export function previewResolutionOf(
  result: AtomCommandResult<{ readonly url: string }, unknown>,
): TrellisPreviewResolution {
  if (result._tag === "Success") return { kind: "mapped", url: result.value.url };
  if (isAtomCommandInterrupted(result)) return { kind: "interrupted" };
  const error = squashAtomCommandFailure(result);
  return {
    kind: "failed",
    message: isPreviewTrellisError(error)
      ? error.message
      : isUnknownMethod(result.cause)
        ? "This server reports Trellis but cannot map workspace ports. Update T3 Code on it."
        : "Could not ask the server where this workspace port is. Try again.",
  };
}

/** `mapTrellisPreviewUrl` for a thread, through its environment's connection. */
export function mapThreadPreviewUrl(threadRef: ScopedThreadRef, url: string) {
  return mapTrellisPreviewUrl(url, {
    status: () => loadTrellisPreviewStatus(appAtomRegistry, threadRef.environmentId),
    resolve: async (target) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        trellisEnvironment.resolvePreviewUrl,
        {
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, url: target },
        },
        { reportFailure: false },
      );
      return previewResolutionOf(result);
    },
  });
}
