// The event types React DOM listens to as PASSIVE (React 17+'s `listenToNativeEvent` /
// `addTrappedEventListener`): `touchstart`, `touchmove` and `wheel`. A passive listener lets the
// browser scroll on the compositor without waiting for the main thread (iOS WebKit and Chromium
// both keep a scroll synchronous while any non-passive listener for these covers the touch), and
// `preventDefault()` inside one is a no-op the browser warns about — exactly what React apps
// see. `touchend` / `touchcancel` stay non-passive, as in React (they do not hold a scroll).

/** Whether React DOM would register a listener for `type` as passive. */
export function isPassiveEvent(type: string): boolean {
  return type === "touchstart" || type === "touchmove" || type === "wheel";
}
