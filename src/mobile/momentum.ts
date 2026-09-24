/**
 * Momentum-safe programmatic scrolling for `denext/mobile`: the public install function and
 * hook over the engine in momentum-scroll.ts, gated to iOS/iPadOS WebKit.
 *
 * @module
 */

import { useEffect } from "../runtime/hooks.ts";
import { isIosWebKit } from "./ios-webkit.ts";
import {
  type MomentumSafeScrollOptions,
  retainMomentumSafeScroll,
  startMomentumSafeScroll,
} from "./momentum-scroll.ts";

export type { MomentumSafeScrollOptions };

/** Whether the shim applies: iOS/iPadOS WebKit, or `force`. */
function applies(force: boolean | undefined): boolean {
  return force === true || isIosWebKit();
}

/**
 * Keep iOS momentum scrolling alive while scroll-anchoring code corrects the scroll offset.
 *
 * In iOS WebKit (Safari, WKWebView, Capacitor) any programmatic scroll write during a touch
 * fling cancels the momentum instantly. Virtualized lists (LegendList, react-virtuoso,
 * TanStack Virtual) issue such writes while the user scrolls, to compensate for rows measured
 * taller or shorter than estimated, so a flick toward older content stops hard.
 *
 * While a finger is down, and while a scroller is still flinging after it lifts,
 * `Element.prototype.scrollBy` / `scrollTo` / `scroll` and the `scrollTop` / `scrollLeft`
 * setters record the write as a pending delta instead of scrolling. The scroller's element
 * children get a CSS `translate` of minus that delta, so the picture is what the write would
 * have shown, and the getters return the real offset plus the delta, so a library reading back
 * the offset sees what it wrote. When the fling settles (`scrollend`, or `settleMs` without a
 * `scroll` event) or a new touch starts, the translate is removed and the real offset moves by
 * the delta in one synchronous step. Deferred targets are clamped to the scroll range, so
 * `el.scrollTop = el.scrollHeight` shows the bottom rather than blank space (`scrollHeight` /
 * `scrollWidth` read as if the children were not shifted). Outside a gesture every call goes
 * straight through; so do `behavior: "smooth"` calls (a smooth `scrollBy` applies the pending
 * delta first; a smooth `scrollTo` drops it, as its target is absolute) and `scrollIntoView`
 * (which first drops the pending delta of every scroller it moves).
 *
 * Only element scrollers are deferred. The document scroller (`document.scrollingElement`,
 * `<html>`, `<body>`) is never shifted, and its writes, including `window.scrollTo`, always go
 * straight through. While a list is shifted, its children carry the `translate` composed with
 * their own computed `translate` (so Tailwind's `translate-*` classes keep their offset), and a
 * transformed child becomes the containing block of its `position: fixed` descendants and moves
 * its `position: sticky` headers with it until the fling settles. Documents inside iframes are
 * not covered: each has its own `Element.prototype`.
 *
 * **denext's client runtime already installs it on iOS WebKit** (opt out with
 * `momentumSafeScroll: false` in `denext.config.ts`), so call this only from a page that does
 * not run on denext's runtime. By default it installs only on iOS/iPadOS WebKit, where the bug
 * exists; elsewhere, and without a DOM, it is a no-op. It is idempotent: while installed,
 * another call (whatever its options) returns the same uninstaller. Uninstalling applies any
 * pending delta and restores every patched `Element.prototype` member exactly.
 *
 * @param options `{ force, settleMs }`: install on every platform; the quiet period, in ms,
 * that ends a fling where `scrollend` is unsupported (default 250; where `scrollend` is
 * supported it ends the fling, with a 1 s idle fallback).
 * @returns The uninstaller.
 * @example
 * ```ts
 * import { installMomentumSafeScroll } from "denext/mobile";
 * installMomentumSafeScroll(); // once, at client startup
 * ```
 */
export function installMomentumSafeScroll(options: MomentumSafeScrollOptions = {}): () => void {
  return applies(options.force) ? startMomentumSafeScroll(options) : () => {};
}

/**
 * Hook form of {@linkcode installMomentumSafeScroll}: installs on mount and uninstalls when the
 * last mounted hook unmounts. An install made by denext's runtime or directly with
 * {@linkcode installMomentumSafeScroll} is left in place. A change to `force` or `settleMs` re-runs
 * the hook (it releases its share, then takes a new one); `settleMs` applies only when that
 * share is the one that installs the shim, since a live install keeps its own options.
 *
 * @param options `{ force, settleMs }`, as for {@linkcode installMomentumSafeScroll}.
 * @example
 * ```tsx
 * "use client";
 * import { useMomentumSafeScroll } from "denext/mobile";
 *
 * export function Thread({ children }: { children: unknown }) {
 *   useMomentumSafeScroll();
 *   return <div style={{ overflowY: "auto" }}>{children}</div>;
 * }
 * ```
 */
export function useMomentumSafeScroll(options: MomentumSafeScrollOptions = {}): void {
  const { force, settleMs } = options;
  useEffect(
    () => applies(force) ? retainMomentumSafeScroll({ settleMs }) : undefined,
    [force, settleMs],
  );
}
