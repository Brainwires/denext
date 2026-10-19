/**
 * `denext/build/next-compat` — the SUPPORTED surface of the next-compat (npm-React drop-in)
 * build pipeline, for router-class plugins such as `@denext/pages-router`. The
 * implementation module (`next-compat-build.ts`) also exports test seams (`MOUNT_ID`,
 * `routeToId`, `buildNextCompatPages`, `renderNextCompatPage`) that are NOT part of this
 * contract and may change between minors.
 *
 * @module
 */
export {
  buildNextCompatClientEntries,
  buildNextCompatFlightEntry,
  buildNextCompatModules,
  createNextCompatServerLoader,
  detectNextCompat,
} from "./next-compat-build.ts";
export type {
  AssetLoader,
  AssetOptions,
  BoundaryManifest,
  BoundaryRef,
  BuildNextCompatClientOptions,
  BuildNextCompatFlightOptions,
  BuildNextCompatModulesOptions,
  BuildNextCompatOptions,
  BuiltNextCompatPage,
  CompatReactNativeOptions,
  MdxBuildOptions,
  NextCompatClientEntry,
  NextCompatPageInput,
  NextCompatServerLoaderOptions,
  ProjectPaths,
} from "./next-compat-build.ts";
// denext's server-only guard over a browser bundle's shipped modules (`node:` imports, the
// `server-only` marker, the `Deno` global), for a router plugin whose client bundle carries
// modules it compiled itself (it passes their compiled source).
export { findServerOnlyLeaks } from "./server-only-scan.ts";
// The bytes a `?url`-imported stylesheet serves (a Tailwind input compiled with the project's
// Tailwind), for a router plugin's {@link AssetOptions.compileCss}.
export { compileCssAsset } from "./css-url.ts";
export type { ServerOnlyLeak, ServerOnlySignal } from "./server-only-scan.ts";
