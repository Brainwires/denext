// Unbundled dev: specifier resolution — first-party imports to absolute paths, and every
// import to its dev URL (`@fs`, `@dep`, `@npm`, the empty shim, or pass-through).

import { dirname, fromFileUrl, join, resolve, SEPARATOR, toFileUrl } from "@std/path";
import { ensureDir } from "@std/fs";
import { frameworkImports, frameworkRoot } from "../bundle.ts";
import {
  DENEXT_RUNTIME_FILES,
  libraryReactFile,
  NEXT_ALIASES,
  probeSourceFile,
  REACT_ALIASES,
  SOURCE_EXTS,
} from "../next-compat.ts";
import {
  DENEXT_RUNTIME_FILE,
  DEP_PREFIX,
  depSlug,
  EMPTY_MODULE,
  fsUrlPath,
  norm,
  NPM_PREFIX,
  type TransformEntry,
  type UnbundledState,
  versionOf,
} from "./state.ts";
import { inNodeModules } from "../path-segments.ts";
import {
  type ImportAliases,
  type Platform,
  probePlatformSource,
  readImportAliases,
  resolveImportAlias,
} from "../platform-extensions.ts";

/**
 * A merged deno config (framework deps + the app's import map, absolutized) so the
 * deno-loader resolves denext's own @std/jsr deps AND the app's aliases. Written once.
 */
export async function ensureMergedConfig(st: UnbundledState): Promise<string> {
  if (st.mergedConfigPath) return st.mergedConfigPath;
  const { configPath } = st.opts;
  const appCfg = JSON.parse(await Deno.readTextFile(configPath)) as {
    imports?: Record<string, string>;
  };
  const appImports: Record<string, string> = {};
  for (const [k, v] of Object.entries(appCfg.imports ?? {})) {
    appImports[k] = v.startsWith("./") || v.startsWith("../")
      ? new URL(v, toFileUrl(configPath)).href
      : v;
  }
  const merged = { ...(await frameworkImports()), ...appImports };
  await ensureDir(st.depDir);
  const p = join(st.depDir, "deno.merged.json");
  await Deno.writeTextFile(p, JSON.stringify({ imports: merged }));
  st.mergedConfigPath = p;
  return p;
}

/**
 * The app's import-map aliases (`~/` → a folder, `#button` → a file), loaded once from the
 * project config: the same table the build's resolvers read ({@linkcode readImportAliases}).
 */
async function ensureAliases(st: UnbundledState): Promise<ImportAliases> {
  return st.aliasPrefixes ??= await readImportAliases(st.opts.projectDir);
}

/** Resolve an import specifier from `importerAbs` to an absolute first-party path, or null. */
export async function resolveFirstParty(
  st: UnbundledState,
  spec: string,
  importerAbs: string,
  platform: Platform = "web",
): Promise<string | null> {
  return resolveWith(
    await ensureAliases(st),
    spec,
    importerAbs,
    firstPartyProbe(st, platform),
    st.opts.projectDir,
  );
}

/** Probe an absolute first-party base path for its file (see {@linkcode firstPartyProbe}). */
type Probe = (base: string) => string | null;

/**
 * How a first-party import probes: the target's platform files first (`./button` finds
 * `button.web.tsx`, and an explicit `./button.tsx` takes it too), else React Native mode's
 * `.web.*` ahead of the defaults, else the defaults.
 */
export function firstPartyProbe(st: UnbundledState, platform: Platform = "web"): Probe {
  const resolution = st.opts.resolvePlatform?.(platform);
  if (resolution) {
    return (base) => probePlatformSource(base, resolution, probeSourceFile, SOURCE_EXTS);
  }
  const web = st.opts.reactNative?.platformExtensions;
  const exts = web && web.length > 0 ? [...web, ...SOURCE_EXTS] : undefined;
  return (base) => probeSourceFile(base, exts);
}

/**
 * A synchronous twin of {@link resolveFirstParty} for one importer: the alias table is loaded
 * once up front, so a pass that walks an AST without awaiting (the DevTools metadata) can
 * resolve each import-map alias as it meets it.
 *
 * @param st The unbundled dev state.
 * @param importerAbs The importing module's absolute path.
 * @returns A resolver from a specifier to an absolute first-party path, or `null`.
 */
