import { useContext } from "react";

import { useComposerHandleContext } from "../../composerHandleContext";
import { SideChatFocusContext } from "./sideChatFocus";

const COMPOSER_FLOATING_LAYER_SELECTOR = [
  '[data-composer-drawer-layer="true"]',
  '[data-chat-composer-floating-layer="true"]',
].join(",");

export const composerFloatingLayerProps = {
  "data-chat-composer-floating-layer": "true",
} as const;

const sideChatFloatingLayerProps = {
  ...composerFloatingLayerProps,
  // Portaled menus leave the side chat's DOM subtree; this keeps them inside its scope.
  "data-side-chat": "true",
} as const;

export function useComposerMenuProps() {
  const composerRef = useComposerHandleContext();
  // A side chat owns a separate editor, so closing its menus must not focus the main composer.
  if (useContext(SideChatFocusContext)) {
    return { ...sideChatFloatingLayerProps, finalFocus: undefined };
  }

  return {
    ...composerFloatingLayerProps,
    finalFocus: composerRef
      ? () => {
          const activeElement = document.activeElement;
          if (activeElement !== document.body && !isInsideComposerFloatingLayer(activeElement)) {
            return false;
          }
          composerRef.current?.focusAtEnd();
          return false;
        }
      : undefined,
  };
}

export function isInsideComposerFloatingLayer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COMPOSER_FLOATING_LAYER_SELECTOR) !== null;
}

// Banners, the approval row, and the tasks badge dock above the surface. A
// pointer or focus landing on one of them acts on that control and must not
// expand a resting or collapsed composer.
export function isInsideCollapsedComposerControls(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[data-chat-composer-collapsed-controls="true"]') !== null
  );
}

export function isInsideRestingComposerControlScope(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    (target.closest('[data-chat-composer-resting-controls="true"]') !== null ||
      target.closest('[data-chat-composer-resting-images="true"]') !== null ||
      target.closest("[data-composer-context-control]") !== null ||
      isInsideComposerFloatingLayer(target))
  );
}
