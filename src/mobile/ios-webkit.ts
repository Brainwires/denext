/**
 * iOS/iPadOS WebKit detection, kept in its own tiny module so the client runtime can test the
 * platform without loading the momentum-scroll shim.
 *
 * @module
 */

/**
 * Whether the page runs in iOS or iPadOS WebKit (Safari, WKWebView, Capacitor): an
 * iPhone/iPad/iPod user agent, or iPadOS's desktop-class `MacIntel` user agent on a touch
 * screen. `false` without a `navigator` (SSR).
 */
export function isIosWebKit(): boolean {
  const nav = (globalThis as { navigator?: Partial<Navigator> }).navigator;
  if (!nav) return false;
  if (/iPad|iPhone|iPod/.test(String(nav.userAgent ?? ""))) return true;
  return nav.platform === "MacIntel" && Number(nav.maxTouchPoints) > 1;
}
