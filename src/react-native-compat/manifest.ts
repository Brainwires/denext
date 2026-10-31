/**
 * The community React Native packages React Native mode (`reactNative` in
 * `denext.config.ts`) resolves to denext implementations: which package each entry stands in
 * for, what implements it, the version its API was matched against, how complete it is and
 * what it leaves out.
 *
 * Every entry is on by default; `reactNative: { aliases: { "<package>": false } }` resolves
 * that package normally again. A package not listed here always resolves normally.
 * `scripts/parity/native` checks each runtime stand-in's exports against the pinned package.
 * Pure data, decoded on first read from a Brotli-packed copy (`node:zlib`; server-side only).
 *
 * @module
 */

/** How an aliased package is provided. */
export type CommunityAliasKind =
  /**
   * The specifiers resolve to a prebuilt runtime module,
   * `denext/react-native-compat/<module name>` (`src/react-native-compat/<module>`).
   */
  | "runtime"
  /**
   * A generated module re-exports the real package and replaces its
   * `create*Navigator` with one drawn by `denext/navigation` (the package must be installed).
   */
  | "navigator"
  /** A build transform, not a module (`.svg` imports compiled to components). */
  | "transform";

/**
 * Exports generated at build time by a runtime factory called with a package the app has
 * installed: `import * as dep from "<from>"; export const { …exports } = factory(dep)`.
 */
export interface CommunityAliasFactory {
  /** The app's package passed to the factory as a namespace. */
  readonly from: string;
  /** The runtime module's factory export. */
  readonly factory: string;
  /** The names the factory's result provides (they shadow the runtime module's own). */
  readonly exports: readonly string[];
  /**
   * `true`: when `from` does not resolve, skip the factory and keep the runtime module's own
   * exports of those names (a fallback). `false`: the package is required.
   */
  readonly optional: boolean;
}

/** One aliased community package. */
export interface CommunityAlias {
  /** How it is provided. */
  readonly kind: CommunityAliasKind;
  /**
   * `runtime`: the stand-in module, relative to `src/react-native-compat` (`"./webview.ts"`).
   * `navigator`: the `denext/navigation` factory (`createNativeStackNavigatorFactory`).
   * `transform`: empty.
   */
  readonly module: string;
  /** Subpaths of the package that resolve to the same module (`["lib/module/index"]`). */
  readonly subpaths?: readonly string[];
  /** Exports generated from an installed package ({@linkcode CommunityAliasFactory}). */
  readonly generated?: CommunityAliasFactory;
  /** The package version its API was matched against. */
  readonly pinned: string;
  /**
   * `full`: the package's API, backed for real. `partial`: the commonly used API, with
   * `omitted` exports or documented differences. `stub`: loads, and does little or nothing.
   */
  readonly status: "full" | "partial" | "stub";
  /** What implements it, for the docs table (`"denext/mobile secureStore + biometrics"`). */
  readonly implementation: string;
  /**
   * The `denext mobile add` capabilities its native half needs in the Capacitor shell (`denext
   * migrate --from expo` suggests them).
   */
  readonly capabilities?: readonly string[];
  /** Runtime exports deliberately not provided (`Name.member` names a static or member). */
  readonly omitted?: readonly string[];
  /** The differences that matter. */
  readonly notes?: string;
}

export { COMMUNITY_ALIASES } from "./manifest-data.packed.ts";
