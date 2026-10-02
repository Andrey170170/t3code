import { createContext } from "react";

/** Keeps the parent chat's global shortcuts and paste routing out of a side chat. */
export function isSideChatTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-side-chat]") !== null;
}

/** True inside a side chat. Portaled menus keep React context but lose their DOM ancestry. */
export const SideChatFocusContext = createContext(false);
