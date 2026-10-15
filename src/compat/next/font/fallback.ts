/**
 * Metric-matched fallback faces for `next/font` (Next's `adjustFontFallback`): a local
 * system font (`Arial` / `Times New Roman`) re-proportioned with `size-adjust` and the
 * `ascent-override` / `descent-override` / `line-gap-override` descriptors so text laid out
 * in the fallback occupies the same space as the web font that replaces it — the fix for
 * font-swap layout shift (CLS). The numbers come from a generated table of real font metrics
 * ({@link "./font-metrics.ts"}, Capsize's set, the one Next ships), and the math is Next's
 * `calculateSizeAdjustValues`, so a migrated app gets the same overrides it had.
 *
 * @module
 */

import type { FontFileMetrics } from "./font-file.ts";
import { FONT_METRICS } from "./font-metrics.ts";

/** A local system face a fallback can be built on (Next's two choices). */
export type FallbackFace = "Arial" | "Times New Roman";

/** The metrics the override math reads, in font units. */
interface FontMetrics {
  /** Google Fonts category (`sans-serif`, `serif`, `display`, `handwriting`, `monospace`). */
  category: string;
  unitsPerEm: number;
  ascent: number;
  descent: number;
  lineGap: number;
  /** Weighted average glyph advance (Capsize's `xWidthAvg`), or 0 when unknown. */
  xWidthAvg: number;
}

let table: Map<string, FontMetrics> | null = null;

/** Metrics for a family (exact Google Fonts name), or `null` when the table has none. */
function fontMetrics(family: string): FontMetrics | null {
  if (!table) {
    table = new Map();
    for (const [name, category, unitsPerEm, ascent, descent, lineGap, xWidthAvg] of FONT_METRICS) {
      table.set(name, { category, unitsPerEm, ascent, descent, lineGap, xWidthAvg });
    }
  }
  return table.get(family) ?? null;
}

/** Next's default fallback face for a category: Times New Roman for serif, Arial otherwise. */
function defaultFallbackFace(category: string): FallbackFace {
  return category === "serif" ? "Times New Roman" : "Arial";
}

/** The `@font-face` descriptors of a metric-matched fallback, as CSS percentages. */
export interface FallbackOverrides {
  /** The local face the overrides apply to. */
  fallbackFont: FallbackFace;
  sizeAdjust: string;
  ascentOverride: string;
  descentOverride: string;
  lineGapOverride: string;
}

/** `abs(v) * 100` to two decimals, as Next formats override values. */
function pct(v: number): string {
  return `${Math.abs(v * 100).toFixed(2)}%`;
}

/**
 * Compute the fallback overrides for `family` (Next's `calculateSizeAdjustValues`): scale
 * the fallback so its average glyph width matches, then express the web font's ascent /
 * descent / line gap relative to that scaled size.
 *
 * @param family The web font's exact family name.
 * @param face The local face to adjust; defaults by the family's category.
 * @returns The overrides, or `null` when the family (or the face) has no metrics.
 */
export function fallbackOverrides(family: string, face?: FallbackFace): FallbackOverrides | null {
  const font = fontMetrics(family);
  if (!font) return null;
  const fallbackFont = face ?? defaultFallbackFace(font.category);
  const fb = fontMetrics(fallbackFont);
  if (!fb) return null;
  const mainAvg = font.xWidthAvg / font.unitsPerEm;
  const fbAvg = fb.xWidthAvg / fb.unitsPerEm;
  const sizeAdjust = font.xWidthAvg ? mainAvg / fbAvg : 1;
  const scale = font.unitsPerEm * sizeAdjust;
  return {
    fallbackFont,
    sizeAdjust: pct(sizeAdjust),
    ascentOverride: pct(font.ascent / scale),
    descentOverride: pct(font.descent / scale),
    lineGapOverride: pct(font.lineGap / scale),
  };
}

/** A metric-matched fallback `@font-face` and the family name it declares. */
export interface FallbackFontFace {
  /** The declared family (`"<Family> Fallback"`), to splice into the font stack. */
  family: string;
  /** The `@font-face` block. */
  css: string;
}

/**
 * The metric-matched fallback `@font-face` for `family`, or `null` when no metrics are
 * known for it (the stack then falls back to the plain generic family, as before).
 *
 * @param family The web font's exact family name.
 * @param face The local face to adjust; defaults by category.
 */
export function fallbackFontFace(family: string, face?: FallbackFace): FallbackFontFace | null {
  const o = fallbackOverrides(family, face);
  return o ? fallbackFace(family, o) : null;
}

/** The `"<family> Fallback"` `@font-face` carrying a set of overrides. */
export function fallbackFace(family: string, o: FallbackOverrides): FallbackFontFace {
  const name = `${family} Fallback`;
  return {
    family: name,
    css: `@font-face{font-family:'${name}';src:local("${o.fallbackFont}");` +
      `ascent-override:${o.ascentOverride};descent-override:${o.descentOverride};` +
      `line-gap-override:${o.lineGapOverride};size-adjust:${o.sizeAdjust};}`,
  };
}

/**
 * The fallback faces' average widths as `next/font/local` measures them (fontkit over the
 * system files, Next's `DEFAULT_SANS_SERIF_FONT` / `DEFAULT_SERIF_FONT`) — not Capsize's
 * `xWidthAvg`, which the Google path uses.
 */
const LOCAL_FALLBACK_WIDTHS: Record<FallbackFace, { azAvgWidth: number; unitsPerEm: number }> = {
  "Arial": { azAvgWidth: 934.5116279069767, unitsPerEm: 2048 },
  "Times New Roman": { azAvgWidth: 854.3953488372093, unitsPerEm: 2048 },
};

/**
 * The overrides for a local font file (Next's `getFallbackMetricsFromFontFile`): the same
 * math as {@link fallbackOverrides}, against the fallback widths `next/font/local` uses.
 *
 * @param font The parsed font file's metrics.
 * @param face The local face to adjust (`Arial` unless `Times New Roman` was asked for).
 */
export function localFallbackOverrides(
  font: FontFileMetrics,
  face: FallbackFace,
): FallbackOverrides {
  const fb = LOCAL_FALLBACK_WIDTHS[face];
  const sizeAdjust = font.azAvgWidth
    ? font.azAvgWidth / font.unitsPerEm / (fb.azAvgWidth / fb.unitsPerEm)
    : 1;
  const scale = font.unitsPerEm * sizeAdjust;
  return {
    fallbackFont: face,
    sizeAdjust: pct(sizeAdjust),
    ascentOverride: pct(font.ascent / scale),
    descentOverride: pct(font.descent / scale),
    lineGapOverride: pct(font.lineGap / scale),
  };
}
