/**
 * `expo-font` for denext: `loadAsync` / `useFonts` through the CSS Font Loading API
 * (`FontFace` + `document.fonts`). A source is a font file's URL (what a denext build gives
 * for `require("./Inter.ttf")`), `{ uri, display, weight, style }`, or an `Asset`. SDK 58's
 * font families load too: `loadAsync([{ fontFamily, fontDefinitions: [{ path, weight, style
 * }] }])` registers each face under one family name, and `unloadAsync(family, { weight,
 * style })` removes just the matching faces.
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
import { CodedError } from "./internal/common.ts";

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
  /** The face's weight (`400`, `"bold"`, a variable font's `"100 900"`). */
  weight?: number | string;
  /** The face's style. */
  style?: "normal" | "italic" | "oblique";
}

/** A font source: a URL, a resource, or anything with a `uri` / `localUri` (an Asset). */
export type FontSource = string | number | FontResource | {
  uri?: string;
  localUri?: string | null;
};

/** One face of a {@linkcode FontFamilyDefinition}. */
export type FontFaceDefinition = {
  /** The face's font file. */
  path: FontSource;
  /** Its weight (else the source's). */
  weight?: number | string;
  /** Its style (else the source's). */
  style?: "normal" | "italic" | "oblique";
  /** Its `font-display` (else the source's). */
  display?: FontDisplay;
};

/** A font family made of several faces (weights and styles) under one name. */
export type FontFamilyDefinition = {
  /** The name to use as the `fontFamily` style. */
  fontFamily: string;
  /** Its faces. */
  fontDefinitions: FontFaceDefinition[];
};

/** What {@linkcode loadAsync} and {@linkcode useFonts} take. */
export type FontMap = string | Record<string, FontSource> | FontFamilyDefinition[];

/** Options for {@linkcode unloadAsync}: which faces of the family to remove. */
export type UnloadFontOptions = Pick<FontResource, "display" | "weight" | "style">;

/** The loaded families (each with its faces), and the ones loading. */
const state: { loaded?: Map<string, FontFace[]>; loading?: Map<string, Promise<void>> } = {};

/** The loaded-family map. */
function loaded(): Map<string, FontFace[]> {
  return state.loaded ??= new Map();
}

/** The loading-family map. */
function loading(): Map<string, Promise<void>> {
  return state.loading ??= new Map();
}

/** A source resolved: its URL and face descriptors. */
interface ResolvedFace {
  url: string;
  display?: FontDisplay;
  weight?: number | string;
  style?: string;
}

/** The URL and face descriptors of a source. */
function resolveSource(source: FontSource): ResolvedFace {
  if (typeof source === "string") return { url: source };
  if (typeof source === "number") {
    throw new TypeError("expo-font: numeric Metro asset ids are not supported (import the file)");
  }
  const record = source as FontResource & { localUri?: string | null };
  const url = record.localUri ?? (typeof record.uri === "string" ? record.uri : record.default);
  if (!url) throw new TypeError("expo-font: the font source has no URL");
  return { url, display: record.display, weight: record.weight, style: record.style };
}

/** A face of `family` from `face`, loaded and added to the document. */
async function addFace(family: string, face: ResolvedFace): Promise<FontFace> {
  const descriptors: FontFaceDescriptors = { display: face.display ?? FontDisplay.SWAP };
  if (face.weight !== undefined) descriptors.weight = String(face.weight);
  if (face.style !== undefined) descriptors.style = face.style;
  const ready = await new FontFace(family, `url(${JSON.stringify(face.url)})`, descriptors)
    .load();
  document.fonts.add(ready);
  return ready;
}

/** Load `family` from `faces` once: concurrent callers share the load. */
function loadFaces(family: string, faces: () => ResolvedFace[]): Promise<void> {
  if (loaded().has(family)) return Promise.resolve();
  const pending = loading().get(family);
  if (pending) return pending;
  const promise = Promise.resolve().then(faces).then((list) =>
    Promise.all(list.map((face) => addFace(family, face)))
  ).then((ready) => {
    loaded().set(family, ready);
  }).finally(() => loading().delete(family));
  loading().set(family, promise);
  return promise;
}

/** A face's weight as one number (`"bold"` → 700), or undefined for a range or nothing. */
function weightNumber(weight: number | string | undefined): number | undefined {
  if (weight === undefined || weight === null) return undefined;
  if (typeof weight === "number") return Number.isFinite(weight) ? weight : undefined;
  const lower = weight.trim().toLowerCase();
  if (lower === "normal") return 400;
  if (lower === "bold") return 700;
  const numeric = Number(lower);
  return lower !== "" && Number.isFinite(numeric) ? numeric : undefined;
}

/** A face's style as `normal` / `italic` (oblique counts as italic), or undefined. */
function styleName(style: string | undefined): "normal" | "italic" | undefined {
  if (style === undefined || style === null) return undefined;
  const lower = style.trim().toLowerCase();
  return lower === "italic" || lower === "oblique" ? "italic" : "normal";
}

