// The ACTUAL side of the react-native target: the RUNTIME exports of react-native-web —
// `Object.keys` of the module namespace of `react-native-web@0.21.2`, imported exactly as
// `src/build/react-native.ts`'s alias delivers it. This is what a `react-native` import
// actually resolves to at runtime on the web, so StyleSheet / Platform / Animated /
// Dimensions and every other component are counted even though react-native-web ships no
// TypeScript types.
//
// NAME-LEVEL only: a runtime module namespace carries no signature/type information, so
// each key is recorded as a plain runtime value (`isValue: true`). The diff therefore
// checks presence of names, never arity or members, for this target.

import type { Surface, SurfaceSymbol } from "../types.ts";

/**
 * Build the ACTUAL surface from react-native-web's live runtime namespace.
 *
 * @param specifier The public specifier to tag the surface with (`"react-native"`).
 * @returns A name-level {@link Surface}: one value symbol per runtime export key.
 */
export async function rnwRuntimeSurface(specifier: string): Promise<Surface> {
  // The literal npm specifier is what `src/build/react-native.ts` aliases react-native to;
  // this parity script is not part of the shipped package graph, so the inline `npm:` is fine.
  // deno-lint-ignore no-import-prefix
  const ns = await import("npm:react-native-web@0.21.2") as Record<string, unknown>;
  const symbols: Record<string, SurfaceSymbol> = {};
  for (const name of Object.keys(ns)) {
    if (name === "default" || name.startsWith("__")) continue;
    symbols[name] = { name, kind: "value", isValue: true, isType: false };
  }
  return { specifier, resolved: true, symbols };
}
