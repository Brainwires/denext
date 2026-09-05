/**
 * `next/font/google` compat. Next exposes a named export per family
 * (`import { Inter } from "next/font/google"`); this module provides the popular
 * families plus a generic {@link googleFont} for any other.
 *
 * By default it registers a Google Fonts stylesheet link (synchronous, no npm).
 * For true self-hosting (no runtime Google request, matching Next's privacy
 * story), the build step in src/build/self-host-fonts.ts downloads the
 * `@font-face` CSS + font files and rewrites the `src` URLs to local paths
 * (`rewriteGoogleFontFaceCss` is the pure, testable core of that rewrite).
 *
 * @module
 */

import { addFontFace, addStylesheet, fontClassName, type FontResult } from "./registry.ts";

export type { FontResult } from "./registry.ts";

/** Options for a Google font (a subset of Next's). */
export interface GoogleFontOptions {
  /** Weight(s), e.g. `"400"` or `["400","700"]`. */
  weight?: string | string[];
  /** Style(s), e.g. `"italic"` or `["normal","italic"]`. */
  style?: string | string[];
  /** Character subsets to self-host (e.g. `["latin"]`); other subsets' files are dropped. */
  subsets?: string[];
  /** `font-display` (default `swap`). */
  display?: string;
  /** CSS custom property to expose (e.g. `--font-inter`). */
  variable?: string;
  /** Fallback font stack. */
  fallback?: string[];
  /** Preload the self-hosted font files (emits `<link rel=preload>` in `<head>`). */
  preload?: boolean;
}

/** Build the `fonts.googleapis.com/css2` URL for a family + options. */
export function googleFontUrl(family: string, options: GoogleFontOptions = {}): string {
  const fam = family.replace(/ /g, "+");
  const weights = ([] as string[]).concat(options.weight ?? []).filter(Boolean);
  const styles = ([] as string[]).concat(options.style ?? []).filter(Boolean);
  const italic = styles.includes("italic");
  let axis = "";
  if (weights.length > 0) {
    if (italic) {
      const pairs = weights.flatMap((w) => [`0,${w}`, `1,${w}`]).sort();
      axis = `:ital,wght@${pairs.join(";")}`;
    } else {
      axis = `:wght@${weights.slice().sort().join(";")}`;
    }
  } else if (italic) {
    axis = ":ital@0;1";
  }
  const display = options.display ?? "swap";
  return `https://fonts.googleapis.com/css2?family=${fam}${axis}&display=${display}`;
}

/**
 * Register a Google font (stylesheet link + class) and return its handle.
 *
 * @param family The exact family name (e.g. `"Open Sans"`).
 * @param options The font options.
 * @returns The `{ className, style, variable }` handle.
 */
export function googleFont(family: string, options: GoogleFontOptions = {}): FontResult {
  addStylesheet(googleFontUrl(family, options), {
    subsets: options.subsets,
    preload: options.preload,
  });
  const signature = `${family}:${JSON.stringify(options)}`;
  const stack = [`'${family}'`, ...(options.fallback ?? ["sans-serif"])].join(", ");
  const className = fontClassName(family, signature);
  addFontFace(`.${className}{font-family:${stack};}`);

  let variable = "";
  if (options.variable) {
    variable = `${className}_var`;
    addFontFace(`.${variable}{${options.variable}:${stack};}`);
  }

  const style: FontResult["style"] = { fontFamily: stack };
  const weights = ([] as string[]).concat(options.weight ?? []);
  if (weights.length === 1) style.fontWeight = weights[0];
  return { className, style, variable };
}

/** A named Google-font loader (what each family export is). */
export type GoogleFontLoader = (options?: GoogleFontOptions) => FontResult;

