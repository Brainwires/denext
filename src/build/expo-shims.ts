// The `denext/expo/*` shims at build time: which specifiers React Native mode aliases, and how
// the shims join the prebuilt denext runtime.
//
// The shims are client modules that call hooks, so they must share the app's ONE denext
// instance: like `denext/mobile`, each is an entry of the prebuilt runtime graph
// (`expo-<name>.js`), and `denext/expo/<name>` resolves to it. React Native mode maps each
// `expo-*` package in the manifest (plus its known subpaths) to `denext/expo/<name>`.
//
// The component shims render react-native-web's primitives when the app has them. Their
// source imports `src/expo/internal/react-native.ts` (all-`undefined` fallbacks); the prebuild
// leaves that import EXTERNAL as the bare {@link EXPO_RN_BRIDGE}, which the app build then
// points at react-native-web (React Native mode) or at an empty module (any other app).

import { toFileUrl } from "@std/path";
import { EXPO_SHIMS } from "../expo/manifest.ts";

/** The bare specifier the prebuilt shims import react-native-web's primitives through. */
export const EXPO_RN_BRIDGE = "denext-expo-react-native";

/** The subpaths of a shimmed package that resolve to the same shim (`expo/fetch`). */
const SHIM_SUBPATHS: Readonly<Record<string, readonly string[]>> = {
  "expo": ["fetch"],
};

/** The shim name of a manifest module path: `"./haptics.ts"` → `"haptics"`. */
function shimName(module: string): string {
  return module.replace(/^\.\//, "").replace(/\.ts$/, "");
}

/**
 * The prebuilt-runtime entry points of the shims: `expo-<name>` → the shim's source URL.
 *
 * @param url Turns a framework-relative path (`src/expo/haptics.ts`) into a URL.
 * @returns The entries, merged into the runtime's entry points.
 */
export function expoRuntimeEntries(url: (rel: string) => string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const shim of Object.values(EXPO_SHIMS)) {
    entries[`expo-${shimName(shim.module)}`] = url(`src/expo/${shimName(shim.module)}.ts`);
  }
  return entries;
}

/**
 * `denext/expo/<name>` → its prebuilt runtime file (`expo-<name>.js`), for every shim.
 *
 * @returns The specifier → file map.
 */
export function expoRuntimeFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const shim of Object.values(EXPO_SHIMS)) {
    const name = shimName(shim.module);
    files[`denext/expo/${name}`] = `expo-${name}.js`;
  }
  return files;
}

/** An `expo` or `expo-*` specifier, split into package and subpath. */
const EXPO_SPECIFIER = /^(expo(?:-[a-z0-9-]+)?)(?:\/(.+))?$/;

/** The esbuild filter for {@linkcode expoShimSpecifier}'s candidates. */
export const EXPO_FILTER: RegExp = /^expo(?:-[a-z0-9-]+)?(?:\/.+)?$/;

/**
 * The `denext/expo/<name>` specifier an `expo-*` import is aliased to, or null when the
 * package (or that subpath of it) has no shim and resolves normally.
 *
 * @param spec The import specifier (`"expo-haptics"`, `"expo/fetch"`).
 * @returns The shim specifier, or null.
 */
export function expoShimSpecifier(spec: string): string | null {
  const match = EXPO_SPECIFIER.exec(spec);
  if (!match) return null;
  const [, pkg, sub] = match;
  const shim = Object.hasOwn(EXPO_SHIMS, pkg) ? EXPO_SHIMS[pkg] : undefined;
  if (!shim) return null;
  if (sub !== undefined && !(SHIM_SUBPATHS[pkg] ?? []).includes(sub)) return null;
  return `denext/expo/${shimName(shim.module)}`;
}

/**
 * Whether an import of `path` from `importer` is the shims' react-native-web bridge
 * (`src/expo/internal/react-native.ts`), which the prebuild leaves external as
 * {@linkcode EXPO_RN_BRIDGE}.
 *
 * @param path The import path as written.
 * @param importer The importing module (a path or URL).
 */
export function isExpoBridgeImport(path: string, importer: string): boolean {
  if (!path.endsWith("react-native.ts") || !importer.includes("/src/expo/")) return false;
  try {
    const base = /^[a-z][a-z0-9+.-]*:\/\//i.test(importer) ? importer : toFileUrl(importer).href;
    return new URL(path, base).pathname.endsWith("/src/expo/internal/react-native.ts");
  } catch {
    return false;
  }
}
