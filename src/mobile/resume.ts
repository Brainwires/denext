/**
 * App-resume detection for `denext/mobile`: learn when the page comes back to the foreground
 * and how long it was away.
 *
 * @module
 */

import { useEffect, useRef } from "../runtime/hooks.ts";

/** A `[type, listener]` pair registered by {@linkcode onAppResume}. */
type Listener = readonly [string, () => void];

/** Add every pair to `target` and return the function that removes them again. */
function listen(target: EventTarget | undefined, pairs: readonly Listener[]): () => void {
  if (!target || typeof target.addEventListener !== "function") return () => {};
  for (const [type, fn] of pairs) target.addEventListener(type, fn);
  return () => {
    for (const [type, fn] of pairs) target.removeEventListener(type, fn);
  };
}

/**
 * Call `cb` each time the page returns to the foreground, with how long it was away in
 * milliseconds.
 *
 * It listens for `visibilitychange` (every browser and webview), `pagehide`/`pageshow`
 * (a back-forward-cache restore) and the `pause`/`resume` document events that Capacitor's
 * iOS shell fires on scene background/foreground. Whichever signal arrives first counts; the
 * others are deduplicated, so `cb` runs once per return. A subscription made while the page is
 * already hidden measures from the moment of subscribing.
 *
 * The time away is wall-clock (`Date.now()`), not `performance.now()`: iOS's monotonic clock
 * stops while the device sleeps, which would under-report a phone left locked for an hour.
 * A backwards clock jump reads as `0`.
 *
 * **The intended pattern** (the rule T3 Code's native app uses): under 10 s away, the
 * connection is probably intact, so probe it (a ping, a cheap refetch); 10 s or more, assume
 * the OS froze the page and its sockets, so reconnect and refetch.
 *
 * SSR-safe: without a `document` it subscribes to nothing and returns a no-op.
 *
 * @param cb Called with `awayMs`, the time since the page was hidden.
 * @returns A function that unsubscribes.
 * @example
 * ```ts
 * import { onAppResume } from "denext/mobile";
 *
 * const stop = onAppResume((awayMs) => {
 *   if (awayMs < 10_000) socket.ping();
 *   else socket.reconnect();
 * });
 * ```
 */
export function onAppResume(cb: (awayMs: number) => void): () => void {
  if (typeof document === "undefined") return () => {};
  const doc = document;
  let hiddenAt: number | null = doc.visibilityState === "hidden" ? Date.now() : null;
  const hide = () => {
    hiddenAt ??= Date.now();
  };
  const show = () => {
    if (hiddenAt === null) return;
    const awayMs = Math.max(0, Date.now() - hiddenAt);
    hiddenAt = null;
    cb(awayMs);
  };
  const onVisibility = () => doc.visibilityState === "hidden" ? hide() : show();
  const offDocument = listen(doc, [
    ["visibilitychange", onVisibility],
    ["pause", hide],
    ["resume", show],
  ]);
  const offWindow = listen(globalThis, [
    ["pagehide", hide],
    ["pageshow", show],
  ]);
  return () => {
    offDocument();
    offWindow();
  };
}

/**
 * Hook form of {@linkcode onAppResume}: subscribes on mount, unsubscribes on unmount. The
 * latest `cb` is always called (it is held in a ref), so passing a fresh closure each render
 * never re-subscribes.
 *
 * @param cb Called with `awayMs` each time the page returns to the foreground. Under 10 s
 * away, probe the connection; 10 s or more, reconnect and refetch.
 * @example
 * ```tsx
 * "use client";
 * import { useAppResume } from "denext/mobile";
 *
 * export function LiveFeed() {
 *   useAppResume((awayMs) => (awayMs < 10_000 ? feed.probe() : feed.reconnect()));
 *   return <Feed />;
 * }
 * ```
 */
export function useAppResume(cb: (awayMs: number) => void): void {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => onAppResume((awayMs) => cbRef.current(awayMs)), []);
}
