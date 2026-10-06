// Unbundled dev: shared state record, URL scheme constants and small pure helpers.
//
// Every stage under `./` takes the `UnbundledState` created once per dev server by
// `createUnbundledState` — the explicit form of what used to be the captured locals of
// one large closure. See `../dev-unbundled.ts` for the module header + URL scheme.

import type { PlatformResolution } from "../platform-extensions.ts";
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
  // Loaded on demand by the client (`class-loader.ts`) when a class component first renders; a
  // missing entry here 404s the whole module graph and the page never hydrates.
  "denext_class-runtime": "src/class-runtime.ts",
  "denext_client-runtime": "src/client/client-runtime.ts",
  "denext_devtools": "src/devtools.ts",
  // `feature()` calls are folded at build, but the IMPORT stays in the module (and nothing is
  // folded without `features`), so a "use client" file importing it needs the dep.
  "denext_feature": "src/feature.ts",
  // The Capacitor-shell client runtime — imported only from "use client" modules.
  "denext_mobile": "src/mobile/mod.ts",
  // VirtualMasonry — a client-only subpath of its own (VirtualList users bundle none of it).
  "denext_virtual-masonry": "src/virtual-masonry.ts",
};

/** denext runtime specifiers → their prebuilt runtime file (compat client graph). */
export const DENEXT_RUNTIME_FILE: Record<string, string> = {
  "denext/client": "client.js",
  "denext/jsx-runtime": "jsx-runtime.js",
  "denext/jsx-dev-runtime": "jsx-runtime.js",
  "denext/live": "live.js",
  "denext/lazy": "lazy.js",
  "denext/class-runtime": "class-runtime.js",
  "denext/client-runtime": "client-runtime.js",
  "denext/devtools": "devtools.js",
  "denext/feature": "feature.js",
  "denext/mobile": "mobile.js",
  "denext/virtual-masonry": "virtual-masonry.js",
};

const WINDOWS = Deno.build.os === "windows";

/**
 * The `@fs` dev URL path of a first-party module: `/_denext/@fs/home/app/page.tsx`, and on
 * Windows `/_denext/@fs/C:/app/page.tsx` — forward slashes and a leading slash, never a raw
 * `C:\…` a browser would rewrite on its own.
 *
 * @param abs The module's absolute filesystem path.
 * @returns The URL path (no query).
 */
export function fsUrlPath(abs: string): string {
  if (!WINDOWS) return FS_PREFIX + abs;
  const slashed = abs.replaceAll("\\", "/");
  return FS_PREFIX + (slashed.startsWith("/") ? "" : "/") + slashed;
}

/**
 * Inverse of {@link fsUrlPath}: the filesystem path an `@fs` URL path names (percent-decoded).
 * On Windows `/C:/app/x.tsx` (and a raw `C:/app/x.tsx`) become `C:\app\x.tsx`.
 *
 * @param rest The URL path after {@link FS_PREFIX}.
 * @returns The absolute filesystem path. Throws on a malformed percent-encoding.
 */
export function fsPathOfUrl(rest: string): string {
  const decoded = decodeURIComponent(rest);
  if (!WINDOWS) return decoded;
  const path = /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
  return path.replaceAll("/", "\\");
}

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

/**
 * esbuild loader for a source path's extension. With `jsxInJs` (React Native mode) a `.js`
 * module parses as JSX, as Metro's Babel preset does. Any other extension is not a module and
 * throws: parsing an arbitrary file as TSX would echo its text back in the error.
 */
export function loaderFor(path: string, jsxInJs = false): esbuild.Loader {
  if (/\.[cm]?ts$/.test(path)) return "ts";
  if (path.endsWith(".tsx")) return "tsx";
  if (jsxInJs && path.endsWith(".js")) return "jsx";
  if (/\.[cm]?js$/.test(path)) return "js";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".jsx")) return "jsx";
  throw new Error(`not a JS / TS / JSON module: ${path}`);
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
   * Compile-time feature flags (`features`). Folded into each first-party module
   * in dev too, so `feature("KEY")` behaves the same in dev as in a build (dev doesn't need
   * the DCE, only the value parity). Empty/absent → nothing folded.
   */
  features?: Record<string, boolean>;
  /** The project's `instrumentation-client` module (absolute path), imported first by every entry. */
  instrumentationClient?: string | null;
  /** The app's `momentumSafeScroll`; `false` seeds the runtime opt-out into every entry. */
  momentumSafeScroll?: boolean;
  /**
   * SPA mode: the app's single client entry (absolute path to `main.tsx`). When set,
   * {@link ENTRY_PATH} (with no `?p=`) serves a per-module SPA entry that imports the
   * app entry by its `@fs` URL — so a SPA's component edits hot-swap per-module too.
   */
  spaEntry?: string;
  /**
   * SPA mode: the reconciler-seam installs (`installClassSupport()`, …) the SPA entry runs
   * before the app's entry module, as the bundled SPA entry does (`supportInstall` in spa/shared.ts).
   */
  spaInstall?: string;
  /**
   * Compile-time `define` entries applied to every first-party module (React Native's
   * `__DEV__` / `global` / `process.env.EXPO_OS`, the SPA's `import.meta.env`).
   */
  define?: Record<string, string>;
  /**
   * React Native mode (`reactNative` in the config): the app's own modules are served per
   * module with `.web.*` probed first and `.js` parsed as JSX, and every package import is
   * served from one dependency bundle built through React Native mode's resolvers (see
   * `./react-native.ts`).
   */
  reactNative?: ReactNativeDevOptions;
  /**
   * The target's platform files for the app's own modules (`BigButton.web.tsx`; see
   * `../platform-extensions.ts`), probed ahead of the defaults. Null when the app turned them
   * off (`platformExtensions: false`); React Native mode then still probes its `.web.*`.
   */
  appPlatform?: PlatformResolution | null;
  /**
   * Called when the dependency bundle is rebuilt under a live page (React Native mode: a new
   * package or name was imported; compat: a module discovered a package the first build lacked,
   * which renames the bundle's shared chunks). The page must reload rather than load a second
   * copy of a package next to them, or fetch chunks that are gone.
   */
  onDepsRebuilt?: () => void;
}

