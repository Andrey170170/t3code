import { createContext, useContext } from "react";

/** Keep the parent chat's global shortcuts out of the secondary conversation. */
export function isSideChatTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-side-chat]") !== null;
}

/** Portals keep React context but lose their DOM ancestry. */
export const SideChatFocusContext = createContext(false);
const sideChatPortalProps = { "data-side-chat": true } as const;
const mainChatPortalProps = {};

export function useSideChatPortalProps() {
  return useContext(SideChatFocusContext) ? sideChatPortalProps : mainChatPortalProps;
}