export async function firstPartyResolver(
  st: UnbundledState,
  importerAbs: string,
  platform: Platform = "web",
): Promise<(spec: string) => string | null> {
  const aliases = await ensureAliases(st);
  const probe = firstPartyProbe(st, platform);
  return (spec) => resolveWith(aliases, spec, importerAbs, probe, st.opts.projectDir);
}

/** The framework checkout's root (a path ending in a separator; a URL when it runs remotely). */
const FRAMEWORK_ROOT = frameworkRoot();

/** {@link resolveFirstParty} against an already loaded alias table. */
function resolveWith(
  aliases: ImportAliases,
  spec: string,
  importerAbs: string,
  probe: Probe,
  projectDir: string,
): string | null {
  let hit: string | null = null;
  // A Vite asset query (`./click.mp3?url`) names the file before it (a `#` alias key keeps
  // its leading `#`).
  spec = spec.replace(/(?!^)[?#].*$/, "");
  if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
    hit = probe(resolve(dirname(importerAbs), spec));
  } else {
    // The alias first, then the target's platform file for the file it names. A folder alias
    // (`~/`) is the app's wherever it points, except into the framework; a file alias
    // (`#button`) only inside the project. `denext` / `denext/` mapped to a checkout is the
    // framework, served as a dependency: through `@fs` it would load a second runtime.
    const exact = aliases.some(([key]) => key === spec);
    const url = resolveImportAlias(spec, aliases) ?? resolveImportAlias(spec + "/", aliases);
    const path = url?.startsWith("file:") ? fromFileUrl(url).replace(/[\\/]$/, "") : null;
    const inProject = path?.startsWith(resolve(projectDir) + SEPARATOR);
    if (path && (inProject || (!exact && !path.startsWith(FRAMEWORK_ROOT)))) hit = probe(path);
  }
  return hit ? norm(hit) : null;
}

/** A module the per-module transform can serve (JS/TS/JSX/TSX/JSON), not an asset. */
export const CODE_FILE = /\.(?:[cm]?[jt]sx?|json)$/;

/** compat: record an npm bare specifier for the on-demand bundle; returns its URL slug. */
function noteNpm(st: UnbundledState, spec: string, names?: Iterable<string>): string {
  st.npmSpecs.add(spec);
  if (names) {
    let set = st.npmNames.get(spec);
    if (!set) st.npmNames.set(spec, set = new Set());
    for (const n of names) set.add(n);
  }
  return depSlug(spec);
}

/**
 * `table[key]` when `key` is the table's own key, else undefined: a plain object would answer
 * `constructor` / `__proto__` / `toString` with its prototype's.
 */
function ownValue(
  table: Readonly<Record<string, string>> | undefined,
  key: string,
): string | undefined {
  return table && Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * The dev URL for a non-first-party specifier in compat mode: react-family and
 * `next/*` → the prebuilt runtime under {@link DEP_PREFIX}; `denext/*` → the same
 * runtime; an npm package → the on-demand npm bundle under {@link NPM_PREFIX}.
 * Returns null to fall through (unmapped `next/*` server surface, `node:`/scheme).
 */
export function compatDepUrl(
  st: UnbundledState,
  spec: string,
  names?: Iterable<string>,
): string | null {
  spec = ownValue(st.opts.specAliases, spec) ?? spec;
  const runtime = runtimeDepUrl(spec);
  if (runtime !== undefined) return runtime;
  if (/^(node:|data:|https?:)/.test(spec)) return null;
  // A `denext/*` module the prebuilt runtime lacks is not an npm package: as an npm-bundle entry
  // (which marks `denext/*` external) it failed the WHOLE bundle, every npm import of the page.
  if (spec === "denext" || spec.startsWith("denext/")) return null;
  return `${NPM_PREFIX}${noteNpm(st, spec, names)}.js`;
}

/**
 * The prebuilt-runtime URL of the React / JSX runtime a module inside `node_modules` gets: the
 * library variant, whose elements keep React's re-render semantics (`libraryReactFile`), or
 * undefined for any other importer or specifier.
 *
 * @param spec The specifier.
 * @param importer The importing module's path.
 */
export function libraryDepUrl(spec: string, importer: string): string | undefined {
  const file = libraryReactFile(spec, importer);
  return file ? `${DEP_PREFIX}${file}` : undefined;
}

/**
 * The prebuilt-runtime URL (under {@link DEP_PREFIX}) of a react-family, `next/*` or
 * `denext/*` specifier; `null` for an unmapped `next/*` (the server surface, left alone);
 * `undefined` when the specifier is not one of those (a package, `node:`, a URL).
 */
export function runtimeDepUrl(spec: string): string | null | undefined {
  if (/^react$|^react\//.test(spec) || /^react-dom$|^react-dom\//.test(spec)) {
    const f = REACT_ALIASES[spec] ?? (spec.startsWith("react-dom") ? "react-dom.js" : "react.js");
    return `${DEP_PREFIX}${f}`;
  }
  if (spec === "react-is") return `${DEP_PREFIX}react-is.js`;
  if (spec === "next" || spec.startsWith("next/")) {
    const f = NEXT_ALIASES[spec];
    return f ? `${DEP_PREFIX}${f}` : null;
  }
  // The compat runtime also prebuilds `denext/navigation`, the `denext/expo/*` shims and React
  // Native mode's overlay, which the shared inventory (native @dep too) does not list.
  const dfile = ownValue(DENEXT_RUNTIME_FILE, spec) ?? ownValue(DENEXT_RUNTIME_FILES, spec);
  // The bare `denext` entry is `denext.js`, the root barrel in the same prebuilt graph.
  return dfile ? `${DEP_PREFIX}${dfile}` : undefined;
}

/**
 * The dev URL of an asset of the app's (an image, a font, a sound) or a Vite query import
 * (`./x.mp3?url`, `./shader.glsl?raw`), or undefined for a plain code module. It rides the
 * dependency bundle, whose asset loaders give it the URL (or module) a build gives it, by
 * absolute path, so the bundle (rooted at the project) finds it wherever the importer lives.
 * Only compat / React Native mode builds that bundle; elsewhere a query import is left as is.
 */
function appAssetUrl(
  st: UnbundledState,
  spec: string,
  firstParty: string,
  names?: Iterable<string>,
): string | undefined {
  // A query or hash after the path (`./click.mp3?url`); a `#` alias key's own `#` is not one.
  const query = spec.match(/(?!^)[?#].*$/)?.[0] ?? "";
  if (!query && CODE_FILE.test(firstParty)) return undefined;
  if (st.compat || st.opts.reactNative) {
    return `${NPM_PREFIX}${noteNpm(st, firstParty + query, names)}.js`;
  }
  return query ? spec : undefined;
}

/**
 * Dev URL for a resolved import. First-party paths → `/_denext/@fs<abs>?v=<version>`
 * (records the graph edge + baked version); `denext`/`denext/*` → a pre-bundled dep;
 * a stylesheet, first-party or not → the empty shim (CSS is linked separately); anything else
 * (node:/data:/http:) passes through unchanged. `names` are the bindings the importing module
 * takes from `spec`, recorded for a dependency-bundle entry (React Native mode re-exports them).
 */
export function rewriteSpecifier(
  st: UnbundledState,
  spec: string,
  firstParty: string | null,
  entry: TransformEntry,
  names?: Iterable<string>,
): string {
  // A stylesheet is linked separately, so even the app's own `./styles.css` must not reach
  // the JS transform (it would 500 the module and the whole page with it).
  if (/\.(css|scss|sass)(?:[?#].*)?$/i.test(spec)) return EMPTY_MODULE;
  const asset = firstParty ? appAssetUrl(st, spec, firstParty, names) : undefined;
  if (asset !== undefined) return asset;
  // compat: a file INSIDE an npm package named by path — the Flight entry's npm islands (an
  // npm package's `"use client"` file, often its CommonJS build) — goes through the npm bundle
  // like the package itself: served raw it would be CommonJS (or bundler-only ESM) in the browser.
  if (firstParty && st.compat && inNodeModules(firstParty)) {
    return `${NPM_PREFIX}${noteNpm(st, firstParty, names)}.js`;
  }
  if (firstParty) {
    const v = versionOf(st, firstParty);
    entry.deps.push({ abs: firstParty, v });
    return `${fsUrlPath(firstParty)}?v=${v}`;
  }
  if (st.compat) {
    const u = compatDepUrl(st, spec, names);
    if (u) return u;
    // fall through: unmapped next/* server surface, node:/scheme — leave to the browser.
  }
  if (spec === "denext" || spec.startsWith("denext/")) return `${DEP_PREFIX}${depSlug(spec)}.js`;
  return spec; // node:/data:/http(s): — leave for the browser (native client won't hit these)
}
