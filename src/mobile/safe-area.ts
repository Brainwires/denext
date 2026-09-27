/**
 * Safe-area insets for `denext/mobile`: CSS custom properties ({@linkcode SAFE_AREA_CSS}) and a
 * live hook ({@linkcode useSafeAreaInsets}).
 *
 * Both prefer the `--safe-area-inset-*` custom properties Capacitor 8's `SystemBars` plugin
 * injects on Android (its default `insetsHandling: "css"`), because Android WebView before 140
 * reports wrong `env(safe-area-inset-*)` values; everywhere else (iOS, the web) those are unset
 * and `env()` applies.
 *
 * @module
 */

import { useEffect, useState } from "../runtime/hooks.ts";
import { requestFrame } from "./keyboard.ts";

/** The four sides, in CSS order. */
const SIDES = ["top", "right", "bottom", "left"] as const;

/** The inset for `side`: Capacitor's injected value, else `env()`, else `0px`. */
function insetExpression(side: (typeof SIDES)[number]): string {
  return `var(--safe-area-inset-${side}, env(safe-area-inset-${side}, 0px))`;
}

/**
 * A stylesheet fragment that defines `--denext-safe-top`, `--denext-safe-right`,
 * `--denext-safe-bottom` and `--denext-safe-left` on `:root` as the device's safe-area insets
 * (the notch, status bar, navigation bar and home indicator), `0px` where there are none. Drop
 * it into a stylesheet or a `<style>` tag, then pad with the variables.
 *
 * Each is `var(--safe-area-inset-*, env(safe-area-inset-*, 0px))`: the value Capacitor 8's
 * `SystemBars` plugin injects on Android when set (Android WebView before 140 reports wrong
 * `env()` insets), else the browser's `env()` value. For the numbers in JavaScript, use
 * {@linkcode useSafeAreaInsets}.
 *
 * The insets are only non-zero when the viewport meta includes `viewport-fit=cover`. In the
 * App Router, export `viewport = { width: "device-width", initialScale: 1, viewportFit:
 * "cover" }` from the root layout. In SPA mode, put the meta tag in `spa.head`; denext's SPA
 * shell keeps an app's own viewport meta instead of emitting its default.
 *
 * @example
 * ```tsx
 * import { SAFE_AREA_CSS } from "denext/mobile";
 *
 * export default function RootLayout({ children }: { children: unknown }) {
 *   return (
 *     <html>
 *       <head><style>{SAFE_AREA_CSS}</style></head>
 *       <body style={{ paddingTop: "var(--denext-safe-top)" }}>{children}</body>
 *     </html>
 *   );
 * }
 * ```
 */
export const SAFE_AREA_CSS: string = `:root {
  --denext-safe-top: var(--safe-area-inset-top, env(safe-area-inset-top, 0px));
  --denext-safe-right: var(--safe-area-inset-right, env(safe-area-inset-right, 0px));
  --denext-safe-bottom: var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px));
  --denext-safe-left: var(--safe-area-inset-left, env(safe-area-inset-left, 0px));
}
`;

/** The device's safe-area insets in CSS px, as {@linkcode useSafeAreaInsets} reports them. */
export interface SafeAreaInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** No insets: before mount, during SSR, and where the device has none. */
const NO_INSETS: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/** The slice of a DOM element the probe needs. */
interface ProbeElement {
  style: { cssText: string };
  setAttribute(name: string, value: string): void;
  remove(): void;
}

/** An invisible fixed element whose padding is the four insets, appended to `<html>`. */
function createProbe(doc: Document): ProbeElement {
  const el = doc.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("data-denext-safe-area-probe", "");
  el.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;" +
    "pointer-events:none;" + SIDES.map((s) => `padding-${s}:${insetExpression(s)}`).join(";");
  doc.documentElement.appendChild(el);
  return el;
}

/** A computed `padding-*` length as whole-ish px (0 when unparseable). */
function px(value: string | undefined): number {
  const n = Number.parseFloat(value ?? "");
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100) / 100) : 0;
}

/** The probe's computed padding, as insets. */
function readInsets(el: ProbeElement): SafeAreaInsets {
  const cs = getComputedStyle(el as unknown as Element);
  return {
    top: px(cs.paddingTop),
    right: px(cs.paddingRight),
    bottom: px(cs.paddingBottom),
    left: px(cs.paddingLeft),
  };
}

/** Whether two inset sets are the same. */
function sameInsets(a: SafeAreaInsets, b: SafeAreaInsets): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

/**
 * Add `type` listeners for `fn` on `target` (when it is one); returns the remover. Internal to
 * `denext/mobile` (React Native mode's `AppState` uses it too); not re-exported.
 */
export function listenAll(target: unknown, types: readonly string[], fn: () => void): () => void {
  const t = target as Partial<EventTarget> | null | undefined;
  if (typeof t?.addEventListener !== "function") return () => {};
  for (const type of types) t.addEventListener(type, fn);
  return () => {
    for (const type of types) t.removeEventListener?.(type, fn);
  };
}

/**
 * Report the insets now and whenever they may have changed (resize, rotation, the visual
 * viewport, and Capacitor rewriting its injected properties on `<html>`), at most once per
 * animation frame and only when they differ. Returns a stop function.
 */
function watchSafeAreaInsets(onInsets: (insets: SafeAreaInsets) => void): () => void {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return () => {};
  const el = createProbe(document);
  let last = NO_INSETS;
  let cancel: (() => void) | null = null;
  const measure = () => {
    cancel = null;
    const next = readInsets(el);
    if (sameInsets(next, last)) return;
    last = next;
    onInsets(next);
  };
  const schedule = () => {
    cancel ??= requestFrame(measure);
  };
  const offWindow = listenAll(globalThis, ["resize", "orientationchange"], schedule);
  const offViewport = listenAll(globalThis.visualViewport, ["resize"], schedule);
  const observer = typeof MutationObserver === "function" ? new MutationObserver(schedule) : null;
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  measure();
  return () => {
    offWindow();
    offViewport();
    observer?.disconnect();
    cancel?.();
    el.remove();
  };
}

/**
 * The device's safe-area insets in CSS px (`{ top, right, bottom, left }`), kept up to date on
 * rotation, window and visual-viewport resizes, and when Capacitor updates the insets it
 * injects (on Android the bottom inset drops to 0 while the keyboard is up). The values are the
 * same expressions {@linkcode SAFE_AREA_CSS} uses, measured through a hidden fixed element,
 * so they need `viewport-fit=cover` too. All zero during SSR and before mount.
 *
 * Use {@linkcode SAFE_AREA_CSS} for layout (CSS applies the insets without a render); use this
 * when JavaScript needs the numbers: positioning a canvas, a sheet's resting height, a
 * gesture's edge zone.
 *
 * @returns The current insets.
 * @example
 * ```tsx
 * "use client";
 * import { useSafeAreaInsets } from "denext/mobile";
 *
 * export function BottomSheet({ children }: { children: unknown }) {
 *   const { bottom } = useSafeAreaInsets();
 *   return <div style={{ paddingBottom: bottom + 16 }}>{children}</div>;
 * }
 * ```
 */
export function useSafeAreaInsets(): SafeAreaInsets {
  const [insets, setInsets] = useState<SafeAreaInsets>(NO_INSETS);
  useEffect(() => watchSafeAreaInsets(setInsets), []);
  return insets;
}
