/**
 * React Native styles for the list adapters: a style resolves through the app's own
 * react-native-web `StyleSheet` (a class for `StyleSheet.create` entries, an inline style for
 * the rest), so a list's `style` / `contentContainerStyle` behave exactly as on a `View`.
 * Internal to the adapters.
 *
 * @module
 */

import type { RNStyleSheet } from "./types.ts";

/** A React Native style resolved for a DOM element. */
export interface ResolvedStyle {
  /** The class names (react-native-web's compiled styles). */
  readonly class?: string;
  /** The inline style (DOM property names). */
  readonly style?: Record<string, string | number>;
}

/** Merge a style (object or nested array; registered numbers and falsy values skipped). */
function flatten(style: unknown, out: Record<string, string | number>): void {
  if (Array.isArray(style)) {
    for (const s of style) flatten(s, out);
  } else if (style && typeof style === "object") {
    Object.assign(out, style);
  }
}

/**
 * Resolve `style` with react-native-web's callable `StyleSheet(styles)` (→ `[className,
 * inline]`), or, without one (tests), by flattening it as an inline style.
 *
 * @param sheet react-native-web's `StyleSheet`, when available.
 * @param style The React Native style.
 */
export function resolveStyle(sheet: RNStyleSheet | undefined, style: unknown): ResolvedStyle {
  if (style === null || style === undefined || style === false) return {};
  if (typeof sheet === "function") {
    const out = sheet([style]);
    if (Array.isArray(out)) {
      const [cls, inline] = out as [unknown, unknown];
      return {
        class: typeof cls === "string" && cls !== "" ? cls : undefined,
        style: inline && typeof inline === "object"
          ? inline as Record<string, string | number>
          : undefined,
      };
    }
  }
  const inline: Record<string, string | number> = {};
  flatten(style, inline);
  return { style: inline };
}

/** The class that hides a list's scrollbar (see {@linkcode ensureHiddenScrollbarRule}). */
export const HIDE_SCROLLBAR_CLASS = "denext-rn-hide-scrollbar";

/**
 * Add the rule behind {@linkcode HIDE_SCROLLBAR_CLASS} for WebKit / Blink scrollbars (the
 * inline `scrollbar-width: none` covers the rest) to the document, once.
 */
export function ensureHiddenScrollbarRule(): void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc?.head || typeof doc.createElement !== "function") return;
  const id = "denext-rn-lists-style";
  if (doc.getElementById?.(id)) return;
  const el = doc.createElement("style");
  el.id = id;
  el.textContent = `.${HIDE_SCROLLBAR_CLASS}::-webkit-scrollbar{display:none}`;
  doc.head.appendChild(el);
}
