// A local-font helper (next/font/local-style). It builds the `@font-face` CSS
// for self-hosted font files and returns a style object you spread onto an
// element. Render the CSS once with the {@link FontFace} component.
//
//   const inter = localFont({ family: "Inter", src: "/fonts/inter.woff2" });
//   <FontFace font={inter} />
//   <body style={inter.style}>…</body>

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";

/** A single font source file (with optional weight/style for the face). */
export interface FontSource {
  /** URL of the font file. */
  url: string;
  /** `font-weight` for this face (e.g. "400", "700", "100 900"). */
  weight?: string;
  /** `font-style` for this face (e.g. "normal", "italic"). */
  style?: string;
}

/** Options for {@link localFont}. */
export interface LocalFontOptions {
  /** The `font-family` name to define and use. */
  family: string;
  /** One font file, or several faces. */
  src: string | FontSource[];
  /** `font-display` policy; defaults to "swap". */
  display?: string;
  /** Default `font-weight` applied when a source omits its own. */
  weight?: string;
  /** Default `font-style` applied when a source omits its own. */
  style?: string;
  /** Comma-separated fallback families appended after `family`. */
  fallback?: string[];
}

/** The result of {@link localFont}: a style object plus its `@font-face` CSS. */
export interface FontResult {
  /** The resolved `font-family` value (including fallbacks). */
  fontFamily: string;
  /** Spread onto an element to apply the font. */
  style: { fontFamily: string };
  /** The generated `@font-face` CSS (render once via {@link FontFace}). */
  css: string;
}

/** Guess a font format from a file extension for the `format()` hint. */
function formatOf(url: string): string | null {
  const m = /\.(woff2|woff|ttf|otf|eot)(?:[?#]|$)/i.exec(url);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return ext === "ttf" ? "truetype" : ext === "otf" ? "opentype" : ext;
}

/** Build the `@font-face` CSS and a style object for a self-hosted font. */
export function localFont(options: LocalFontOptions): FontResult {
  const sources = typeof options.src === "string" ? [{ url: options.src }] : options.src;
  const display = options.display ?? "swap";

  const faces = sources.map((s) => {
    const fmt = formatOf(s.url);
    const srcValue = `url("${s.url}")${fmt ? ` format("${fmt}")` : ""}`;
    const weight = s.weight ?? options.weight;
    const style = s.style ?? options.style;
    return [
      "@font-face{",
      `font-family:"${options.family}";`,
      `src:${srcValue};`,
      `font-display:${display};`,
      weight ? `font-weight:${weight};` : "",
      style ? `font-style:${style};` : "",
      "}",
    ].join("");
  });

  const fontFamily = [`"${options.family}"`, ...(options.fallback ?? [])].join(", ");
  return { fontFamily, style: { fontFamily }, css: faces.join("") };
}

/** Render a font's `@font-face` CSS into a `<style>` tag. */
export function FontFace(props: { font: FontResult }): VNode {
  return h("style", { dangerouslySetInnerHTML: { __html: props.font.css } });
}