/** Curated popular families exposed as named exports (matching Next). */
const FAMILIES = [
  "Inter",
  "Roboto",
  "Roboto Mono",
  "Roboto Slab",
  "Open Sans",
  "Lato",
  "Montserrat",
  "Poppins",
  "Raleway",
  "Nunito",
  "Nunito Sans",
  "Oswald",
  "Merriweather",
  "Playfair Display",
  "Source Sans 3",
  "Source Code Pro",
  "PT Sans",
  "Ubuntu",
  "Work Sans",
  "Rubik",
  "DM Sans",
  "DM Serif Display",
  "Fira Sans",
  "Fira Code",
  "IBM Plex Sans",
  "IBM Plex Mono",
  "Manrope",
  "Karla",
  "Quicksand",
  "Josefin Sans",
  "Space Grotesk",
  "Space Mono",
  "Archivo",
  "Bebas Neue",
  "Cabin",
  "Mulish",
  "Figtree",
  "Outfit",
  "Plus Jakarta Sans",
  "Geist",
  "Geist Mono",
  "JetBrains Mono",
  "Lora",
  "Noto Sans",
  "Noto Serif",
  "Barlow",
  "Kanit",
  "Hind",
  "Libre Franklin",
  "PT Serif",
  "Crimson Text",
  "Bricolage Grotesque",
  "Instrument Sans",
  "Onest",
  "Sora",
  "Titillium Web",
  "Cormorant Garamond",
  "Bitter",
] as const;

/** Turn a family name into its Next-style export identifier (spaces → `_`). */
function exportName(family: string): string {
  return family.replace(/ /g, "_");
}

// Build the named loaders. Each is `(options?) => googleFont(family, options)`.
const loaders: Record<string, GoogleFontLoader> = {};
for (const family of FAMILIES) {
  loaders[exportName(family)] = (options?: GoogleFontOptions) => googleFont(family, options);
}

