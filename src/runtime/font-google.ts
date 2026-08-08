// A Google Fonts helper (next/font/google-style). It fetches the Google Fonts
// CSS2 stylesheet for the requested family/weights at build/startup and returns
// the same {@link FontResult} shape as {@link localFont}, so you render it once
// with {@link FontFace}.
//
//   const inter = await googleFont({ family: "Inter", weights: [400, 700] });
//   <FontFace font={inter} />
//   <body style={inter.style}>…</body>
//
// Note: the returned `@font-face` CSS references Google's `fonts.gstatic.com`
// URLs. True self-hosting (downloading the binaries and rewriting URLs) is a
// planned enhancement; call this once at module scope, not per request.

import type { FontResult } from "./font.ts";

/** A browser-like UA so the CSS2 API returns modern `woff2` sources. */
const MODERN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** Options for {@linkcode googleFont}. */
export interface GoogleFontOptions {
  /** The Google font family (e.g. "Inter", "Roboto Mono"). */
  family: string;
  /** Weights to load (default `[400]`). */
  weights?: Array<number | string>;
  /** Styles to load; include "italic" for italic faces. */
  styles?: Array<"normal" | "italic">;
  /** `font-display` policy; defaults to "swap". */
  display?: string;
  /** Comma-separated fallback families appended after the family. */
  fallback?: string[];
}

/**
 * Build the Google Fonts CSS2 stylesheet URL for the given options.
 *
 * @param options Font selection options.
 */
export function googleFontUrl(options: GoogleFontOptions): string {
  const family = options.family.trim().replace(/ /g, "+");
  const weights = (options.weights ?? [400]).map(String);
  const display = options.display ?? "swap";
  let axis: string;
  if (options.styles?.includes("italic")) {
    const pairs: string[] = [];
    for (const w of weights) {
      pairs.push(`0,${w}`);
      pairs.push(`1,${w}`);
    }
    axis = `ital,wght@${pairs.sort().join(";")}`;
  } else {
    axis = `wght@${weights.join(";")}`;
  }
  return `https://fonts.googleapis.com/css2?family=${family}:${axis}&display=${display}`;
}

/**
 * Fetch a Google font's CSS2 stylesheet and return a {@linkcode FontResult}.
 * Call once at module scope (top-level `await`), not per request.
 *
 * @param options Font selection options.
 */
export async function googleFont(options: GoogleFontOptions): Promise<FontResult> {
  const res = await fetch(googleFontUrl(options), { headers: { "user-agent": MODERN_UA } });
  if (!res.ok) {
    throw new Error(`googleFont: failed to fetch "${options.family}" (${res.status})`);
  }
  const css = await res.text();
  const fontFamily = [`"${options.family}"`, ...(options.fallback ?? [])].join(", ");
  return { fontFamily, style: { fontFamily }, css };
}
