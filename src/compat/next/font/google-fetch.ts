// Build-time Google Fonts fetching + self-hosting (used by src/build/self-host-fonts.ts).
// NOT part of the `denext/next/font/google` public surface — that module exports the
// font-family loaders only; these helpers may change between minors.

import { djb2 } from "../../../runtime/djb2.ts";

/** A woff2-capable browser UA so Google serves woff2 rather than legacy formats. */
const WOFF2_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/**
 * Download the resolved `@font-face` CSS for an already-built Google `css2` URL
 * (what the font registry records). Sends a woff2-capable UA. Used by the build's
 * self-host step, which only knows the URL, not the original family/options.
 *
 * @param url The `fonts.googleapis.com/css2` URL.
 * @returns The `@font-face` CSS text from Google.
 */
export async function fetchFontFaceCssFromUrl(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": WOFF2_UA } });
  if (!res.ok) throw new Error(`next/font/google: fetch failed (${res.status}) for ${url}`);
  return await res.text();
}

/** One font file referenced by a Google `@font-face` block. */
export interface GoogleFontAsset {
  /** The remote (gstatic) URL to download. */
  url: string;
  /** The local filename to save it as (stable hash of the URL + extension). */
  filename: string;
}

/** Result of rewriting Google's `@font-face` CSS to self-hosted local URLs. */
export interface RewrittenFontCss {
  /** The CSS with every `src: url(...)` pointing at a local path. */
  css: string;
  /** The font files to download and serve. */
  assets: GoogleFontAsset[];
}

/** Small deterministic hash (djb2 → base36) for stable asset filenames. */
const hashUrl = djb2;

/**
 * Keep only the `@font-face` blocks whose preceding CSS comment names a requested subset
 * (Google annotates each block with a `subset` comment, e.g. `latin`). Drops the other
 * subsets' faces so their files aren't self-hosted — the payload win of `subsets`. If the
 * CSS isn't in the annotated per-subset shape (nothing matched), it is returned unchanged.
 */
function filterSubsets(css: string, subsets: string[]): string {
  const wanted = new Set(subsets.map((s) => s.toLowerCase()));
  const kept: string[] = [];
  const re = /\/\*\s*([a-z0-9-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/gi;
  let matched = false;
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    matched = true;
    if (wanted.has(m[1].toLowerCase())) kept.push(`/* ${m[1]} */\n${m[2]}`);
  }
  return matched && kept.length > 0 ? kept.join("\n") : css;
}

/**
 * Rewrite Google's `@font-face` CSS so each remote `src: url(https://…gstatic…)`
 * points at a local file under `publicPrefix` — the core of self-hosting (privacy
 * + no runtime Google request, matching Next). Pure and network-free: returns the
 * rewritten CSS plus the list of assets to download. When `subsets` is given, only those
 * subsets' faces are kept (so unused subsets aren't downloaded).
 *
 * @param css The `@font-face` CSS fetched from Google Fonts (see {@link fetchFontFaceCssFromUrl}).
 * @param publicPrefix URL path the fonts are served under (e.g. `/_denext/fonts`).
 * @param subsets Character subsets to keep (e.g. `["latin"]`); omit to keep all.
 * @returns The rewritten CSS and the assets to fetch.
 */
export function rewriteGoogleFontFaceCss(
  css: string,
  publicPrefix: string,
  subsets?: string[],
): RewrittenFontCss {
  const prefix = publicPrefix.replace(/\/$/, "");
  const source = subsets && subsets.length > 0 ? filterSubsets(css, subsets) : css;
  const assets: GoogleFontAsset[] = [];
  const seen = new Map<string, string>();
  const rewritten = source.replace(/url\((https:\/\/[^)]+)\)/g, (_m, url: string) => {
    let filename = seen.get(url);
    if (!filename) {
      const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1] ?? "woff2";
      filename = `${hashUrl(url)}.${ext}`;
      seen.set(url, filename);
      assets.push({ url, filename });
    }
    return `url(${prefix}/${filename})`;
  });
  return { css: rewritten, assets };
}