/** `import { Inter } from "next/font/google"` */
export const Inter: GoogleFontLoader = loaders.Inter;
/** `import { Roboto } from "next/font/google"` */
export const Roboto: GoogleFontLoader = loaders.Roboto;
/** `Roboto_Mono` */
export const Roboto_Mono: GoogleFontLoader = loaders.Roboto_Mono;
/** `Roboto_Slab` */
export const Roboto_Slab: GoogleFontLoader = loaders.Roboto_Slab;
/** `Open_Sans` */
export const Open_Sans: GoogleFontLoader = loaders.Open_Sans;
/** `Lato` */
export const Lato: GoogleFontLoader = loaders.Lato;
/** `Montserrat` */
export const Montserrat: GoogleFontLoader = loaders.Montserrat;
/** `Poppins` */
export const Poppins: GoogleFontLoader = loaders.Poppins;
/** `Raleway` */
export const Raleway: GoogleFontLoader = loaders.Raleway;
/** `Nunito` */
export const Nunito: GoogleFontLoader = loaders.Nunito;
/** `Nunito_Sans` */
export const Nunito_Sans: GoogleFontLoader = loaders.Nunito_Sans;
/** `Oswald` */
export const Oswald: GoogleFontLoader = loaders.Oswald;
/** `Merriweather` */
export const Merriweather: GoogleFontLoader = loaders.Merriweather;
/** `Playfair_Display` */
export const Playfair_Display: GoogleFontLoader = loaders.Playfair_Display;
/** `Source_Sans_3` */
export const Source_Sans_3: GoogleFontLoader = loaders.Source_Sans_3;
/** `Source_Code_Pro` */
export const Source_Code_Pro: GoogleFontLoader = loaders.Source_Code_Pro;
/** `PT_Sans` */
export const PT_Sans: GoogleFontLoader = loaders.PT_Sans;
/** `Ubuntu` */
export const Ubuntu: GoogleFontLoader = loaders.Ubuntu;
/** `Work_Sans` */
export const Work_Sans: GoogleFontLoader = loaders.Work_Sans;
/** `Rubik` */
export const Rubik: GoogleFontLoader = loaders.Rubik;
/** `DM_Sans` */
export const DM_Sans: GoogleFontLoader = loaders.DM_Sans;
/** `DM_Serif_Display` */
export const DM_Serif_Display: GoogleFontLoader = loaders.DM_Serif_Display;
/** `Fira_Sans` */
export const Fira_Sans: GoogleFontLoader = loaders.Fira_Sans;
/** `Fira_Code` */
export const Fira_Code: GoogleFontLoader = loaders.Fira_Code;
/** `IBM_Plex_Sans` */
export const IBM_Plex_Sans: GoogleFontLoader = loaders.IBM_Plex_Sans;
/** `IBM_Plex_Mono` */
export const IBM_Plex_Mono: GoogleFontLoader = loaders.IBM_Plex_Mono;
/** `Manrope` */
export const Manrope: GoogleFontLoader = loaders.Manrope;
/** `Karla` */
export const Karla: GoogleFontLoader = loaders.Karla;
/** `Quicksand` */
export const Quicksand: GoogleFontLoader = loaders.Quicksand;
/** `Josefin_Sans` */
export const Josefin_Sans: GoogleFontLoader = loaders.Josefin_Sans;
/** `Space_Grotesk` */
export const Space_Grotesk: GoogleFontLoader = loaders.Space_Grotesk;
/** `Space_Mono` */
export const Space_Mono: GoogleFontLoader = loaders.Space_Mono;
/** `Archivo` */
export const Archivo: GoogleFontLoader = loaders.Archivo;
/** `Bebas_Neue` */
export const Bebas_Neue: GoogleFontLoader = loaders.Bebas_Neue;
/** `Cabin` */
export const Cabin: GoogleFontLoader = loaders.Cabin;
/** `Mulish` */
export const Mulish: GoogleFontLoader = loaders.Mulish;
/** `Figtree` */
export const Figtree: GoogleFontLoader = loaders.Figtree;
/** `Outfit` */
export const Outfit: GoogleFontLoader = loaders.Outfit;
/** `Plus_Jakarta_Sans` */
export const Plus_Jakarta_Sans: GoogleFontLoader = loaders.Plus_Jakarta_Sans;
/** `Geist` */
export const Geist: GoogleFontLoader = loaders.Geist;
/** `Geist_Mono` */
export const Geist_Mono: GoogleFontLoader = loaders.Geist_Mono;
/** `JetBrains_Mono` */
export const JetBrains_Mono: GoogleFontLoader = loaders.JetBrains_Mono;
/** `Lora` */
export const Lora: GoogleFontLoader = loaders.Lora;
/** `Noto_Sans` */
export const Noto_Sans: GoogleFontLoader = loaders.Noto_Sans;
/** `Noto_Serif` */
export const Noto_Serif: GoogleFontLoader = loaders.Noto_Serif;
/** `Barlow` */
export const Barlow: GoogleFontLoader = loaders.Barlow;
/** `Kanit` */
export const Kanit: GoogleFontLoader = loaders.Kanit;
/** `Hind` */
export const Hind: GoogleFontLoader = loaders.Hind;
/** `Libre_Franklin` */
export const Libre_Franklin: GoogleFontLoader = loaders.Libre_Franklin;
/** `PT_Serif` */
export const PT_Serif: GoogleFontLoader = loaders.PT_Serif;
/** `Crimson_Text` */
export const Crimson_Text: GoogleFontLoader = loaders.Crimson_Text;
/** `Bricolage_Grotesque` */
export const Bricolage_Grotesque: GoogleFontLoader = loaders.Bricolage_Grotesque;
/** `Instrument_Sans` */
export const Instrument_Sans: GoogleFontLoader = loaders.Instrument_Sans;
/** `Onest` */
export const Onest: GoogleFontLoader = loaders.Onest;
/** `Sora` */
export const Sora: GoogleFontLoader = loaders.Sora;
/** `Titillium_Web` */
export const Titillium_Web: GoogleFontLoader = loaders.Titillium_Web;
/** `Cormorant_Garamond` */
export const Cormorant_Garamond: GoogleFontLoader = loaders.Cormorant_Garamond;
/** `Bitter` */
export const Bitter: GoogleFontLoader = loaders.Bitter;
