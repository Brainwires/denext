// React Native mode's embedded fonts (`reactNative.fonts`): the font files an Expo app embeds in
// its native binary with the expo-font config plugin (`plugins: [["expo-font", { fonts: […] }]]`),
// which the app then uses by family name without `useFonts`. A web build has no binary to embed
// them in, so the SPA shell gets an `@font-face` rule per family and the files are served under
// the client prefix (`<prefix>fonts/<file>`): copied into the build's client directory (and so
// into an export), and answered straight from the package by the dev server. `denext migrate
// --from expo` writes the option from the app config.

import { copy } from "@std/fs/copy";
import { basename, isAbsolute, join, resolve } from "@std/path";
import { type DenextConfig, reactNativeOptions } from "../server/config.ts";
import { resolveNodeFrom } from "./next-compat.ts";

/** One embedded font, resolved. */
export interface ReactNativeFont {
  /** The family the app names in `fontFamily`. */
  readonly family: string;
  /** The file on disk. */
  readonly file: string;
  /** Its name under `<prefix>fonts/`. */
  readonly name: string;
}

/** The CSS `format()` of a font file, by extension. */
function formatOf(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return ({ ttf: "truetype", otf: "opentype", woff: "woff", woff2: "woff2" } as Record<
    string,
    string
  >)[ext] ?? "truetype";
}

/**
 * The fonts `reactNative.fonts` names, each resolved from the project: a `./` path against the
 * project, an absolute path as is, anything else as a package subpath
 * (`@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf`). A file that does not resolve
 * fails, naming it.
 *
 * @param config The app config.
 * @param projectDir The project root.
 */
export async function resolveReactNativeFonts(
  config: DenextConfig | null | undefined,
  projectDir: string,
): Promise<ReactNativeFont[]> {
  const fonts = reactNativeOptions(config)?.fonts;
  if (!fonts) return [];
  const out: ReactNativeFont[] = [];
  for (const [family, src] of Object.entries(fonts)) {
    const file = src.startsWith(".") || isAbsolute(src)
      ? resolve(projectDir, src)
      : await resolveNodeFrom(projectDir, src);
    if (!file || !(await isFile(file))) {
      throw new Error(`denext: reactNative.fonts["${family}"]: ${src} does not resolve to a file`);
    }
    out.push({ family, file, name: basename(file) });
  }
  return out;
}

/** Whether `path` is a file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/**
 * The `<style>` with one `@font-face` per font (`font-display: block`, as a font embedded in a
 * native binary is there before the first frame), or "" without fonts.
 *
 * @param fonts The resolved fonts.
 * @param prefix The client prefix the files are served under.
 */
export function fontFaceStyle(fonts: readonly ReactNativeFont[], prefix: string): string {
  if (fonts.length === 0) return "";
  const rules = fonts.map((f) =>
    `@font-face{font-family:${JSON.stringify(f.family)};src:url(${
      JSON.stringify(`${prefix}fonts/${f.name}`)
    }) format("${formatOf(f.name)}");font-display:block}`
  );
  return `\n    <style>${rules.join("")}</style>`;
}

/** Copy the fonts into `clientDir/fonts/` (a build's client output). */
export async function copyReactNativeFonts(
  fonts: readonly ReactNativeFont[],
  clientDir: string,
): Promise<void> {
  if (fonts.length > 0) await Deno.mkdir(join(clientDir, "fonts"), { recursive: true });
  for (const f of fonts) {
    await copy(f.file, join(clientDir, "fonts", f.name), { overwrite: true });
  }
}

/** The font `pathname` asks for under `prefix`, or undefined (the dev server's lookup). */
export function fontFor(
  fonts: readonly ReactNativeFont[],
  pathname: string,
  prefix: string,
): ReactNativeFont | undefined {
  if (!pathname.startsWith(`${prefix}fonts/`)) return undefined;
  const name = pathname.slice(`${prefix}fonts/`.length);
  return fonts.find((f) => f.name === name);
}
