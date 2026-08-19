/**
 * `@denext/og` — a Deno-native `ImageResponse`, the first-party replacement for
 * the npm `@cf-wasm/og` peer codec denext's {@linkcode ImageResponse} used to
 * lazily import. It renders JSX-shaped elements to PNG (or SVG) with **zero npm
 * dependencies and no runtime permissions** for plain-Latin text.
 *
 * It vendors the full **satori** (flexbox layout → SVG, via **yoga**) + **resvg**
 * (SVG → PNG) stack as a single self-contained bundle generated from
 * [`@cf-wasm/og`](https://github.com/fineshopdesign/cf-wasm) `@0.5.0` — its `node`
 * entry, whose `yoga.wasm`, `resvg.wasm` and default **Noto Sans** font are all
 * inlined as base64, so nothing is fetched or read from disk to render. See
 * `README.md` for how the bundle is reproduced and `THIRD-PARTY-LICENSES.md` for
 * the vendored components' licenses.
 *
 * Only satori's layout subset is supported (flexbox + inline `style`; no
 * `className`/CSS). The bundled font covers Latin; characters outside it (emoji,
 * CJK, symbols) are fetched from Google Fonts at render time exactly as upstream
 * `@cf-wasm/og` does — that path needs `--allow-net`, and degrades to a fallback
 * glyph offline. It is a server-only codec and is never shipped to the browser.
 *
 * @example Render an element to a PNG `Response`
 * ```ts
 * import { ImageResponse } from "@denext/og";
 * const res = new ImageResponse(
 *   {
 *     type: "div",
 *     props: {
 *       style: {
 *         display: "flex",
 *         width: "100%",
 *         height: "100%",
 *         alignItems: "center",
 *         justifyContent: "center",
 *         background: "#0b1020",
 *         color: "white",
 *         fontSize: 64,
 *       },
 *       children: "Hello denext",
 *     },
 *   },
 *   { width: 1200, height: 630 },
 * );
 * ```
 *
 * @module
 */

// The vendored bundle is untyped JS (satori + resvg + yoga, wasm inline); re-typed
// below so `deno check`/`deno doc` see a precise, slow-type-free public surface.
import {
  CustomFont as VendoredCustomFont,
  GoogleFont as VendoredGoogleFont,
  ImageResponse as VendoredImageResponse,
  loadGoogleFont as vendoredLoadGoogleFont,
} from "./lib/og.bundle.js";

/** A satori element: a host tag with `props.style`/`props.children`. */
export interface SatoriElement {
  type: string;
  props: Record<string, unknown>;
}

/** CSS `font-style` accepted by the font helpers. */
export type FontStyle = "normal" | "italic";
/** CSS `font-weight` accepted by the font helpers. */
export type FontWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;

/** Options for {@linkcode CustomFont}. */
export interface CustomFontOptions {
  weight?: FontWeight;
  style?: FontStyle;
  /** Restrict this font to a language, e.g. `"ja-JP"`. */
  lang?: string;
}

/** Options for {@linkcode GoogleFont} and {@linkcode loadGoogleFont}. */
export interface GoogleFontOptions {
  /** `font-family` name satori matches against (defaults to the family). */
  name?: string;
  weight?: FontWeight | number;
  style?: FontStyle;
  /** Google Fonts subset, e.g. `"latin"`, `"cyrillic"`. */
  subset?: string;
  /** Restrict the loaded glyphs to this text. */
  text?: string;
}

/** A loaded font satori can use (from {@linkcode CustomFont}/{@linkcode GoogleFont}). */
export interface OgFont {
  name: string;
  style: FontStyle;
  weight: FontWeight;
  readonly data: Promise<ArrayBuffer | Uint8Array>;
}

/** Options for {@linkcode ImageResponse} (dimensions + satori/resvg passthrough). */
export interface ImageResponseOptions {
  /** Output width in pixels (default 1200). */
  width?: number;
  /** Output height in pixels (default 630). */
  height?: number;
  /** `"png"` (default) or `"svg"`. */
  format?: "png" | "svg";
  /** Extra fonts to make available to satori. */
  fonts?: OgFont[];
  /** Emoji provider passed through to satori, e.g. `"twemoji"`. */
  emoji?: string;
  /** Headers merged into the returned {@linkcode Response}. */
  headers?: HeadersInit;
  /** Any other option is forwarded verbatim to the vendored renderer. */
  [key: string]: unknown;
}

/**
 * Renders a satori element (or JSX-shaped object) to a PNG {@linkcode Response}.
 * A subclass of {@linkcode Response}, so `res.arrayBuffer()` yields the PNG bytes.
 */
export const ImageResponse: new (
  element: SatoriElement | unknown,
  options?: ImageResponseOptions,
) => Response = VendoredImageResponse;

/** Load a font from raw bytes (or a lazy loader) for {@linkcode ImageResponseOptions.fonts}. */
export const CustomFont: new (
  name: string,
  input:
    | ArrayBuffer
    | Uint8Array
    | Promise<ArrayBuffer | Uint8Array>
    | (() => ArrayBuffer | Uint8Array | Promise<ArrayBuffer | Uint8Array>),
  options?: CustomFontOptions,
) => OgFont = VendoredCustomFont as unknown as new (
  name: string,
  input:
    | ArrayBuffer
    | Uint8Array
    | Promise<ArrayBuffer | Uint8Array>
    | (() => ArrayBuffer | Uint8Array | Promise<ArrayBuffer | Uint8Array>),
  options?: CustomFontOptions,
) => OgFont;

/** A font pulled from Google Fonts at render time (needs `--allow-net`). */
export const GoogleFont: new (
  family: string,
  options?: GoogleFontOptions,
) => OgFont = VendoredGoogleFont as unknown as new (
  family: string,
  options?: GoogleFontOptions,
) => OgFont;

/** Fetch a Google Fonts family as an {@linkcode ArrayBuffer} (needs `--allow-net`). */
export const loadGoogleFont: (
  family: string,
  options?: GoogleFontOptions,
) => Promise<ArrayBuffer> = vendoredLoadGoogleFont;
