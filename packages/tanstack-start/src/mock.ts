// Start's `behavior: "mock"`, with Start's own mock modules (its
// `import-protection/virtualModules`, loaded from the app): a violation is a warning, and what it
// denied is a mock instead of the real module, as Start's dev server and build serve it.
//
// - **A denied specifier** (`@tanstack/react-start/server` in the browser, an app's own
//   `specifiers`) resolves to a mock-edge module: the named exports the importer uses (read from
//   its code by Start's analysis), each a property of a runtime mock — in a build Start's silent
//   mock, under a per-violation build id (`…:mock:build:<n>`), as Start's build makes it.
// - **A denied file** (`*.server.*` in the browser, `*.client.*` on the server, an app's `files`)
//   is loaded as Start's self-denial module: in dev the file's own named exports over a runtime
//   mock, in a build over a mock of its own (Start's self-contained mock module).
// - **The runtime mock** (dev) is Start's recursive Proxy: any property, call or `new` gives
//   another mock. In the browser it reports its first use of each access (`mockAccess`:
//   `console.error` by default, `"warn"`, `"off"`); on the server it is silent, as in Start.
//   Its message lists the import trace (the app modules from an entry to the importer), as
//   Start's dev server builds it from the imports resolved so far ({@link importTrail}).
//
// The ids are Start's (`tanstack-start-import-protection:…`); esbuild resolves them into the
// plugin's own namespace and loads them with Start's loaders.

import { relative } from "@std/path";
import {
  type ImportProtection,
  isAppModule,
  type ProtectionEnv,
  type TraceStep,
  traceTo,
} from "./protect.ts";
import type { StartMocks } from "./toolchain.ts";

/** The namespace Start's mock modules load from. */
export const MOCK_NS = "denext-tss-mock";

/** Start's mock ids, as an esbuild `onResolve` filter. */
export const MOCK_ID = /^tanstack-start-import-protection:/;

/** The next build mock's number (Start numbers its build mocks per process too). */
let buildMocks = 0;

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
  v: {
    env: ProtectionEnv;
    importer: string;
    importerCode: string;
    specifier: string;
    /** The app modules from an entry to the importer (the runtime mock's message lists them). */
    trace?: TraceStep[];
  },
): string {
  let names: string[] = [];
  try {
    names = mocks.getMockExportNamesBySource(v.importerCode).get(v.specifier) ?? [];
  } catch {
    // Code Start's parser cannot read: the mock's default export still stands in.
  }
  const runtime = protection.command === "build"
    ? `${mocks.MOCK_BUILD_PREFIX}${buildMocks++}`
    : mocks.mockRuntimeModuleIdFromViolation(
      { env: v.env, importer: v.importer, specifier: v.specifier, trace: v.trace ?? [] },
      protection.mockAccess,
      protection.root,
    );
  return mocks.makeMockEdgeModuleId(names, runtime);
}

/**
 * The module a denied file is loaded as: Start's self-denial module, the file's named exports
 * over the runtime mock in dev, over a self-contained mock in a build.
 *
 * @param mocks Start's mock modules.
 * @param protection The app's import protection.
 * @param v The environment, the file (absolute) and its source.
 */
export function selfDenialSource(
  mocks: StartMocks,
  protection: ImportProtection,
  v: {
    env: ProtectionEnv;
    file: string;
    source: string;
    /** The app modules from an entry to the file (the runtime mock's message lists them). */
    trace?: TraceStep[];
  },
): string {
  let names: string[] = [];
  try {
    names = mocks.getNamedExports(v.source, v.file);
  } catch {
    // Code Start's parser cannot read: the mock's default export still stands in.
  }
  if (protection.command === "build") return mocks.generateSelfContainedMockModule(names).code;
  const runtime = mocks.mockRuntimeModuleIdFromViolation(
    {
      env: v.env,
      importer: v.file,
      specifier: rel(v.file, protection.root),
      trace: v.trace ?? [],
    },
    protection.mockAccess,
    protection.root,
  );
  return mocks.generateDevSelfDenialModule(names, runtime).code;
}

/**
 * The source of one of Start's mock modules, by its id.
 *
 * @param mocks Start's mock modules.
 * @param id The id (`tanstack-start-import-protection:mock`, `…:mock-edge:…`, `…:mock-runtime:…`,
 *   or a build's `…:mock:build:<n>`, which is the silent mock).
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

/** One import an app module made, as the build saw it (before it was resolved). */
export interface SeenImport {
  /** The importing module (absolute). */
  importer: string;
  /** The import as written. */
  specifier: string;
  /** The directory it resolves from. */
  resolveDir: string;
  /** esbuild's import kind. */
  kind: string;
}

/** Each app module's imports in a dev build, and the trace to a module they lead to. */
export interface ImportTrail {
  /** Note an import (one from a module outside the app is left out). */
  note(seen: SeenImport): void;
  /** The app modules from an entry to `target` (absolute), entry first. */
  trace(target: string): Promise<TraceStep[]>;
}

/**
 * The trace a mocked import's runtime message lists, as Start's dev server builds it from the
 * imports resolved so far (its `ImportGraph` and `buildTrace`): an app module is loaded only
 * after its importers resolved the import that reached it, so every module above a violation
 * has been noted by the time the violation resolves. The noted imports are resolved only when a
 * trace is asked for (a violation, rare), each once, by `resolve`.
 *
 * @param resolve The module an import resolves to (absolute), or `null` (a package, external).
 * @param cwd The build's working directory (app modules lie under it).
 * @param maxDepth How many importers a trace walks up at most.
 */
export function importTrail(
  resolve: (seen: SeenImport) => Promise<string | null>,
  cwd: string,
  maxDepth: number,
): ImportTrail {
  let pending: SeenImport[] = [];
  const importers = new Map<string, Array<{ from: string; specifier: string }>>();
  return {
    note(seen) {
      if (isAppModule(seen.importer, cwd)) pending.push(seen);
    },
    async trace(target) {
      const batch = pending;
      pending = [];
      const resolved = await Promise.all(batch.map((seen) => resolve(seen).catch(() => null)));
      batch.forEach((seen, i) => {
        const to = resolved[i];
        if (!to) return;
        const list = importers.get(to) ?? [];
        list.push({ from: seen.importer, specifier: seen.specifier });
        importers.set(to, list);
      });
      return traceTo({ importers }, target, cwd, maxDepth);
    },
  };
}
