/**
 * `expo-system-ui` for denext: the root view's background colour is the page's. Setting it
 * paints `<html>` and `<body>`, which is what shows behind the app in the Capacitor shell
 * (rubber-band overscroll, the keyboard's gap, a transparent screen) and in a browser.
 *
 * @example
 * ```ts
 * import * as SystemUI from "denext/expo/system-ui";
 *
 * await SystemUI.setBackgroundColorAsync("#101010");
 * const color = await SystemUI.getBackgroundColorAsync(); // "#101010"
 * ```
 *
 * @module
 */

/** A colour: a CSS colour string, or a `processColor` number (`0xAARRGGBB`). */
export type ColorValue = string | number;

/** The colour the app last set, as it reads back (null: never set, or cleared). */
let current: ColorValue | null = null;

/** Two hex digits for a channel. */
function hex2(n: number): string {
  return n.toString(16).padStart(2, "0").toUpperCase();
}

/**
 * `color` as Expo reports it: `#RRGGBB` (or `#RRGGBBAA` when translucent) for a hex string or a
 * `processColor` number, any other CSS colour as given.
 */
function normalize(color: ColorValue): ColorValue {
  if (typeof color === "number") {
    const n = color >>> 0;
    const alpha = (n >>> 24) & 0xff;
    const rgb = hex2((n >>> 16) & 0xff) + hex2((n >>> 8) & 0xff) + hex2(n & 0xff);
    return `#${rgb}${alpha === 0xff ? "" : hex2(alpha)}`;
  }
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (!m) return color;
  const digits = m[1].length <= 4 ? [...m[1]].map((d) => d + d).join("") : m[1];
  const upper = digits.toUpperCase();
  return upper.length === 8 && upper.endsWith("FF") ? `#${upper.slice(0, 6)}` : `#${upper}`;
}

/** `color` as a CSS colour. */
function cssColor(color: ColorValue): string {
  const value = normalize(color);
  return typeof value === "string" ? value : String(value);
}

/**
 * Set the root view's background colour: the page's (`<html>` and `<body>`). `null` clears
 * it, back to the stylesheet's colour.
 *
 * @param color A CSS colour, a `processColor` number, or null.
 */
export function setBackgroundColorAsync(color: ColorValue | null): Promise<void> {
  current = color === null ? null : normalize(color);
  const doc = (globalThis as { document?: Document }).document;
  if (doc) {
    const css = color === null ? "" : cssColor(color);
    for (const el of [doc.documentElement, doc.body]) {
      if (el?.style) el.style.backgroundColor = css;
    }
  }
  return Promise.resolve();
}

/**
 * The root view's background colour: the one last set (`#RRGGBB` for a hex colour or a
 * number), or null when none was.
 *
 * @returns The colour, or null.
 */
export function getBackgroundColorAsync(): Promise<ColorValue | null> {
  return Promise.resolve(current);
}
