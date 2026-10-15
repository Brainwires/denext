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
import {
  fallbackFace,
  type FallbackFontFace,
  localFallbackOverrides,
  registerFontClass,
} from "./fallback.ts";
import { fontFileMetrics } from "./font-file.ts";

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
  /**
   * Next's metric-matched fallback for a local font: `"Arial"` (the default) or
   * `"Times New Roman"` re-proportioned with `size-adjust` + `ascent`/`descent`/`line-gap-override`
   * computed from the font file's own metrics (`head`, `hhea`, `cmap` + `hmtx`), emitted as a
   * `"<family> Fallback"` face placed right after the font in the stack; `false` emits none.
   * The file is read from disk when the font registers: an absolute `src` is looked up under
   * `public/` and then as a file path, a relative one under the project root, `public/`,
   * `app/`, `src/app/` and `src/`. A file that can't be found or parsed emits no fallback face.
   */
  adjustFontFallback?: false | "Arial" | "Times New Roman";
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

/** A weight (`normal`, `bold` or a number) as a number. */
function weightNumber(weight: string): number {
  return weight === "normal" ? 400 : weight === "bold" ? 700 : Number(weight);
}

/**
 * How far a source's weight is from 400 (Next's `getDistanceFromNormalWeight`): 0 when a
 * variable range (`"100 900"`) spans it, else the signed distance of the nearer end. An
 * unparseable weight (a build error in Next) ranks last.
 */
function distanceFromNormal(weight?: string): number {
  if (!weight) return 0;
  const [first, second] = weight.trim().split(/ +/).map(weightNumber);
  if (Number.isNaN(first) || Number.isNaN(second)) return Infinity;
  if (!second) return first - 400;
  if (first <= 400 && second >= 400) return 0;
  return Math.abs(first - 400) < Math.abs(second - 400) ? first - 400 : second - 400;
}

/**
 * The source the fallback is measured from (Next's `pickFontFileForFallbackGeneration`):
 * nearest weight to 400, normal style on a tie, then the thinner one.
 */
function pickFallbackSource(srcs: LocalFontSource[]): LocalFontSource {
  return srcs.reduce((used, current) => {
    const usedD = distanceFromNormal(used.weight);
    const curD = distanceFromNormal(current.weight);
    if (usedD === curD && (current.style === undefined || current.style === "normal")) {
      return current;
    }
    const absUsed = Math.abs(usedD);
    const absCur = Math.abs(curD);
    if (absCur < absUsed || (absCur === absUsed && curD < usedD)) return current;
    return used;
  });
}

/** Where a font `src` may live on disk (see `adjustFontFallback`). */
function candidatePaths(path: string, cwd: string): string[] {
  if (path.startsWith("/")) return [`${cwd}/public${path}`, path];
  const rel = path.replace(/^\.\//, "");
  return ["", "public/", "app/", "src/app/", "src/"].map((dir) => `${cwd}/${dir}${rel}`);
}

/** True when reading `path` is already granted (so a lookup never raises a permission prompt). */
function readGranted(deno: typeof Deno, path: string): boolean {
  return deno.permissions.querySync({ name: "read", path }).state === "granted";
}

/** The font file's bytes, or `null` off-server (no `Deno`), without read access, or not found. */
function readFontFile(path: string): Uint8Array | null {
  const deno = (globalThis as { Deno?: typeof Deno }).Deno;
  if (!deno?.readFileSync || !readGranted(deno, ".")) return null;
  for (const candidate of candidatePaths(path, deno.cwd())) {
    if (!readGranted(deno, candidate)) continue;
    try {
      return deno.readFileSync(candidate);
    } catch {
      // Not there (or not a file): try the next location.
    }
  }
  return null;
}

/** The metric-matched fallback face for a local font, or `null` (disabled or unreadable). */
function localFallbackFace(
  family: string,
  srcs: LocalFontSource[],
  adjust: LocalFontOptions["adjustFontFallback"],
): FallbackFontFace | null {
  if (adjust === false || srcs.length === 0) return null;
  const bytes = readFontFile(pickFallbackSource(srcs).path);
  const metrics = bytes && fontFileMetrics(bytes);
  if (!metrics) return null;
  const face = adjust === "Times New Roman" ? "Times New Roman" : "Arial";
  return fallbackFace(family, localFallbackOverrides(metrics, face));
}

/** The `@font-face` block for one source file. */
function sourceFace(family: string, s: LocalFontSource, display: string): string {
  return `@font-face{font-family:'${family}';` +
    `src:url('${s.path}') format('${formatOf(s.path)}');` +
    `font-weight:${s.weight ?? "normal"};font-style:${s.style ?? "normal"};` +
    `font-display:${display};}`;
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
  for (const s of srcs) addFontFace(sourceFace(family, s, display));

  const { className, variable, stack } = registerFontClass({
    family,
    signature,
    fallbackFace: localFallbackFace(family, srcs, options.adjustFontFallback),
    fallback: options.fallback ?? [],
    variable: options.variable,
  });
  const style: FontResult["style"] = { fontFamily: stack };
  if (srcs.length === 1) {
    if (srcs[0].weight) style.fontWeight = srcs[0].weight;
    if (srcs[0].style) style.fontStyle = srcs[0].style;
  }
  return { className, style, variable };
}
