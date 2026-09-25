// `denext/mobile`'s web SQLite engine at build time. The capability (src/mobile/sqlite.ts)
// dynamically imports src/mobile/sqlite-wasm.ts, a fallback whose URLs are null. The runtime
// prebuild leaves that import EXTERNAL as the bare {@link SQLITE_WASM_BRIDGE}; the app build
// then resolves the bare specifier to a generated module. When the app has
// `@sqlite.org/sqlite-wasm` installed, that module emits the package's `dist/index.mjs` and
// `dist/sqlite3.wasm` as assets (esbuild's file loader) and exports their URLs; otherwise it
// exports nulls and the capability explains what to install. denext itself never ships the
// engine: the app installs it, as it installs react-native-web.

import { dirname, join, toFileUrl } from "@std/path";
import type * as esbuild from "esbuild";

/** The bare specifier the prebuilt runtime imports the engine's URLs through. */
export const SQLITE_WASM_BRIDGE = "denext-sqlite-wasm";

/** The npm package that is the web engine. */
const SQLITE_WASM_PACKAGE = "@sqlite.org/sqlite-wasm";

/** The esbuild namespace of the generated bridge module. */
const BRIDGE_NAMESPACE = "denext-sqlite-wasm";
/** The esbuild namespace of the engine's two files (loaded with the file loader). */
const ASSET_NAMESPACE = "denext-sqlite-wasm-asset";
/** The prefix the generated module imports each engine file under. */
const ASSET_PREFIX = "denext-sqlite-wasm-asset:";

/**
 * Whether an import of `path` from `importer` is the capability's engine bridge
 * (`src/mobile/sqlite-wasm.ts`), which the prebuild leaves external.
 *
 * @param path The import path as written.
 * @param importer The importing module (a path or URL).
 */
export function isSqliteWasmBridgeImport(path: string, importer: string): boolean {
  if (!path.endsWith("sqlite-wasm.ts") || !importer.includes("/src/mobile/")) return false;
  try {
    const base = /^[a-z][a-z0-9+.-]*:\/\//i.test(importer) ? importer : toFileUrl(importer).href;
    return new URL(path, base).pathname.endsWith("/src/mobile/sqlite-wasm.ts");
  } catch {
    return false;
  }
}

/**
 * The realpath of the installed `@sqlite.org/sqlite-wasm` package visible from `fromDir`
 * (walking up `node_modules`), when it carries both engine files; else null.
 *
 * @param fromDir Where the lookup starts (the app's project dir).
 */
export async function findSqliteWasm(fromDir: string): Promise<string | null> {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", SQLITE_WASM_PACKAGE);
    try {
      const real = await Deno.realPath(candidate);
      const files = ["dist/index.mjs", "dist/sqlite3.wasm"].map((f) => join(real, f));
      if ((await Promise.all(files.map((f) => Deno.stat(f)))).every((s) => s.isFile)) {
        return real;
      }
    } catch { /* not here — keep walking up */ }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The generated bridge module: the engine files' URLs (absolute, against the chunk that
 * imports them), or nulls when the package is not installed.
 *
 * @param installed Whether the package was found.
 * @returns The module source.
 */
export function sqliteWasmBridgeSource(installed: boolean): string {
  if (!installed) return "export const moduleUrl = null;\nexport const wasmUrl = null;\n";
  return `import moduleFile from ${JSON.stringify(`${ASSET_PREFIX}dist/index.mjs`)};
import wasmFile from ${JSON.stringify(`${ASSET_PREFIX}dist/sqlite3.wasm`)};
export const moduleUrl = new URL(moduleFile, import.meta.url).href;
export const wasmUrl = new URL(wasmFile, import.meta.url).href;
`;
}

/**
 * Register the bridge's resolution on an app build: {@link SQLITE_WASM_BRIDGE} → the
 * generated module, the engine files → file-loader assets. The package is looked up from the
 * build's working directory (the app's project dir).
 *
 * @param build The esbuild plugin build handle.
 */
export function registerSqliteWasmBridge(build: esbuild.PluginBuild): void {
  const fromDir = build.initialOptions.absWorkingDir ?? Deno.cwd();
  let found: Promise<string | null> | null = null;
  const pkgDir = () => found ??= findSqliteWasm(fromDir);
  build.onResolve({ filter: new RegExp(`^${SQLITE_WASM_BRIDGE}$`) }, () => ({
    path: SQLITE_WASM_BRIDGE,
    namespace: BRIDGE_NAMESPACE,
  }));
  build.onLoad({ filter: /.*/, namespace: BRIDGE_NAMESPACE }, async () => ({
    contents: sqliteWasmBridgeSource((await pkgDir()) !== null),
    loader: "js",
  }));
  build.onResolve({ filter: new RegExp(`^${ASSET_PREFIX}`) }, async (args) => {
    const dir = await pkgDir();
    if (!dir) return { errors: [{ text: `${SQLITE_WASM_PACKAGE} is not installed` }] };
    return { path: join(dir, args.path.slice(ASSET_PREFIX.length)), namespace: ASSET_NAMESPACE };
  });
  build.onLoad({ filter: /.*/, namespace: ASSET_NAMESPACE }, async (args) => ({
    contents: await Deno.readFile(args.path),
    loader: "file",
  }));
}
