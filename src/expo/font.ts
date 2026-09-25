/**
 * `expo-font` for denext: `loadAsync` / `useFonts` through the CSS Font Loading API
 * (`FontFace` + `document.fonts`). A source is a font file's URL (what a denext build gives
 * for `require("./Inter.ttf")`), `{ uri, display }`, or an `Asset`.
 *
 * `renderToImageAsync` is not provided (see the manifest).
 *
 * @example
 * ```ts
 * import { useFonts } from "denext/expo/font";
 *
 * const [loaded, error] = useFonts({ Inter: interUrl });
 * ```
 *
 * @module
 */

import { useEffect, useState } from "../runtime/hooks.ts";

/** The CSS `font-display` value. */
export enum FontDisplay {
  /** Browser default. */
  AUTO = "auto",
  /** Fallback first, swap when loaded (the default here). */
  SWAP = "swap",
  /** Invisible until loaded. */
  BLOCK = "block",
  /** A short block, then fallback. */
  FALLBACK = "fallback",
  /** Use it only if already cached. */
  OPTIONAL = "optional",
}

/** A font file source with options. */
export interface FontResource {
  /** The font file's URL. */
  uri?: string | number;
  /** The `font-display` value. */
  display?: FontDisplay;
  /** The default export of a module (an ESM-wrapped URL). */
  default?: string;
}

/** A font source: a URL, a resource, or anything with a `uri` / `localUri` (an Asset). */
export type FontSource = string | number | FontResource | {
  uri?: string;
  localUri?: string | null;
};

/** Options for {@linkcode unloadAsync}. */
export type UnloadFontOptions = Pick<FontResource, "display">;

/** The loaded families, and the ones loading. */
const state: { loaded?: Map<string, FontFace>; loading?: Map<string, Promise<void>> } = {};

/** The loaded-family map. */
function loaded(): Map<string, FontFace> {
  return state.loaded ??= new Map();
}

/** The loading-family map. */
function loading(): Map<string, Promise<void>> {
  return state.loading ??= new Map();
}

/** The URL and display of a source. */
function resolveSource(source: FontSource): { url: string; display?: FontDisplay } {
  if (typeof source === "string") return { url: source };
  if (typeof source === "number") {
    throw new TypeError("expo-font: numeric Metro asset ids are not supported (import the file)");
  }
  const record = source as FontResource & { localUri?: string | null };
  const url = record.localUri ?? (typeof record.uri === "string" ? record.uri : record.default);
  if (!url) throw new TypeError("expo-font: the font source has no URL");
  return { url, display: record.display };
}

/** Load one family. */
function loadOne(family: string, source: FontSource): Promise<void> {
  if (loaded().has(family)) return Promise.resolve();
  const pending = loading().get(family);
  if (pending) return pending;
  const { url, display } = resolveSource(source);
  const face = new FontFace(family, `url(${JSON.stringify(url)})`, {
    display: display ?? FontDisplay.SWAP,
  });
  const promise = face.load().then((ready) => {
    document.fonts.add(ready);
    loaded().set(family, ready);
  }).finally(() => loading().delete(family));
  loading().set(family, promise);
  return promise;
}

/**
 * Load fonts: one family and its source, or a map of families to sources.
 *
 * @param fontFamilyOrFontMap A family name, or `{ family: source }`.
 * @param source The source, with a family name.
 * @returns A promise that settles once every font is usable.
 */
export async function loadAsync(
  fontFamilyOrFontMap: string | Record<string, FontSource>,
  source?: FontSource,
): Promise<void> {
  if (typeof fontFamilyOrFontMap === "string") {
    if (source === undefined) throw new TypeError("loadAsync: pass the font's source");
    return await loadOne(fontFamilyOrFontMap, source);
  }
  await Promise.all(
    Object.entries(fontFamilyOrFontMap).map(([family, src]) => loadOne(family, src)),
  );
}

/**
 * Whether `fontFamily` is loaded.
 *
 * @param fontFamily The family.
 * @returns `true` once loaded.
 */
export function isLoaded(fontFamily: string): boolean {
  return loaded().has(fontFamily);
}

/**
 * Whether `fontFamily` is loading.
 *
 * @param fontFamily The family.
 * @returns `true` while loading.
 */
export function isLoading(fontFamily: string): boolean {
  return loading().has(fontFamily);
}

/**
 * The families loaded through this module.
 *
 * @returns Their names.
 */
export function getLoadedFonts(): string[] {
  return [...loaded().keys()];
}

/**
 * Unload fonts.
 *
 * @param fontFamilyOrFontMap A family, or a map of families.
 * @param _options Ignored.
 * @returns A promise that settles once removed.
 */
export function unloadAsync(
  fontFamilyOrFontMap: string | Record<string, UnloadFontOptions>,
  _options?: UnloadFontOptions,
): Promise<void> {
  const families = typeof fontFamilyOrFontMap === "string"
    ? [fontFamilyOrFontMap]
    : Object.keys(fontFamilyOrFontMap);
  for (const family of families) {
    const face = loaded().get(family);
    if (face) document.fonts.delete(face);
    loaded().delete(family);
  }
  return Promise.resolve();
}

/**
 * Unload every font loaded through this module.
 *
 * @returns A promise that settles once removed.
 */
export function unloadAllAsync(): Promise<void> {
  return unloadAsync(Object.fromEntries(getLoadedFonts().map((f) => [f, {}])));
}

/**
 * Load fonts for a component: `[loaded, error]`.
 *
 * @param map A family, or `{ family: source }`.
 * @returns Whether every font is loaded, and the load error if one failed.
 */
export function useFonts(map: string | Record<string, FontSource>): [boolean, Error | null] {
  const families = typeof map === "string" ? [map] : Object.keys(map);
  const [result, setResult] = useState<[boolean, Error | null]>([
    families.every(isLoaded),
    null,
  ]);
  const key = families.join("\0");
  useEffect(() => {
    if (typeof map === "string") return;
    let active = true;
    loadAsync(map).then(
      () => active && setResult([true, null]),
      (err: Error) => active && setResult([false, err]),
    );
    return () => void (active = false);
  }, [key]);
  return result;
}
