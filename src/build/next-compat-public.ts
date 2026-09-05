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
  MdxBuildOptions,
  NextCompatClientEntry,
  NextCompatPageInput,
  NextCompatServerLoaderOptions,
  ProjectPaths,
} from "./next-compat-build.ts";
