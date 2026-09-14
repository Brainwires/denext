/**
 * On-screen keyboard inset for `denext/mobile`: the keyboard's height, in CSS px, as a custom
 * property on `<html>` and as a hook value.
 *
 * @module
 */

import { useEffect, useState } from "../runtime/hooks.ts";

/** The custom property {@linkcode installKeyboardInset} maintains by default. */
const DEFAULT_PROPERTY = "--denext-keyboard-inset";

/** Options for {@linkcode installKeyboardInset} and {@linkcode useKeyboardInset}. */
export interface KeyboardInsetOptions {
  /** The CSS custom property to keep in sync (default `--denext-keyboard-inset`). */
  readonly property?: string;
}

/** Schedule `cb` for the next animation frame (a 16 ms timer where rAF is missing). */
function requestFrame(cb: () => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(cb, 16);
  return () => clearTimeout(id);
}

/**
 * The keyboard's height: whatever the visual viewport lost at the bottom of the layout
 * viewport, `innerHeight - visualViewport.height - visualViewport.offsetTop`, rounded to
 * whole px and clamped at 0 (pinch-zoom can make it negative).
 */
function measureInset(vv: VisualViewport): number {
  return Math.max(0, Math.round(globalThis.innerHeight - vv.height - vv.offsetTop));
}

/**
 * Report the keyboard inset to `onInset` now and on every visual-viewport change, at most once
 * per animation frame. Where `visualViewport` is missing it reports `0` once. Returns a stop
 * function.
 */
function watchInset(onInset: (px: number) => void): () => void {
  const vv = globalThis.visualViewport ?? null;
  if (!vv) {
    onInset(0);
    return () => {};
  }
  let cancel: (() => void) | null = null;
  const measure = () => {
    cancel = null;
    onInset(measureInset(vv));
  };
  const schedule = () => {
    cancel ??= requestFrame(measure);
  };
  vv.addEventListener("resize", schedule);
  vv.addEventListener("scroll", schedule);
  measure();
  return () => {
    vv.removeEventListener("resize", schedule);
    vv.removeEventListener("scroll", schedule);
    cancel?.();
    cancel = null;
  };
}

/** How many live installs own each custom property (created on first install). */
let owners: Map<string, number> | undefined;

/** Take a share of `property`; the returned release reports whether it was the last one. */
function claim(property: string): () => boolean {
  const counts = owners ??= new Map();
  counts.set(property, (counts.get(property) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return false;
    released = true;
    const left = (counts.get(property) ?? 1) - 1;
    if (left > 0) counts.set(property, left);
    else counts.delete(property);
    return left <= 0;
  };
}

/** Install the property writer; `onInset` additionally receives each value. */
function install(property: string, onInset?: (px: number) => void): () => void {
  if (typeof document === "undefined") return () => {};
  const style = document.documentElement.style;
  const release = claim(property);
  const stop = watchInset((px) => {
    style.setProperty(property, `${px}px`);
    onInset?.(px);
  });
  return () => {
    stop();
    if (release()) style.removeProperty(property);
  };
}

/**
 * Keep a CSS custom property on `document.documentElement` (default
 * `--denext-keyboard-inset`) equal to the on-screen keyboard's height in px, so layout can
 * lift a composer or a bottom bar above it: `padding-bottom: var(--denext-keyboard-inset)`.
 *
 * The value is derived from `window.visualViewport` (`innerHeight - visualViewport.height -
 * visualViewport.offsetTop`, clamped at ≥ 0) and updated at most once per animation frame.
 * It is set to `0px` immediately, and stays `0px` where `visualViewport` is unavailable.
 *
 * This is for shells whose Capacitor Keyboard plugin is configured with `resize: "none"`,
 * where the webview keeps its size and the keyboard covers the page. With `resize: "native"`
 * the webview itself shrinks, so the inset is always 0 and this is unnecessary.
 *
 * Several installs of the same property may coexist (e.g. two {@linkcode useKeyboardInset}
 * components); the property is removed when the last one is disposed. SSR-safe: without a
 * `document` it installs nothing.
 *
 * @param opts `{ property }`, the custom property to maintain.
 * @returns A dispose function that stops listening and, for the last install, removes the
 * property.
 * @example
 * ```ts
 * import { installKeyboardInset } from "denext/mobile";
 * const dispose = installKeyboardInset();
 * // CSS: .composer { bottom: var(--denext-keyboard-inset, 0px); }
 * ```
 */
export function installKeyboardInset(opts: KeyboardInsetOptions = {}): () => void {
  return install(opts.property ?? DEFAULT_PROPERTY);
}

/**
 * Hook form of {@linkcode installKeyboardInset}: installs the custom property on mount,
 * disposes it on unmount, and returns the current keyboard height in px (`0` during SSR and
 * before mount).
 *
 * @param opts `{ property }`, the custom property to maintain.
 * @returns The on-screen keyboard's height in CSS px.
 * @example
 * ```tsx
 * "use client";
 * import { useKeyboardInset } from "denext/mobile";
 *
 * export function Composer() {
 *   const inset = useKeyboardInset();
 *   return <form style={{ paddingBottom: inset }}><textarea /></form>;
 * }
 * ```
 */
export function useKeyboardInset(opts: KeyboardInsetOptions = {}): number {
  const [inset, setInset] = useState(0);
  const property = opts.property ?? DEFAULT_PROPERTY;
  useEffect(() => install(property, setInset), [property]);
  return inset;
}
