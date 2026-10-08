// The `denext/expo/*` shims at build time: which specifiers React Native mode aliases, and how
// the shims join the prebuilt denext runtime.
//
// The shims are client modules that call hooks, so they must share the app's ONE denext
// instance: like `denext/mobile`, each is an entry of the prebuilt runtime graph
// (`expo-<name>.js`), and `denext/expo/<name>` resolves to it. React Native mode maps each
// `expo-*` package in the manifest (plus its known subpaths) to `denext/expo/<name>`, and a
// subpath entry (`expo-file-system/legacy`) to `denext/expo/<name>/<subpath>`.
//
// The component shims render react-native-web's primitives when the app has them. Their
// source imports `src/expo/internal/react-native.ts` (all-`undefined` fallbacks); the prebuild
// leaves that import EXTERNAL as the bare {@link EXPO_RN_BRIDGE}, which the app build then
// points at react-native-web (React Native mode) or at an empty module (any other app).

import { toFileUrl } from "@std/path";
import { EXPO_SHIMS } from "../expo/manifest.ts";

/** The bare specifier the prebuilt shims import react-native-web's primitives through. */
export const EXPO_RN_BRIDGE = "denext-expo-react-native";

/**
 * The subpaths of a shimmed package that resolve to the same shim (`expo/fetch`). A subpath
 * with a shim of its own is a manifest entry instead (`expo-file-system/legacy`). SDK 58's
 * `/next` of the four packages that have one is their main entry again (its `exports` map points
 * both at `build/index.js`), so it is the main shim.
 */
const SHIM_SUBPATHS: Readonly<Record<string, readonly string[]>> = {
  "expo": ["fetch"],
  "expo-calendar": ["next"],
  "expo-contacts": ["next"],
  "expo-file-system": ["next"],
  "expo-media-library": ["next"],
};

/** The shim name of a manifest module path: `"./haptics.ts"` → `"haptics"`. */
function moduleName(module: string): string {
  return module.replace(/^\.\//, "").replace(/\.ts$/, "");
}

/**
 * An `expo`, `expo-*` or `@expo/<name>` specifier, split into package and subpath. A scoped
 * package (`@expo/ui`) is shimmed per subpath (`@expo/ui/swift-ui`), never as a whole.
 */
const EXPO_SPECIFIER = /^(expo(?:-[a-z0-9-]+)?|@expo\/[a-z0-9-]+)(?:\/(.+))?$/;

/** The scope prefix a scoped Expo package's shim name drops (`@expo/ui` → `ui`). */
const EXPO_SCOPE = "@expo/";

/**
 * The `denext/expo/<name>` name of a manifest entry: the module's file name for a package
 * (`expo-haptics` → `haptics`), the package's name plus the subpath for a subpath entry
 * (`expo-file-system/legacy` → `file-system/legacy`,
 * `expo-auth-session/providers/google` → `auth-session/providers/google`), and the unscoped
 * package name plus the subpath for a scoped one (`@expo/ui/swift-ui` → `ui/swift-ui`).
 *
 * @param key The manifest key (`"expo-haptics"`, `"expo-file-system/legacy"`).
 * @returns The name, or null when the key is not in the manifest.
 */
export function expoShimName(key: string): string | null {
  const shim = Object.hasOwn(EXPO_SHIMS, key) ? EXPO_SHIMS[key] : undefined;
  if (!shim) return null;
  const [, pkg, sub] = EXPO_SPECIFIER.exec(key) ?? [];
  if (pkg?.startsWith(EXPO_SCOPE)) {
    return sub === undefined
      ? pkg.slice(EXPO_SCOPE.length)
      : `${pkg.slice(EXPO_SCOPE.length)}/${sub}`;
  }
  if (sub === undefined || !Object.hasOwn(EXPO_SHIMS, pkg)) return moduleName(shim.module);
  return `${moduleName(EXPO_SHIMS[pkg].module)}/${sub}`;
}

/** Every manifest entry's `denext/expo/<name>` name and source module name. */
function shimEntries(): Array<{ name: string; flat: string; module: string }> {
  return Object.entries(EXPO_SHIMS).map(([key, shim]) => {
    const name = expoShimName(key)!;
    return { name, flat: name.replaceAll("/", "-"), module: moduleName(shim.module) };
  });
}

/**
 * The prebuilt-runtime entry points of the shims: `expo-<name>` → the shim's source URL
 * (a subpath shim's `/` flattened to `-`: `expo-file-system-legacy`).
 *
 * @param url Turns a framework-relative path (`src/expo/haptics.ts`) into a URL.
 * @returns The entries, merged into the runtime's entry points.
 */
export function expoRuntimeEntries(url: (rel: string) => string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const { flat, module } of shimEntries()) {
    entries[`expo-${flat}`] = url(`src/expo/${module}.ts`);
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
  for (const { name, flat } of shimEntries()) files[`denext/expo/${name}`] = `expo-${flat}.js`;
  return files;
}

/** The esbuild filter for {@linkcode expoShimSpecifier}'s candidates. */
export const EXPO_FILTER: RegExp = /^(?:expo(?:-[a-z0-9-]+)?|@expo\/ui)(?:\/.+)?$/;

/**
 * The `denext/expo/<name>` specifier an `expo-*` import is aliased to, or null when the
 * package (or that subpath of it) has no shim and resolves normally.
 *
 * @param spec The import specifier (`"expo-haptics"`, `"expo/fetch"`,
 *   `"expo-file-system/legacy"`, `"@expo/ui/swift-ui"`).
 * @returns The shim specifier, or null.
 */
export function expoShimSpecifier(spec: string): string | null {
  const match = EXPO_SPECIFIER.exec(spec);
  if (!match) return null;
  const [, pkg, sub] = match;
  const own = expoShimName(spec);
  if (own !== null) return `denext/expo/${own}`;
  if (sub === undefined || !(SHIM_SUBPATHS[pkg] ?? []).includes(sub)) return null;
  return `denext/expo/${expoShimName(pkg)}`;
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
