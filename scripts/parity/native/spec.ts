// The specifier catalog for the react-native / expo signature-parity targets — the
// mobile-side twin of `scripts/parity/spec.ts` (React/ReactDOM/Next).
//
// Two targets, both baseline-gated exactly like the React catalog (a frozen real-side
// snapshot + a known-gaps ledger; see `../diff.ts` / `../waivers.ts`):
//
//   • react-native — NAME-LEVEL runtime parity. EXPECTED = the `react-native` package's
//     own bundled `.d.ts` export names (pinned to T3's version); ACTUAL = the RUNTIME
//     exports of `react-native-web` (`Object.keys` of its ESM namespace), which is exactly
//     what `src/build/react-native.ts` aliases `react-native` to (see `./runtime.ts`). The
//     gate flags react-native runtime values that the alias does not provide at runtime.
//
//   • expo — driven by `src/expo/manifest.ts` (`EXPO_SHIMS`). For each shim, denext's
//     `denext/expo/<name>` file (`src/expo/<name>.ts`) is diffed against the pinned
//     `npm:<key>@<pinned>` real surface, minus the shim's own `omitted` list. A subpath key
//     (`expo-file-system/legacy`) installs its package and resolves the subpath. The manifest
//     and `src/expo/*` are built by a peer and may be absent — the harness SKIPS the expo
//     target (green) until they land, so shims can be shipped incrementally.

import type { DenextTarget } from "../extract-denext.ts";
import type { RealTarget } from "../extract-real.ts";

// ── react-native target ────────────────────────────────────────────────────────────

/** The public specifier RN/Expo apps import. */
export const REACT_NATIVE_SPECIFIER = "react-native";
/** The React Native package whose bundled `.d.ts` defines the EXPECTED export names. */
export const REACT_NATIVE_PACKAGE = "react-native";
/** T3's pinned React Native version — the EXPECTED-surface source. */
export const REACT_NATIVE_PIN = "0.86.3";
/** The package `src/build/react-native.ts` aliases every `react-native` import to (ACTUAL runtime). */
export const REACT_NATIVE_WEB_PACKAGE = "react-native-web";
/** The pinned react-native-web whose runtime namespace is the ACTUAL surface (see runtime.ts). */
export const REACT_NATIVE_WEB_PIN = "0.21.2";

/** EXPECTED-side target: `react-native` ↔ the `react-native` package's own bundled types. */
export const REACT_NATIVE_EXPECTED_TARGET: RealTarget = {
  specifier: REACT_NATIVE_SPECIFIER,
  real: REACT_NATIVE_PACKAGE,
};

/** Packages installed to capture the EXPECTED surface. */
export const REACT_NATIVE_EXPECTED_PACKAGES = [REACT_NATIVE_PACKAGE];

/** npm dependency map for the EXPECTED-surface install (pinned to T3's react-native). */
export function reactNativeExpectedDeps(): Record<string, string> {
  return { [REACT_NATIVE_PACKAGE]: REACT_NATIVE_PIN };
}

// ── expo target (manifest-driven) ────────────────────────────────────────────────────

/** One entry of `src/expo/manifest.ts`'s `EXPO_SHIMS` (re-declared so the harness type-checks
 * without the peer's file on disk; must stay structurally identical to the manifest's type). */
export interface ExpoShim {
  readonly module: string;
  readonly pinned: string;
  readonly status: "full" | "partial" | "stub";
  readonly omitted?: readonly string[];
  readonly notes?: string;
}

/**
 * The expo shim registry, keyed by npm package name (e.g. `"expo-haptics"`), or by package
 * plus subpath for a subpath's own shim (`"expo-file-system/legacy"`).
 */
export type ExpoShims = Readonly<Record<string, ExpoShim>>;

/** `src/expo/manifest.ts`, repo-root-relative. Read-only — a peer owns this file. */
export const EXPO_MANIFEST_REL = "src/expo/manifest.ts";

/**
 * Load `EXPO_SHIMS` from `src/expo/manifest.ts`, or `null` when the manifest does not
 * exist yet (the peer has not landed it). Never throws on absence — that is the SKIP path.
 *
 * @param root Repo root (absolute).
 */
export async function loadExpoShims(root: string): Promise<ExpoShims | null> {
  const abs = `${root}/${EXPO_MANIFEST_REL}`;
  try {
    await Deno.stat(abs);
  } catch {
    return null; // manifest not found → caller skips the expo target
  }
  const mod = await import(`file://${abs}`) as { EXPO_SHIMS?: ExpoShims };
  return mod.EXPO_SHIMS ?? null;
}

/** The `src/expo/<name>.ts` file backing a shim, from its `module` (`"./haptics.ts"`). */
export function expoDenextFile(shim: ExpoShim): string {
  return `src/expo/${shim.module.replace(/^\.\//, "")}`;
}

/**
 * The npm package a manifest key belongs to: the key itself, or the part before a subpath
 * (`expo-file-system/legacy` → `expo-file-system`).
 */
export function expoPackageOf(key: string): string {
  const parts = key.split("/");
  return key.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** The npm packages the expo shims stand in for (a subpath shim's package once). */
export function expoPackages(shims: ExpoShims): string[] {
  return [...new Set(Object.keys(shims).map(expoPackageOf))];
}

/**
 * Real-side targets for the expo shims: `<key>` ↔ `npm:<key>` (version pinned at install); a
 * subpath key is resolved through its package's `exports` map.
 */
export function expoRealTargets(shims: ExpoShims): RealTarget[] {
  return Object.keys(shims).map((key) => ({ specifier: key, real: key }));
}

/** denext-side targets for the expo shims: `<key>` ↔ `src/expo/<name>.ts`. */
export function expoDenextTargets(shims: ExpoShims): DenextTarget[] {
  return Object.entries(shims).map(([key, shim]) => ({
    specifier: key,
    denext: expoDenextFile(shim),
  }));
}

/** `<package>@<pinned>` install specs for the real-side npm install. */
export function expoInstallDeps(shims: ExpoShims): Record<string, string> {
  return Object.fromEntries(
    Object.entries(shims).map(([key, s]) => [expoPackageOf(key), s.pinned]),
  );
}

// ── committed fixture locations (all under scripts/parity/native, per the edit scope) ──

const DIR = "scripts/parity/native/baselines";

/** Frozen react-native-web surface baseline. */
export const rnBaselinePath = (root: string) => `${root}/${DIR}/react-native.baseline.json`;
/** Frozen per-expo-package surface baseline. */
export const expoBaselinePath = (root: string) => `${root}/${DIR}/expo.baseline.json`;
/** The native known-gaps ledger (react-native + expo). */
export const knownGapsPath = (root: string) => `${root}/${DIR}/known-gaps.json`;
