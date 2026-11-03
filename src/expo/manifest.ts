/**
 * The `denext/expo/*` shim manifest: which `expo-*` package each shim stands in for, the
 * version its API was matched against (a large real-world Expo app, Expo SDK 58), how complete
 * it is, and what it leaves out.
 *
 * React Native mode (`reactNative` in `denext.config.ts`) aliases every package listed here
 * to its shim; a package not listed resolves normally. `scripts/parity` checks each shim's
 * exports against the pinned package's types. Pure data, decoded on first read from a
 * Brotli-packed copy (`node:zlib`; tooling metadata, server-side only).
 *
 * @example
 * ```ts
 * import { EXPO_SHIMS } from "denext/expo/manifest";
 *
 * for (const [pkg, shim] of Object.entries(EXPO_SHIMS)) console.log(pkg, shim.status);
 * ```
 *
 * @module
 */

/** One shim. */
export interface ExpoShim {
  /** The shim module, relative to `src/expo` (`"./haptics.ts"`). */
  readonly module: string;
  /** The package version its API was matched against. */
  readonly pinned: string;
  /**
   * `full`: the package's API, backed for real. `partial`: the commonly used API, with
   * `omitted` exports or documented differences. `stub`: native-only or config-only, loads
   * but does nothing.
   */
  readonly status: "full" | "partial" | "stub";
  /**
   * Exports deliberately not provided. `Name.member` names a static or member of an export
   * that the shim leaves out (`Asset.byHash`).
   */
  readonly omitted?: readonly string[];
  /** Why (sync JSI APIs, native-only, …). */
  readonly notes?: string;
}

export { EXPO_SHIMS } from "./manifest-data.packed.ts";
