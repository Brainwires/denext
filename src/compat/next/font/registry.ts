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

/** Per-font metadata carried alongside a registered Google stylesheet URL. */
export interface FontMeta {
  /** Character subsets to self-host (drops other subsets' files). */
  subsets?: string[];
  /** Preload the font files (emit `<link rel=preload>`). */
  preload?: boolean;
}

const fontFaces = new Set<string>();
const stylesheets = new Map<string, FontMeta>();

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

/** Register a stylesheet URL to link (deduplicated), with optional per-font metadata. */
export function addStylesheet(href: string, meta: FontMeta = {}): void {
  // Merge so a second registration can't drop an earlier `preload`/`subsets`.
  const prev = stylesheets.get(href);
  stylesheets.set(href, {
    subsets: meta.subsets ?? prev?.subsets,
    preload: meta.preload || prev?.preload,
  });
}

/** Clear the registry (used between renders / in tests). */
export function resetFonts(): void {
  fontFaces.clear();
  stylesheets.clear();
}

/** Extract the local font-file URLs from a self-hosted `@font-face` CSS block. */
function fontFileUrls(css: string): string[] {
  const urls: string[] = [];
  for (const m of css.matchAll(/url\((\/[^)"']+)\)/g)) urls.push(m[1]);
  return urls;
}

/**
 * Render the collected font CSS as head markup: `<link rel=preload>` for any self-hosted
 * font a loader marked `preload`, then a `<style>` with all `@font-face` blocks, then
 * `<link rel=stylesheet>` for any font that couldn't be self-hosted (dev, or a fetch
 * failure).
 *
 * @returns The head HTML (empty string when no fonts were used).
 */
export function renderFontStyles(): string {
  const faces = [...fontFaces];
  const localCss: string[] = [];
  let preloads = "";
  let links = "";
  for (const [href, meta] of stylesheets) {
    const local = selfHostedFonts[href];
    if (local) {
      localCss.push(local);
      // Preload the self-hosted files so the font isn't a render-blocking waterfall.
      if (meta.preload) {
        for (const url of fontFileUrls(local)) {
          preloads += `<link rel="preload" href="${url}" as="font" type="font/woff2" crossorigin>`;
        }
      }
    } else {
      links += `<link rel="stylesheet" href="${href}">`;
    }
  }
  let style = "";
  if (faces.length > 0 || localCss.length > 0) {
    style = `<style data-denext-fonts>${faces.join("")}${localCss.join("")}</style>`;
  }
  return preloads + style + links;
}

/** All registered `@font-face` blocks (for the build's CSS pipeline). */
export function collectedFontFaces(): string[] {
  return [...fontFaces];
}

/** All registered Google stylesheet URLs (for the build's self-host discovery). */
export function collectedStylesheets(): string[] {
  return [...stylesheets.keys()];
}

/** All registered Google stylesheets with their metadata (for subset-aware self-hosting). */
export function collectedFontEntries(): Array<[string, FontMeta]> {
  return [...stylesheets];
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
