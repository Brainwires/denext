/**
 * Shared plumbing for the `next/font` compat: a per-render registry of the CSS a
 * font loader emits (`@font-face` blocks and Google stylesheet links), plus
 * stable class-name generation. The build/SSR layer calls {@link renderFontStyles}
 * to inject the collected CSS into `<head>`.
 *
 * @module
 */

/** The object a `next/font` loader returns (spreadable onto an element). */
export interface FontResult {
  /** A generated, stable class name applying this font. */
  className: string;
  /** Inline style applying the font family (and weight/style when fixed). */
  style: { fontFamily: string; fontWeight?: string | number; fontStyle?: string };
  /** The CSS custom-property name when `variable` was requested (else `""`). */
  variable: string;
}

const fontFaces = new Set<string>();
const stylesheetLinks = new Set<string>();

/** Register a raw `@font-face` block (deduplicated). */
export function addFontFace(css: string): void {
  fontFaces.add(css.trim());
}

/** Register a stylesheet URL to link (deduplicated). */
export function addStylesheet(href: string): void {
  stylesheetLinks.add(href);
}

/** Clear the registry (used between renders / in tests). */
export function resetFonts(): void {
  fontFaces.clear();
  stylesheetLinks.clear();
}

/**
 * Render the collected font CSS as head markup: a `<style>` with all
 * `@font-face` blocks, followed by `<link>` tags for any stylesheet URLs.
 *
 * @returns The head HTML (empty string when no fonts were used).
 */
export function renderFontStyles(): string {
  let out = "";
  if (fontFaces.size > 0) {
    out += `<style data-denext-fonts>${[...fontFaces].join("")}</style>`;
  }
  for (const href of stylesheetLinks) {
    out += `<link rel="stylesheet" href="${href}">`;
  }
  return out;
}

/** All registered `@font-face` blocks (for the build's CSS pipeline). */
export function collectedFontFaces(): string[] {
  return [...fontFaces];
}

/** A small deterministic hash (djb2) → base36, for stable class names. */
export function hashKey(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Build a stable class name for a font from its family + option signature. */
export function fontClassName(family: string, signature: string): string {
  const safe = family.replace(/[^A-Za-z0-9]/g, "_");
  return `__font_${safe}_${hashKey(signature)}`;
}
