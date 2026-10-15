// The denext config file names, as a dependency-free module (the CLI's help reads them without
// loading the project resolver in paths.ts, which re-exports this list).

/**
 * The denext config file names, in the order the loader resolves them — the one list the
 * loader, the UI's config editor and the plugin manager all probe.
 */
export const CONFIG_FILES: readonly string[] = [
  "denext.config.ts",
  "denext.config.mts",
  "denext.config.js",
  "denext.config.mjs",
];
