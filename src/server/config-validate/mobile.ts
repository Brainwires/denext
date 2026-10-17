// The phone and React Native parts of denext.config: the iOS scroll shim, list engines, platform
// file extensions, `mobile.flavors` and `reactNative`.

import type { DenextConfig } from "../config.ts";
import { editDistance } from "../../utils/edit-distance.ts";
import { COMMUNITY_ALIASES } from "../../react-native-compat/manifest.ts";
import type { Fail } from "./shared.ts";

/** `momentumSafeScroll` is an on/off switch; absent keeps the iOS scroll shim on. */
export function validateMomentumSafeScroll(value: unknown, fail: Fail): void {
  if (value !== undefined && typeof value !== "boolean") {
    fail("momentumSafeScroll", "must be a boolean");
  }
}

/** `lists` names the engine of the DOM list packages: `"denext"` or `"library"`. */
export function validateLists(value: unknown, fail: Fail): void {
  if (value !== undefined && value !== "denext" && value !== "library") {
    fail("lists", 'must be "denext" or "library"');
  }
}

/** `platformExtensions` is a boolean or `{ native?: boolean, osFiles?: boolean }`. */
export function validatePlatformExtensions(value: unknown, fail: Fail): void {
  if (value === undefined || typeof value === "boolean") return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("platformExtensions", "must be a boolean or `{ native?: boolean, osFiles?: boolean }`");
    return;
  }
  for (const [key, v] of Object.entries(value)) {
    if (key !== "native" && key !== "osFiles") {
      fail(`platformExtensions.${key}`, "is not a known option (native, osFiles)");
    } else if (typeof v !== "boolean") fail(`platformExtensions.${key}`, "must be a boolean");
  }
}

/**
 * `resolveAlias`: specifier → a target string, or `{ to: string, except?: string[] }`.
 *
 * @param value The configured value.
 * @param fail Reports a problem.
 */
export function validateResolveAlias(value: unknown, fail: Fail): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("resolveAlias", "must be an object of specifier → alias");
    return;
  }
  for (const [spec, alias] of Object.entries(value)) {
    validateAliasEntry(`resolveAlias[${JSON.stringify(spec)}]`, alias, fail);
  }
}

/** One `resolveAlias` entry: a target string, or the object form. */
function validateAliasEntry(field: string, alias: unknown, fail: Fail): void {
  if (typeof alias === "string") {
    if (alias === "") fail(field, "must name a module");
    return;
  }
  if (typeof alias !== "object" || alias === null || Array.isArray(alias)) {
    fail(field, "must be a string or `{ to: string, except?: string[] }`");
    return;
  }
  const { to, except, ...rest } = alias as Record<string, unknown>;
  for (const key of Object.keys(rest)) {
    fail(`${field}.${key}`, "is not a known option (to, except)");
  }
  if (typeof to !== "string" || to === "") fail(`${field}.to`, "must name a module");
  if (except !== undefined && !isPackageList(except)) {
    fail(`${field}.except`, "must be an array of package names");
  }
}

/** Whether `value` is an array of non-empty strings. */
function isPackageList(value: unknown): boolean {
  return Array.isArray(value) && value.every((e) => typeof e === "string" && e !== "");
}

/** The string fields of a `mobile.flavors` entry. */
const FLAVOR_STRINGS = [
  "appId",
  "appIdSuffix",
  "appName",
  "serverUrl",
  "icon",
  "splash",
  "backgroundColor",
] as const;

/** A value-shape rule for one `mobile.flavors` field: the problem, or null. */
const FLAVOR_RULES: Record<string, (v: string) => string | null> = {
  appId: (v) =>
    /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(v)
      ? null
      : "must be a reverse-DNS id like com.example.app.beta",
  appIdSuffix: (v) =>
    /^(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(v) ? null : 'must start with "." (e.g. ".staging")',
  serverUrl: (v) => (URL.canParse(v) ? null : "must be an absolute URL"),
  backgroundColor: (v) =>
    /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? null : "must be a hex colour like #0f172a",
};

/** Whether `value` is a plain object of strings. */
function isStringRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string");
}

/** One `mobile.flavors.<name>` entry. */
function validateMobileFlavor(name: string, value: unknown, fail: Fail): void {
  const at = `mobile.flavors.${name}`;
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return fail(at, "names a flavor with lowercase letters, digits and `-` only");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(at, "must be an object");
  }
  const flavor = value as Record<string, unknown>;
  for (const key of FLAVOR_STRINGS) {
    const field = flavor[key];
    if (field === undefined) continue;
    const problem = typeof field === "string" ? FLAVOR_RULES[key]?.(field) : "must be a string";
    if (problem) fail(`${at}.${key}`, problem);
  }
  if (flavor.env !== undefined && !isStringRecord(flavor.env)) {
    fail(`${at}.env`, "must be an object of string values");
  }
}