/** The resolved faces of a family definition, after Expo's checks (`ERR_FONT_API`). */
function familyFaces(fontFamily: unknown, faces: unknown): ResolvedFace[] {
  if (typeof fontFamily !== "string" || fontFamily === "") {
    throw new CodedError(
      "ERR_FONT_API",
      `Expected a non-empty string for \`fontFamily\`, instead got ${JSON.stringify(fontFamily)}.`,
    );
  }
  if (!Array.isArray(faces) || faces.length === 0) {
    throw new CodedError(
      "ERR_FONT_API",
      `No font faces were provided for font family "${fontFamily}".`,
    );
  }
  const seen = new Set<string>();
  return faces.map((face: FontFaceDefinition) => {
    if (typeof face !== "object" || face === null || face.path == null) {
      throw new CodedError(
        "ERR_FONT_API",
        `A face of font family "${fontFamily}" has no \`path\`.`,
      );
    }
    const source = resolveSource(face.path);
    const resolved: ResolvedFace = {
      url: source.url,
      display: face.display ?? source.display,
      weight: face.weight ?? source.weight,
      style: face.style ?? source.style,
    };
    const weight = weightNumber(resolved.weight);
    const style = styleName(resolved.style);
    if (weight !== undefined && style !== undefined) {
      const key = `${weight}/${style}`;
      if (seen.has(key)) {
        throw new CodedError(
          "ERR_FONT_API",
          `Font family "${fontFamily}" declares two faces with weight ${weight} and style ` +
            `"${style}". Give each face a distinct weight or style.`,
        );
      }
      seen.add(key);
    }
    return resolved;
  });
}

/** Load each family definition (each family once per call: `ERR_FONT_API` otherwise). */
function loadFamilies(definitions: FontFamilyDefinition[]): Promise<void> {
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (
      typeof definition !== "object" || definition === null || Array.isArray(definition) ||
      !("fontFamily" in definition) || !("fontDefinitions" in definition)
    ) {
      return Promise.reject(
        new CodedError(
          "ERR_FONT_API",
          "Expected an object with `fontFamily` and `fontDefinitions`, instead got " +
            `${JSON.stringify(definition)}.`,
        ),
      );
    }
    if (seen.has(definition.fontFamily)) {
      return Promise.reject(
        new CodedError(
          "ERR_FONT_API",
          `Font family "${definition.fontFamily}" is declared more than once in this ` +
            "`loadAsync` call.",
        ),
      );
    }
    seen.add(definition.fontFamily);
  }
  return Promise.all(definitions.map((definition) =>
    loadFaces(
      definition.fontFamily,
      () => familyFaces(definition.fontFamily, definition.fontDefinitions),
    )
  )).then(() => {});
}

/**
 * Load fonts: one family and its source, a map of families to sources, or (SDK 58) font
 * families with several faces each.
 *
 * @param fontFamilyOrFontMap A family name, `{ family: source }`, or
 * `[{ fontFamily, fontDefinitions }]`.
 * @param source The source, with a family name.
 * @returns A promise that settles once every font is usable.
 */
export async function loadAsync(fontFamilyOrFontMap: FontMap, source?: FontSource): Promise<void> {
  if (Array.isArray(fontFamilyOrFontMap)) {
    if (source !== undefined) {
      throw new CodedError(
        "ERR_FONT_API",
        "The second argument of `loadAsync()` can only be used with a `string` value as the " +
          "first argument.",
      );
    }
    return await loadFamilies(fontFamilyOrFontMap);
  }
  if (typeof fontFamilyOrFontMap === "string") {
    if (source === undefined) throw new TypeError("loadAsync: pass the font's source");
    return await loadFaces(fontFamilyOrFontMap, () => [resolveSource(source)]);
  }
  await Promise.all(
    Object.entries(fontFamilyOrFontMap).map(([family, src]) =>
      loadFaces(family, () => [resolveSource(src)])
    ),
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

/** Whether a loaded face matches the unload options (no option matches every face). */
function faceMatches(face: FontFace, options: UnloadFontOptions | undefined): boolean {
  if (!options) return true;
  if (options.display !== undefined && face.display !== options.display) return false;
  if (
    options.weight !== undefined &&
    (weightNumber(face.weight) ?? face.weight) !==
      (weightNumber(options.weight) ?? String(options.weight))
  ) {
    return false;
  }
  return options.style === undefined || styleName(face.style) === styleName(options.style);
}

/** Remove the faces of `family` that match `options`; the family goes with its last face. */
function unloadFamily(family: string, options: UnloadFontOptions | undefined): void {
  const faces = loaded().get(family);
  if (!faces) return;
  const kept: FontFace[] = [];
  for (const face of faces) {
    if (faceMatches(face, options)) document.fonts.delete(face);
    else kept.push(face);
  }
  if (kept.length > 0) loaded().set(family, kept);
  else loaded().delete(family);
}

/**
 * Unload fonts: a family's faces (the ones matching `options`: its `weight`, `style` and
 * `display`; every face without options), or a map of families to such options.
 *
 * @param fontFamilyOrFontMap A family, or a map of families to options.
 * @param options Which faces of the one family to remove.
 * @returns A promise that settles once removed.
 */
export function unloadAsync(
  fontFamilyOrFontMap: string | Record<string, UnloadFontOptions>,
  options?: UnloadFontOptions,
): Promise<void> {
  if (typeof fontFamilyOrFontMap === "string") {
    unloadFamily(fontFamilyOrFontMap, options);
    return Promise.resolve();
  }
  for (const [family, familyOptions] of Object.entries(fontFamilyOrFontMap)) {
    unloadFamily(
      family,
      familyOptions && Object.keys(familyOptions).length > 0 ? familyOptions : undefined,
    );
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

/** The family names a font map loads. */
function familiesOf(map: FontMap): string[] {
  if (typeof map === "string") return [map];
  if (Array.isArray(map)) return map.map((definition) => String(definition?.fontFamily));
  return Object.keys(map);
}

/**
 * Load fonts for a component: `[loaded, error]`.
 *
 * @param map A family, `{ family: source }`, or `[{ fontFamily, fontDefinitions }]`.
 * @returns Whether every font is loaded, and the load error if one failed.
 */
export function useFonts(map: FontMap): [boolean, Error | null] {
  const families = familiesOf(map);
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
