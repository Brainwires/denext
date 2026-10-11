// Where a Capacitor project keeps its native projects. Capacitor reads `ios.path` and
// `android.path` from capacitor.config.* (defaults `ios` and `android`) and puts the Xcode
// project in `<ios.path>/App` and the Gradle app module in `<android.path>/app`. denext's mobile
// commands name their native files by the default layout (`ios/App/App/Info.plist`,
// `android/app/src/main/AndroidManifest.xml`); `nativeJoin` maps such a path into the project's
// own layout, read once per command by `loadNativeDirs`.

import { join, resolve } from "@std/path";
import { capacitorConfigFile, readCapacitorConfig } from "./capacitor-config.ts";

/** A Capacitor project's native project folders, relative to its root (POSIX separators). */
export interface NativeDirs {
  /** `ios.path`, default `ios`. */
  readonly ios: string;
  /** `android.path`, default `android`. */
  readonly android: string;
}

/** Capacitor's defaults. */
export const DEFAULT_NATIVE_DIRS: NativeDirs = { ios: "ios", android: "android" };

/** The dirs `loadNativeDirs` last read, by resolved project root. */
const loaded = new Map<string, NativeDirs>();

/** A platform section's `path`, normalized, or `fallback` when unset or not a relative path. */
function platformPath(section: unknown, fallback: string): string {
  const path = (section as { path?: unknown } | null | undefined)?.path;
  if (typeof path !== "string") return fallback;
  const slashed = path.replaceAll("\\", "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) return fallback;
  const parts: string[] = [];
  for (const part of slashed.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.pop() === undefined) return fallback; // outside the project
    } else parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : fallback;
}

/**
 * Read `ios.path` / `android.path` from the Capacitor config at `root` and remember them for
 * {@link nativeJoin}. Each command's entry calls it, so an edited config is picked up on the
 * next run. A missing or unreadable config means the defaults.
 */
export async function loadNativeDirs(root: string): Promise<NativeDirs> {
  let config: Record<string, unknown> | null = null;
  const file = await capacitorConfigFile(root);
  if (file) {
    try {
      config = await readCapacitorConfig(file, await Deno.readTextFile(file));
    } catch { /* unreadable: the defaults */ }
  }
  const dirs = nativeDirsOf(config);
  loaded.set(resolve(root), dirs);
  return dirs;
}

/** The native dirs a parsed Capacitor config names (`null`: none, so the defaults). */
export function nativeDirsOf(config: Record<string, unknown> | null | undefined): NativeDirs {
  return {
    ios: platformPath(config?.ios, DEFAULT_NATIVE_DIRS.ios),
    android: platformPath(config?.android, DEFAULT_NATIVE_DIRS.android),
  };
}

/** The native dirs of `root` as last loaded, else Capacitor's defaults. */
function nativeDirs(root: string): NativeDirs {
  return loaded.get(resolve(root)) ?? DEFAULT_NATIVE_DIRS;
}

/**
 * `rel`, a path in Capacitor's default layout (`ios/…`, `android/…`; POSIX), in the layout of
 * the project at `root`. Any other path is returned as is.
 */
export function nativeRel(root: string, rel: string): string {
  const m = /^(ios|android)(?=\/|$)/.exec(rel);
  if (!m) return rel;
  const dir = nativeDirs(root)[m[1] as keyof NativeDirs];
  return dir === m[1] ? rel : dir + rel.slice(m[1].length);
}

/** `join(root, nativeRel(root, rel), ...more)`. */
export function nativeJoin(root: string, rel: string, ...more: string[]): string {
  return join(root, nativeRel(root, rel), ...more);
}

/**
 * A default-layout path at the start of a word: `ios/…` or `android/…`, not inside a longer
 * path (`native/ios/…`), a package name (`@capacitor/ios`) or another word (`my-ios/…`).
 */
const DEFAULT_LAYOUT_PATH = /(?<![\w.@/\\-])(ios|android)(?=\/)/g;

/**
 * `text`, a message naming files in Capacitor's default layout (`ios/App/App/Info.plist: set
 * …`, `no ios/ or android/ project`), with each such path moved into the layout of the project
 * at `root`. Paths already in the project's layout are left alone.
 */
export function nativeText(root: string, text: string): string {
  const dirs = nativeDirs(root);
  if (dirs.ios === DEFAULT_NATIVE_DIRS.ios && dirs.android === DEFAULT_NATIVE_DIRS.android) {
    return text;
  }
  return text.replace(DEFAULT_LAYOUT_PATH, (m) => dirs[m as keyof NativeDirs]);
}

/** Map every message of `list` through {@link nativeText}, in place; returns `list`. */
export function nativeTexts<T extends string[]>(root: string, list: T): T {
  for (let i = 0; i < list.length; i++) list[i] = nativeText(root, list[i]);
  return list;
}
