import type { DiscoveredLocalServer, ScopedThreadRef } from "@t3tools/contracts";
import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import type { BrowserSettingsReadError, OpenPreviewMutation } from "~/browser/openFileInPreview";
import { recordVisitForThread } from "~/browserHistoryStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { mapThreadPreviewUrl, type TrellisPreviewMappingError } from "~/state/trellisPreview";
import { openPreviewSession } from "./openPreviewSession";

export async function openDiscoveredPort<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly port: DiscoveredLocalServer;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<AtomCommandResult<void, E | BrowserSettingsReadError | TrellisPreviewMappingError>> {
  // `localhost` in a Trellis thread is its workspace: map it before the
  // remote-environment host rewrite, which only applies to unmapped URLs.
  const mapped = await mapThreadPreviewUrl(input.threadRef, input.port.url);
  if (!("url" in mapped)) {
    return AsyncResult.failure(
      mapped.error === null ? Cause.interrupt() : Cause.fail(mapped.error),
    );
  }
  const resolvedUrl =
    mapped.url === input.port.url
      ? resolveDiscoveredServerUrl(input.threadRef.environmentId, input.port.url)
      : mapped.url;
  const result = await openPreviewSession({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    url: resolvedUrl,
  });
  return mapAtomCommandResult(result, (snapshot) => {
    recordVisitForThread(input.threadRef, input.port.url);
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}
