// Build-time self-hosting of `next/font/google` fonts (Next.js parity): download
// each font a build used — its `@font-face` CSS + the font files — and emit them
// locally, producing a manifest (Google URL → locally-rewritten CSS) that the prod
// server installs. The browser then loads fonts from the app's own origin and never
// requests them from Google (privacy + no runtime Google dependency).
//
// A font that can't be fetched at build (offline / air-gapped CI, network error) is
// skipped with a warning and falls back to a runtime `<link>` — self-hosting is
// best-effort and never fails the build.

import { join } from "@std/path";
import { fetchFontFaceCssFromUrl, rewriteGoogleFontFaceCss } from "../compat/next/font/google.ts";

/** URL path the self-hosted font files are served under. */
export const FONTS_PUBLIC_PREFIX = "/_denext/fonts";
/** Build-output file mapping each Google stylesheet URL to its local `@font-face` CSS. */
export const FONT_MANIFEST_FILE = "font-manifest.json";

/**
 * Self-host each Google stylesheet `url`: fetch its `@font-face` CSS, download the
 * referenced font files into `fontsOutDir`, and return a map of `url` → the CSS
 * rewritten to serve those files locally (under {@link FONTS_PUBLIC_PREFIX}). A URL
 * that can't be self-hosted is omitted (with a warning) and stays a runtime link.
 *
 * @param urls The Google `css2` stylesheet URLs the build discovered.
 * @param fontsOutDir Directory to write the downloaded font files into.
 * @param publicPrefix URL path the files are served under (defaults to the standard).
 * @returns A map from each successfully self-hosted URL to its local `@font-face` CSS.
 */
export async function selfHostFonts(
  urls: Iterable<string>,
  fontsOutDir: string,
  publicPrefix: string = FONTS_PUBLIC_PREFIX,
): Promise<Record<string, string>> {
  const manifest: Record<string, string> = {};
  for (const url of urls) {
    try {
      const raw = await fetchFontFaceCssFromUrl(url);
      const { css, assets } = rewriteGoogleFontFaceCss(raw, publicPrefix);
      await Deno.mkdir(fontsOutDir, { recursive: true });
      for (const asset of assets) {
        const res = await fetch(asset.url);
        if (!res.ok) throw new Error(`font file fetch failed (${res.status}): ${asset.url}`);
        await Deno.writeFile(
          join(fontsOutDir, asset.filename),
          new Uint8Array(await res.arrayBuffer()),
        );
      }
      manifest[url] = css;
    } catch (err) {
      console.warn(
        `denext: could not self-host a Google font (${url}) — it will load from Google ` +
          `at runtime instead. ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return manifest;
}
