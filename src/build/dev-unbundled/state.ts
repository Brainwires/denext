// Unbundled dev: shared state record, URL scheme constants and small pure helpers.
//
// Every stage under `./` takes the `UnbundledState` created once per dev server by
// `createUnbundledState` — the explicit form of what used to be the captured locals of
// one large closure. See `../dev-unbundled.ts` for the module header + URL scheme.

import { join } from "@std/path";
import type * as esbuild from "esbuild";

/** Dev URL prefixes (see the `dev-unbundled.ts` module header). */
export const DEP_PREFIX = "/_denext/@dep/";
export const FS_PREFIX = "/_denext/@fs";
export const ENTRY_PATH = "/_denext/@entry";
export const EMPTY_MODULE = "/_denext/@empty.js";
/** next-compat only: the on-demand npm dependency bundle (Vite-optimizeDeps style). */
export const NPM_PREFIX = "/_denext/@npm/";

/**
 * denext dependencies pre-bundled for the browser (native App Router). Each is
 * bundled into one ESM served under {@link DEP_PREFIX}; `splitting` hoists the shared
 * denext core into a chunk they all import → a single denext instance across the page.
 * Keyed by URL slug (the bare specifier with `/` → `_`) → framework-relative source.
 */
export const DEP_ENTRYPOINTS: Record<string, string> = {
  "denext": "mod.ts",
  "denext_client": "src/client/mod.ts",
  "denext_jsx-runtime": "src/jsx/jsx-runtime.ts",
  "denext_live": "src/live.ts",
  "denext_lazy": "src/lazy.ts",
  "denext_client-runtime": "src/client/client-runtime.ts",
  "denext_devtools": "src/devtools.ts",
};

/** denext runtime specifiers → their prebuilt runtime file (compat client graph). */
export const DENEXT_RUNTIME_FILE: Record<string, string> = {
  "denext/client": "client.js",
  "denext/jsx-runtime": "jsx-runtime.js",
  "denext/jsx-dev-runtime": "jsx-runtime.js",
  "denext/live": "live.js",
  "denext/lazy": "lazy.js",
  "denext/client-runtime": "client-runtime.js",
  "denext/devtools": "devtools.js",
};

/** The URL slug for a bare `denext`/`denext/x` specifier (matches DEP_ENTRYPOINTS keys). */
export function depSlug(spec: string): string {
  return spec.replace(/[^\w.-]/g, "_");
}

/**
 * Canonicalize a path through the filesystem's real path, so a graph key derived from
 * an import resolution and a `Deno.watchFs` event path (which macOS may realpath to
 * `/private/var/…`) compare equal. Falls back to the input when the file is gone.
 */
export function norm(p: string): string {
  try {
    return Deno.realPathSync(p);
  } catch {
    return p;
  }
}

/** esbuild loader for a source path's extension (default tsx — permissive for JSX). */
export function loaderFor(path: string): esbuild.Loader {
  if (path.endsWith(".ts")) return "ts";
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return "js";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".jsx")) return "jsx";
  return "tsx";
}

/** A cached module transform: its source mtime, the emitted JS, and its dep edges. */
export interface TransformEntry {
  mtimeMs: number;
  code: string;
  /** First-party (@fs) dependency abs paths this module imports, with the versions baked. */
  deps: Array<{ abs: string; v: number }>;
  /** Whether the module self-accepts an HMR update (it registers ≥1 component family). */
  selfAccepting: boolean;
}

export interface UnbundledDevOptions {
  projectDir: string;
  appDir: string;
  configPath: string;
  outDir: string;
  /**
   * next-compat (drop-in npm React) mode. When true, the browser's `react`/`react-dom`/
   * `next/*` and the app's npm packages are served from a pre-bundled runtime + an
   * on-demand npm dependency bundle (Vite-optimizeDeps-style, `react` external so every
   * npm lib shares denext's single React), instead of the native `denext`-only @dep set.
   */
  compat?: boolean;
  /** Class-component runtime flag, threaded into the react→denext runtime prebuild. */
  classComponents?: boolean;
  /**
   * SPA mode: the app's single client entry (absolute path to `main.tsx`). When set,
   * {@link ENTRY_PATH} (with no `?p=`) serves a per-module SPA entry that imports the
   * app entry by its `@fs` URL — so a SPA's component edits hot-swap per-module too.
   */
  spaEntry?: string;
}

/** Everything the unbundled dev stages share for one project. */
export interface UnbundledState {
  readonly opts: UnbundledDevOptions;
  readonly compat: boolean;
  /** Native `@dep` pre-bundle dir. */
  readonly depDir: string;
  /** compat: the react→denext runtime prebuild dir. */
  readonly runtimeDir: string;
  /** compat: the on-demand npm bundle dir. */
  readonly npmDir: string;
  /**
   * Per-module version, bumped when the file changes — stamped into importers' dev
   * URLs (`?v=`) so only a changed dep re-fetches while unchanged deps stay cached.
   */
  readonly version: Map<string, number>;
  /** Transform cache (abs path → last emitted transform). */
  readonly cache: Map<string, TransformEntry>;
  /** Reverse import graph (dep → its importers) for HMR boundary propagation. */
  readonly importers: Map<string, Set<string>>;
  /** Modules ever transformed; persists across a cache invalidation. */
  readonly known: Set<string>;
  /** Modules that self-accept an HMR update; persists across a cache invalidation. */
  readonly accepting: Set<string>;
  /** compat: npm bare specifiers the client graph imports (bundled together). */
  readonly npmSpecs: Set<string>;
  npmBuilt: Set<string>;
  npmBuilding: Promise<void> | null;
  depsBuilt: Promise<void> | null;
  runtimeBuilt: Promise<void> | null;
  mergedConfigPath: string | null;
  aliasPrefixes: Array<[string, string]> | null;
}

/** Create the shared state for one project (dirs under `<outDir>/dev-unbundled/`). */
export function createUnbundledState(opts: UnbundledDevOptions): UnbundledState {
  const base = join(opts.outDir, "dev-unbundled");
  return {
    opts,
    compat: opts.compat ?? false,
    depDir: join(base, "deps"),
    runtimeDir: join(base, "runtime"),
    npmDir: join(base, "npm"),
    version: new Map(),
    cache: new Map(),
    importers: new Map(),
    known: new Set(),
    accepting: new Set(),
    npmSpecs: new Set(),
    npmBuilt: new Set(),
    npmBuilding: null,
    depsBuilt: null,
    runtimeBuilt: null,
    mergedConfigPath: null,
    aliasPrefixes: null,
  };
}

/** Bump a module's version (its file changed). */
export function bump(st: UnbundledState, abs: string): void {
  st.version.set(abs, (st.version.get(abs) ?? 0) + 1);
}

/** A module's current version (0 until first bumped). */
export function versionOf(st: UnbundledState, abs: string): number {
  return st.version.get(abs) ?? 0;
}

/** Record `importer` as importing `dep` in the reverse graph. */
export function addImporter(st: UnbundledState, dep: string, importer: string): void {
  let set = st.importers.get(dep);
  if (!set) st.importers.set(dep, set = new Set());
  set.add(importer);
}