/** `mobile`: `{ flavors?: { <name>: flavor } }`. */
export function validateMobile(value: unknown, fail: Fail): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("mobile", "must be an object");
  }
  const flavors = (value as Record<string, unknown>).flavors;
  if (flavors === undefined) return;
  if (typeof flavors !== "object" || flavors === null || Array.isArray(flavors)) {
    return fail("mobile.flavors", "must be an object of flavor name → settings");
  }
  for (const [name, flavor] of Object.entries(flavors)) validateMobileFlavor(name, flavor, fail);
}

/**
 * `reactNative`: `true`/`false` or an options object, and only in SPA mode — the resolve mode
 * applies to the SPA bundle, so anywhere else it would be silently ignored.
 */
export function validateReactNative(config: DenextConfig, fail: Fail): void {
  const value: unknown = config.reactNative;
  if (value === undefined || value === false) return;
  const isObject = typeof value === "object" && value !== null && !Array.isArray(value);
  if (value !== true && !isObject) fail("reactNative", "must be a boolean or an options object");
  for (const key of ["rootStyle", "expoShims"] as const) {
    const option = isObject ? (value as Record<string, unknown>)[key] : undefined;
    if (option !== undefined && typeof option !== "boolean") {
      fail(`reactNative.${key}`, "must be a boolean");
    }
  }
  if (isObject) validateReactNativeObject(value as Record<string, unknown>, fail);
  if (config.mode !== "spa") {
    validateAppRouterReactNative(config, isObject ? value as Record<string, unknown> : {}, fail);
  }
}

/**
 * `reactNative` on the App Router: it builds through the compat (esbuild) pipeline, so it
 * cannot sit beside `compatibilityMode: false`; `fonts` is the SPA shell's (its `@font-face`
 * rules go in the shell document).
 */
function validateAppRouterReactNative(
  config: DenextConfig,
  options: Record<string, unknown>,
  fail: Fail,
): void {
  if (config.compatibilityMode === false) {
    fail(
      "reactNative",
      "builds through the compat (esbuild) pipeline on the App Router (its react-native → " +
        "react-native-web resolvers live there) — remove `compatibilityMode: false`",
    );
  }
  if (options.fonts !== undefined) {
    fail(
      "reactNative.fonts",
      'applies only in SPA mode (`mode: "spa"`), whose shell declares the fonts — on the App ' +
        "Router load them with `next/font/local` or an `@font-face` stylesheet",
    );
  }
}

/** `reactNative`'s object options: `lists`, `desktopPackage`, `aliases`, `uniwind`, `fonts`. */
function validateReactNativeObject(value: Record<string, unknown>, fail: Fail): void {
  if (value.lists !== undefined && value.lists !== "denext" && value.lists !== "library") {
    fail("reactNative.lists", 'must be "denext" or "library"');
  }
  const desktop = value.desktopPackage;
  if (
    desktop !== undefined && desktop !== "react-native-macos" && desktop !== "react-native-windows"
  ) {
    fail("reactNative.desktopPackage", 'must be "react-native-macos" or "react-native-windows"');
  }
  validateReactNativeAliases(value.aliases, fail);
  validateUniwind(value.uniwind, fail);
  validateRnFonts(value.fonts, fail);
}

/** `reactNative.fonts`: an object of family name → file. */
function validateRnFonts(value: unknown, fail: Fail): void {
  if (value === undefined) return;
  const ok = typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.entries(value).every(([k, v]) => k !== "" && typeof v === "string" && v !== "");
  if (!ok) fail("reactNative.fonts", "must be an object of family name → font file");
}

/** `reactNative.uniwind`: a boolean or `{ extraThemes: string[] }`. */
function validateUniwind(value: unknown, fail: Fail): void {
  if (value === undefined || typeof value === "boolean") return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("reactNative.uniwind", "must be a boolean or { extraThemes }");
    return;
  }
  const themes = (value as { extraThemes?: unknown }).extraThemes;
  if (
    themes !== undefined &&
    !(Array.isArray(themes) && themes.every((t) => typeof t === "string" && t !== ""))
  ) {
    fail("reactNative.uniwind.extraThemes", "must be an array of theme names");
  }
}

/**
 * `reactNative.aliases`: a map of aliased package names (`COMMUNITY_ALIASES`) to booleans. An
 * unknown name is a mistake (the alias it means to turn off stays on), so it fails with the
 * closest package named.
 */
function validateReactNativeAliases(value: unknown, fail: Fail): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("reactNative.aliases", "must be an object of package name → boolean");
    return;
  }
  const known = Object.keys(COMMUNITY_ALIASES);
  for (const [pkg, on] of Object.entries(value)) {
    if (typeof on !== "boolean") fail(`reactNative.aliases.${pkg}`, "must be a boolean");
    if (known.includes(pkg)) continue;
    const near = known.map((k) =>
      [k, editDistance(pkg, k)] as const
    ).sort((a, b) => a[1] - b[1])[0];
    const hint = near && near[1] <= 3 ? ` (did you mean "${near[0]}"?)` : "";
    fail(`reactNative.aliases.${pkg}`, `is not an aliased package${hint}`);
  }
}
