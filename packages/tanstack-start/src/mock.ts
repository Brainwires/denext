// Start's `behavior: "mock"` in `denext dev`, with Start's own mock modules (its
// `import-protection/virtualModules`, loaded from the app): a violation is a warning, and what it
// denied is a mock instead of the real module, as Start's dev server serves it.
//
// - **A denied specifier** (`@tanstack/react-start/server` in the browser, an app's own
//   `specifiers`) resolves to a mock-edge module: the named exports the importer uses (read from
//   its code by Start's analysis), each a property of a runtime mock.
// - **A denied file** (`*.server.*` in the browser, `*.client.*` on the server, an app's `files`)
//   is loaded as Start's self-denial module: the file's own named exports over a runtime mock.
// - **The runtime mock** is Start's recursive Proxy: any property, call or `new` gives another
//   mock. In the browser it reports its first use of each access (`mockAccess`: `console.error`
//   by default, `"warn"`, `"off"`); on the server it is silent, as in Start.
//
// The ids are Start's (`tanstack-start-import-protection:…`); esbuild resolves them into the
// plugin's own namespace and loads them with Start's loaders.

import { relative } from "@std/path";
import type { ImportProtection, ProtectionEnv } from "./protect.ts";
import type { StartMocks } from "./toolchain.ts";

/** The namespace Start's mock modules load from. */
export const MOCK_NS = "denext-tss-mock";

/** Start's mock ids, as an esbuild `onResolve` filter. */
export const MOCK_ID = /^tanstack-start-import-protection:/;

/** A path relative to `root`, `/`-separated (Start's runtime messages show it so). */
const rel = (path: string, root: string) => relative(root, path).replace(/\\/g, "/");

/**
 * The mock-edge module a denied specifier resolves to: the names `importerCode` uses it by, over
 * the runtime mock for the violation.
 *
 * @param mocks Start's mock modules.
 * @param protection The app's import protection (its `mockAccess` and root).
 * @param v The environment, the importer (absolute) and its code, and the specifier.
 */
export function mockEdgeId(
  mocks: StartMocks,
  protection: ImportProtection,
  v: { env: ProtectionEnv; importer: string; importerCode: string; specifier: string },
): string {
  let names: string[] = [];
  try {
    names = mocks.getMockExportNamesBySource(v.importerCode).get(v.specifier) ?? [];
  } catch {
    // Code Start's parser cannot read: the mock's default export still stands in.
  }
  const runtime = mocks.mockRuntimeModuleIdFromViolation(
    { env: v.env, importer: v.importer, specifier: v.specifier, trace: [] },
    protection.mockAccess,
    protection.root,
  );
  return mocks.makeMockEdgeModuleId(names, runtime);
}

/**
 * The module a denied file is loaded as: Start's self-denial module, the file's named exports
 * over the runtime mock.
 *
 * @param mocks Start's mock modules.
 * @param protection The app's import protection.
 * @param v The environment, the file (absolute) and its source.
 */
export function selfDenialSource(
  mocks: StartMocks,
  protection: ImportProtection,
  v: { env: ProtectionEnv; file: string; source: string },
): string {
  let names: string[] = [];
  try {
    names = mocks.getNamedExports(v.source, v.file);
  } catch {
    // Code Start's parser cannot read: the mock's default export still stands in.
  }
  const runtime = mocks.mockRuntimeModuleIdFromViolation(
    { env: v.env, importer: v.file, specifier: rel(v.file, protection.root), trace: [] },
    protection.mockAccess,
    protection.root,
  );
  return mocks.generateDevSelfDenialModule(names, runtime).code;
}

/**
 * The source of one of Start's mock modules, by its id.
 *
 * @param mocks Start's mock modules.
 * @param id The id (`tanstack-start-import-protection:mock`, `…:mock-edge:…`, `…:mock-runtime:…`).
 */
export function mockModuleSource(mocks: StartMocks, id: string): string {
  if (id.startsWith(mocks.MOCK_EDGE_PREFIX)) {
    return mocks.loadMockEdgeModule(id.slice(mocks.MOCK_EDGE_PREFIX.length)).code;
  }
  if (id.startsWith(mocks.MOCK_RUNTIME_PREFIX)) {
    return mocks.loadMockRuntimeModule(id.slice(mocks.MOCK_RUNTIME_PREFIX.length)).code;
  }
  return mocks.loadSilentMockModule().code;
}
