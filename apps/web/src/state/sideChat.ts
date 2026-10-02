import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { createSideChatEnvironmentAtoms } from "@t3tools/client-runtime/state/side-chat";
import type { EnvironmentId, SideChatTargetInput } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { AsyncResult } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const sideChatEnvironment = createSideChatEnvironmentAtoms(connectionAtomRuntime);

/** Side chats whose close failed in transit, retried when their environment reconnects. */
const pendingClosesByEnvironment = new Map<EnvironmentId, Map<string, SideChatTargetInput>>();

function isEnvironmentConnected(environmentId: EnvironmentId): boolean {
  return Option.exists(
    AsyncResult.value(appAtomRegistry.get(environmentCatalog.stateAtom(environmentId))),
    (state) => state.phase === "connected",
  );
}

function closeOnReconnect(environmentId: EnvironmentId, input: SideChatTargetInput) {
  const existing = pendingClosesByEnvironment.get(environmentId);
  if (existing) {
    existing.set(input.sideChatId, input);
    return;
  }
  const pending = new Map([[input.sideChatId, input]]);
  pendingClosesByEnvironment.set(environmentId, pending);
  let wasConnected = isEnvironmentConnected(environmentId);
  const stop = appAtomRegistry.subscribe(environmentCatalog.stateAtom(environmentId), () => {
    const connected = isEnvironmentConnected(environmentId);
    const reconnected = connected && !wasConnected;
    wasConnected = connected;
    if (!reconnected) return;
    stop();
    pendingClosesByEnvironment.delete(environmentId);
    for (const target of pending.values()) closeSideChat(environmentId, target);
  });
}

/**
 * Ends a side chat. A close that fails in transit is retried once the environment
 * reconnects; closing is idempotent on the server, so a duplicate is harmless.
 */
export function closeSideChat(
  environmentId: EnvironmentId,
  input: SideChatTargetInput,
  retryWhileConnected = true,
): void {
  void runAtomCommand(
    appAtomRegistry,
    sideChatEnvironment.close,
    { environmentId, input },
    { reportFailure: false },
  ).then((result) => {
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    // The server answered; retrying cannot change its mind.
    if (
      Predicate.isTagged(error, "SideChatError") ||
      Predicate.isTagged(error, "EnvironmentAuthorizationError")
    ) {
      return;
    }
    if (!isEnvironmentConnected(environmentId)) {
      closeOnReconnect(environmentId, input);
    } else if (retryWhileConnected) {
      // The connection may have come back before this failure settled; retry once.
      closeSideChat(environmentId, input, false);
    }
  });
}
