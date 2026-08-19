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

// Build self-hosting: a map from a Google stylesheet URL → the locally-rewritten
// `@font-face` CSS (its `src` pointing at emitted local files). When set (the prod
// server loads it from the build's font-manifest.json), `renderFontStyles` emits
// that CSS inline instead of a `<link>` to Google — the browser never hits Google.
let selfHostedFonts: Record<string, string> = {};

/** Install the build's self-hosted-font map (Google URL → local `@font-face` CSS). */
export function setSelfHostedFonts(map: Record<string, string>): void {
  selfHostedFonts = map ?? {};
}

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
  const faces = [...fontFaces];
  // Self-hosted stylesheets become inline @font-face CSS (local `src`); the rest
  // stay as a <link> to Google (dev, or a font the build couldn't self-host).
  const localCss: string[] = [];
  let links = "";
  for (const href of stylesheetLinks) {
    const local = selfHostedFonts[href];
    if (local) localCss.push(local);
    else links += `<link rel="stylesheet" href="${href}">`;
  }
  let out = "";
  if (faces.length > 0 || localCss.length > 0) {
    out += `<style data-denext-fonts>${faces.join("")}${localCss.join("")}</style>`;
  }
  return out + links;
}

/** All registered `@font-face` blocks (for the build's CSS pipeline). */
export function collectedFontFaces(): string[] {
  return [...fontFaces];
}

/** All registered Google stylesheet URLs (for the build's self-host discovery). */
export function collectedStylesheets(): string[] {
  return [...stylesheetLinks];
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
