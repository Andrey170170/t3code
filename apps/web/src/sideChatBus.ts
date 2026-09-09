import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

const SIDE_CHAT_OPEN_EVENT = "t3code:open-side-chat";

export interface SideChatOpenDetail {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** Ask the active chat to open its native side conversation in the right panel. */
export function openSideChat(detail: SideChatOpenDetail): void {
  window.dispatchEvent(new CustomEvent(SIDE_CHAT_OPEN_EVENT, { detail }));
}

export function onOpenSideChat(listener: (detail: SideChatOpenDetail) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<SideChatOpenDetail>).detail);
  window.addEventListener(SIDE_CHAT_OPEN_EVENT, handler);
  return () => window.removeEventListener(SIDE_CHAT_OPEN_EVENT, handler);
}
