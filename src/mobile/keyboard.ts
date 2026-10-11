/**
 * On-screen keyboard inset for `denext/mobile`: the part of the page the keyboard covers, in CSS
 * px, as a custom property on `<html>` and as a hook value.
 *
 * @module
 */

import { useEffect, useState } from "../runtime/hooks.ts";
import { nativePlatform } from "./bridge.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";

/** The custom property {@linkcode installKeyboardInset} maintains by default. */
const DEFAULT_PROPERTY = "--denext-keyboard-inset";

/** Options for {@linkcode installKeyboardInset} and {@linkcode useKeyboardInset}. */
export interface KeyboardInsetOptions {
  /** The CSS custom property to keep in sync (default `--denext-keyboard-inset`). */
  readonly property?: string;
}

/**
 * Schedule `cb` for the next animation frame (a 16 ms timer where rAF is missing). Internal to
 * `denext/mobile` (the safe-area watcher shares it); not re-exported.
 */
export function requestFrame(cb: () => void): () => void {
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
 * function. Internal to `denext/mobile` (the keyboard views share it); not re-exported.
 */
export function watchInset(onInset: (px: number) => void): () => void {
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

/** The slice of `@capacitor/keyboard`'s JS side the iOS shell's inset listens to. */
interface ShellKeyboard {
  addListener(
    eventName: "keyboardWillShow" | "keyboardWillHide",
    listener: (info?: { keyboardHeight?: number }) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
  getResizeMode?(): Promise<{ mode?: string }>;
}

/** The element `@capacitor/keyboard` resizes in `mode` (`null`: the WebView itself, or none). */
function resizedElement(mode: string): { getBoundingClientRect(): { height: number } } | null {
  const doc = (globalThis as {
    document?: { body?: unknown; querySelector?: (s: string) => unknown };
  }).document;
  const el = mode === "body"
    ? doc?.body
    : mode === "ionic"
    ? doc?.querySelector?.("ion-app")
    : null;
  const rect = (el as { getBoundingClientRect?: unknown } | null | undefined)
    ?.getBoundingClientRect;
  return typeof rect === "function" ? el as { getBoundingClientRect(): { height: number } } : null;
}

/** Watch `el`'s `style` attribute (the shell sets its height inline); returns a stop function. */
function watchStyle(el: unknown, cb: () => void): () => void {
  const MO = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  if (!el || typeof MO !== "function") return () => {};
  const mo = new MO(cb);
  mo.observe(el as Node, { attributes: true, attributeFilter: ["style"] });
  return () => mo.disconnect();
}

/**
 * How long the watch outlives will-hide waiting for the shell to grow the app back, in ms: the
 * plugin does after the keyboard's 250 ms animation plus 200 ms.
 */
const GROW_BACK_MS = 1000;

/** One report of the iOS shell's keyboard (see {@linkcode watchShellKeyboard}). */
export interface ShellKeyboardReport {
  /** px of the page the keyboard covers: its height less how far the shell has resized. */
  readonly px: number;
  /** The keyboard's height (`0` while it is hidden), covering the page or not. */
  readonly height: number;
  /**
   * px the shell has the app resized by: how much shorter the WebView / `<body>` / `ion-app` is
   * than before the keyboard (`0` with `resize: "none"`). After will-hide it falls to 0 as the
   * shell grows the app back.
   */
  readonly resized: number;
  /**
   * Whether a will-show / will-hide caused the report, so the change moves with the keyboard's
   * animation. `false` when the shell's resize did (it lands at once) and for the first report.
   */
  readonly animated: boolean;
}

/**
 * The keyboard in the iOS shell with `@capacitor/keyboard`. The plugin takes the keyboard's
 * notifications away from WebKit, so the visual viewport does not move; it reports the keyboard
 * on will-show / will-hide and, in its `native` / `body` / `ionic` modes, resizes the WebView /
 * `<body>` / `ion-app` only once the keyboard's animation has run (plus 200 ms). The covered px
 * is the will-show height less how far the shell has resized the app since: the whole keyboard
 * while it slides in over the page, `0` once the app has shrunk around it, and the whole
 * keyboard throughout with `resize: "none"`. A bottom-anchored view that adds it as room (a
 * chat: `VirtualList`'s `keyboardInset`) so keeps its last row above the keyboard the whole
 * way, with no jump when the resize lands. The shell grows the app back only after will-hide's
 * animation too, so the watch outlives the keyboard until it has (or {@linkcode GROW_BACK_MS}).
 */
function watchShellReports(
  plugin: ShellKeyboard,
  onReport: (report: ShellKeyboardReport) => void,
): () => void {
  let mode = "native"; // the plugin's default until it says otherwise
  let height = 0;
  let base = 0;
  let unwatch = () => {};
  let linger: ReturnType<typeof setTimeout> | undefined;
  const size = (): number => {
    const el = resizedElement(mode);
    return el ? el.getBoundingClientRect().height : num(globalThis.innerHeight);
  };
  const shrunk = (): number => (mode === "none" ? 0 : Math.max(0, base - size()));
  const report = (animated: boolean) => {
    const by = shrunk();
    const px = Math.max(0, Math.round(height - by));
    onReport({ px, height, resized: Math.round(by), animated });
  };
  const resized = () => {
    report(false);
    if (height === 0 && shrunk() < 0.5) unwatch(); // the shell grew the app back
  };
  const watch = () => {
    unwatch();
    const g = globalThis as { addEventListener?: unknown; removeEventListener?: unknown };
    const stopStyle = watchStyle(resizedElement(mode), resized);
    const listens = typeof g.addEventListener === "function";
    if (listens) globalThis.addEventListener("resize", resized);
    unwatch = () => {
      stopStyle();
      if (listens) globalThis.removeEventListener("resize", resized);
      if (linger !== undefined) clearTimeout(linger);
      linger = undefined;
      unwatch = () => {};
    };
  };
  const offShow = listenerDisposer(plugin.addListener("keyboardWillShow", (info) => {
    if (height === 0) {
      base = size();
      watch();
    }
    height = Math.max(0, Math.round(num(info?.keyboardHeight)));
    report(true);
  }));
  const offHide = listenerDisposer(plugin.addListener("keyboardWillHide", () => {
    height = 0;
    report(true);
    // Until the shell grows the app back (bounded): what it gives back is reported too.
    if (shrunk() < 0.5) unwatch();
    else if (linger === undefined) linger = setTimeout(() => unwatch(), GROW_BACK_MS);
  }));
  let active = true;
  plugin.getResizeMode?.().then((result) => {
    if (!active || typeof result?.mode !== "string") return;
    mode = result.mode;
    if (height === 0) return;
    base = size(); // the shell resizes only after the animation: still the full size
    watch();
  }, () => {});
  onReport({ px: 0, height: 0, resized: 0, animated: false });
  return () => {
    active = false;
    offShow();
    offHide();
    unwatch();
  };
}

/** A finite number, else 0. */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * In the iOS shell with `@capacitor/keyboard`, report the keyboard now and on every change (see
 * {@linkcode ShellKeyboardReport}) and return a stop function; elsewhere report nothing and
 * return `undefined` (the caller falls back to the visual viewport). Internal to
 * `denext/mobile` (the inset and the keyboard views' overlap share it); not re-exported.
 */
export function watchShellKeyboard(
  onReport: (report: ShellKeyboardReport) => void,
): (() => void) | undefined {
  const plugin = nativePlatform() === "ios"
    ? nativePlugin<ShellKeyboard>("Keyboard", ["addListener"])
    : undefined;
  return plugin ? watchShellReports(plugin, onReport) : undefined;
}

/** Where the inset comes from: the iOS shell's keyboard plugin, else the visual viewport. */
function watchKeyboardInset(onInset: (px: number) => void): () => void {
  return watchShellKeyboard(({ px }) => onInset(px)) ?? watchInset(onInset);
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
  const stop = watchKeyboardInset((px) => {
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
 * `--denext-keyboard-inset`) equal to the px of the page the on-screen keyboard covers, so
 * layout can lift a composer or a bottom bar above it: `padding-bottom:
 * var(--denext-keyboard-inset)`.
 *
 * In a browser and on Android it is
 * derived from `window.visualViewport` (`innerHeight - visualViewport.height -
 * visualViewport.offsetTop`, clamped at ≥ 0) and updated at most once per animation frame; it
 * stays `0px` where `visualViewport` is unavailable. In the iOS shell with `@capacitor/keyboard`
 * it follows the plugin's will-show / will-hide: the keyboard's height while it slides in over
 * the page, then `0` once the shell has resized the WebView (`resize: "native"`, the default),
 * `<body>` (`"body"`) or `ion-app` (`"ionic"`) around it, which the plugin does only after the
 * keyboard's animation; with `resize: "none"` it stays the keyboard's height. It is set to `0px`
 * immediately.
 *
 * Pass it as `VirtualList`'s `keyboardInset` and a chat (`anchor="end"`) keeps its last message
 * above the keyboard from the moment the keyboard starts to open, in every resize mode, with no
 * jump when the shell's resize lands.
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
 * disposes it on unmount, and returns the px of the page the keyboard currently covers (`0`
 * during SSR and before mount).
 *
 * @param opts `{ property }`, the custom property to maintain.
 * @returns The px of the page the on-screen keyboard covers.
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