/** What React Native mode adds to the unbundled loop (from `reactNativeBundleOptions`). */
export interface ReactNativeDevOptions {
  /** The react-native → react-native-web resolvers, run inside the dependency bundle. */
  plugins: esbuild.Plugin[];
  /** Extensions probed ahead of the defaults (`.web.tsx`, …). */
  platformExtensions: readonly string[];
  /** The dependency bundle's own `define` entries. */
  define: Record<string, string>;
  /** Resolve every bare package from `node_modules` (the app's `nodeResolve`). */
  resolveAllNodeModules?: boolean;
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
  /**
   * compat: the `"use server"` modules inside npm packages (from the Flight boundary) — an npm
   * island's action import, which the npm bundle replaces with a client action stub.
   */
  npmServerRefs: Map<string, { url: string; exports: string[] }>;
  /** compat: whether the npm bundle has been built (a later build happens under a live page). */
  npmBuiltOnce: boolean;
  npmBuilt: Set<string>;
  npmBuilding: Promise<void> | null;
  /**
   * compat: the crawl of the app's import graph in progress (see `prewarmNpmBundle`), which the
   * npm bundle waits for so its first build already holds every package the page imports.
   */
  npmCrawl: Promise<void> | null;
  /** compat: the graph roots already crawled (an entry is crawled once). */
  readonly npmCrawledRoots: Set<string>;
  /** compat: how many times the npm bundle has been built (diagnostics and tests). */
  npmBuilds: number;
  depsBuilt: Promise<void> | null;
  runtimeBuilt: Promise<void> | null;
  mergedConfigPath: string | null;
  aliasPrefixes: Array<[string, string]> | null;
  /**
   * React Native: the names the app's modules import from each package specifier, so the
   * dependency bundle's entry for it can re-export them (CommonJS packages included).
   */
  readonly npmNames: Map<string, Set<string>>;
  /** React Native: the specifier + names signature the current dependency bundle was built for. */
  npmBuiltSig: string | null;
  /** Bumped on every batch of edits: the app's import graph may have changed. */
  graphEpoch: number;
  /** React Native: the {@link graphEpoch} the dependency bundle was last checked against. */
  npmCheckedEpoch: number;
  /** React Native: how many times the dependency bundle was rebuilt under a live page. */
  npmLiveRebuilds: number;
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
    npmServerRefs: new Map(),
    npmBuiltOnce: false,
    npmBuilt: new Set(),
    npmBuilding: null,
    npmCrawl: null,
    npmCrawledRoots: new Set(),
    npmBuilds: 0,
    depsBuilt: null,
    runtimeBuilt: null,
    mergedConfigPath: null,
    aliasPrefixes: null,
    npmNames: new Map(),
    npmBuiltSig: null,
    graphEpoch: 0,
    npmCheckedEpoch: -1,
    npmLiveRebuilds: 0,
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

/**
 * Transform every module reachable from `roots` (breadth-first, each once): the transforms note
 * the packages each module imports, so a dependency bundle built afterwards already holds every
 * specifier the page will request. A module that fails to transform is skipped; it fails again,
 * visibly, when the page loads it.
 */
export async function crawlModuleGraph(
  roots: readonly string[],
  transformModule: (abs: string) => Promise<{ deps: Array<{ abs: string }> }>,
): Promise<void> {
  const seen = new Set<string>();
  let level = [...roots];
  while (level.length > 0) {
    const next: string[] = [];
    await Promise.all(level.map(async (abs) => {
      if (seen.has(abs)) return;
      seen.add(abs);
      try {
        for (const dep of (await transformModule(abs)).deps) next.push(dep.abs);
      } catch { /* a module that does not transform fails again when the page loads it */ }
    }));
    level = next.filter((abs) => !seen.has(abs));
  }
}
