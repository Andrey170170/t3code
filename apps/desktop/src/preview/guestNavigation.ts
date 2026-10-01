import { isLoopbackHostname } from "@t3tools/shared/preview";

/**
 * Whether a navigation the guest page started itself (a link, `location`,
 * `window.open`) must go through the renderer's preview mapping before it
 * loads. `localhost` in a Trellis thread is its workspace, which only the
 * thread's environment can resolve, so a loopback target on another origin
 * than the page's own is held back. Same-origin navigations stay on the
 * address the page was already mapped to.
 */
export function guestNavigationNeedsMapping(currentUrl: string, targetUrl: string): boolean {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return false;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  if (!isLoopbackHostname(target.hostname)) return false;
  try {
    return new URL(currentUrl).origin !== target.origin;
  } catch {
    return true;
  }
}
