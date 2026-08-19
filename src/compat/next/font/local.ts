/**
 * `next/font/local` compat. Register a self-hosted local font: emit `@font-face`
 * for each source and a class that applies it, returning the
 * `{ className, style, variable }` object Next code expects. The referenced font
 * files are served statically by the app (denext's build copies `public/` and
 * asset paths through), so this is fully synchronous — no network, no npm.
 *
 * ```ts
 * import localFont from "next/font/local";
 * const myFont = localFont({ src: "./fonts/Inter.woff2", variable: "--font-inter" });
 * // <body className={myFont.className}>
 * ```
 *
 * @module
 */

import { addFontFace, fontClassName, type FontResult } from "./registry.ts";

export type { FontResult } from "./registry.ts";

/** One local font source file, with optional weight/style. */
export interface LocalFontSource {
  /** URL/path the font is served at (e.g. `/fonts/Inter.woff2`). */
  path: string;
  /** The weight this file provides. */
  weight?: string;
  /** The style this file provides (`normal`/`italic`). */
  style?: string;
}

/** Options for {@link localFont} (a subset of Next's). */
export interface LocalFontOptions {
  /** A single path, one source, or several sources. */
  src: string | LocalFontSource | LocalFontSource[];
  /** `font-display` (default `swap`). */
  display?: string;
  /** Fixed weight (when `src` is a single string). */
  weight?: string;
  /** Fixed style (when `src` is a single string). */
  style?: string;
  /** CSS custom property to expose (e.g. `--font-inter`). */
  variable?: string;
  /** Fallback font stack. */
  fallback?: string[];
  /** Whether to preload (advisory; recorded only). */
  preload?: boolean;
}

/** Guess a `format(...)` from a font file extension. */
function formatOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "woff2"
    ? "woff2"
    : ext === "woff"
    ? "woff"
    : ext === "otf"
    ? "opentype"
    : "truetype";
}

/** Normalize `src` into an array of sources. */
function sources(options: LocalFontOptions): LocalFontSource[] {
  if (typeof options.src === "string") {
    return [{ path: options.src, weight: options.weight, style: options.style }];
  }
  return Array.isArray(options.src) ? options.src : [options.src];
}

/**
 * Register a local font and return its `{ className, style, variable }`.
 *
 * @param options The local-font options.
 * @returns The font handle.
 */
export default function localFont(options: LocalFontOptions): FontResult {
  const srcs = sources(options);
  const signature = JSON.stringify(options);
  const family = `dnx-local-${fontClassName("local", signature).slice(7)}`;
  const display = options.display ?? "swap";

  for (const s of srcs) {
    addFontFace(
      `@font-face{font-family:'${family}';` +
        `src:url('${s.path}') format('${formatOf(s.path)}');` +
        `font-weight:${s.weight ?? "normal"};font-style:${s.style ?? "normal"};` +
        `font-display:${display};}`,
    );
  }

  const stack = ["'" + family + "'", ...(options.fallback ?? [])].join(", ");
  const className = fontClassName(family, signature);
  addFontFace(`.${className}{font-family:${stack};}`);

  let variable = "";
  if (options.variable) {
    variable = `${className}_var`;
    addFontFace(`.${variable}{${options.variable}:${stack};}`);
  }

  const style: FontResult["style"] = { fontFamily: stack };
  if (srcs.length === 1) {
    if (srcs[0].weight) style.fontWeight = srcs[0].weight;
    if (srcs[0].style) style.fontStyle = srcs[0].style;
  }
  return { className, style, variable };
}
