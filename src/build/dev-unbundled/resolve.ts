// Unbundled dev: specifier resolution — first-party imports to absolute paths, and every
// import to its dev URL (`@fs`, `@dep`, `@npm`, the empty shim, or pass-through).

import { dirname, join, resolve, toFileUrl } from "@std/path";
import { ensureDir } from "@std/fs";
import { frameworkImports, readAliasPrefixes } from "../bundle.ts";
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
  FS_PREFIX,
  norm,
  NPM_PREFIX,
  type TransformEntry,
  type UnbundledState,
  versionOf,
} from "./state.ts";

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

/** App import-map PREFIX aliases (`~/` → absDir), loaded once from the project config. */
async function ensureAliases(st: UnbundledState): Promise<Array<[string, string]>> {
  return st.aliasPrefixes ??= await readAliasPrefixes(st.opts.configPath);
}

/** Resolve an import specifier from `importerAbs` to an absolute first-party path, or null. */
export async function resolveFirstParty(
  st: UnbundledState,
  spec: string,
  importerAbs: string,
): Promise<string | null> {
  return resolveWith(await ensureAliases(st), spec, importerAbs, probeExtensions(st));
}

/**
 * The extensions an extensionless first-party import probes: React Native mode's `.web.*`
 * ahead of the defaults (so `./button` finds `button.web.tsx` first), else the defaults.
 */
function probeExtensions(st: UnbundledState): readonly string[] | undefined {
  const web = st.opts.reactNative?.platformExtensions;
  return web && web.length > 0 ? [...web, ...SOURCE_EXTS] : undefined;
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
): Promise<(spec: string) => string | null> {
  const aliases = await ensureAliases(st);
  const exts = probeExtensions(st);
  return (spec) => resolveWith(aliases, spec, importerAbs, exts);
}

/** {@link resolveFirstParty} against an already loaded alias table. */
function resolveWith(
  aliases: Array<[string, string]>,
  spec: string,
  importerAbs: string,
  exts?: readonly string[],
): string | null {
  let hit: string | null = null;
  if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
    hit = probeSourceFile(resolve(dirname(importerAbs), spec), exts);
  } else {
    for (const [key, absDir] of aliases) {
      if (spec === key.slice(0, -1) || spec.startsWith(key)) {
        hit = probeSourceFile(resolve(absDir, spec.slice(key.length)), exts);
        break;
      }
    }
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
  const runtime = runtimeDepUrl(spec);
  if (runtime !== undefined) return runtime;
  if (/^(node:|data:|https?:)/.test(spec)) return null;
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
  const dfile = DENEXT_RUNTIME_FILE[spec] ?? DENEXT_RUNTIME_FILES[spec];
  if (dfile) return `${DEP_PREFIX}${dfile}`;
  if (spec === "denext") return `${DEP_PREFIX}react.js`; // bare denext API == the react shim
  return undefined;
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
  // React Native mode: an image / font / other asset of the app's rides the dependency bundle,
  // whose asset loaders give it the URL (or module) a build gives it.
  if (firstParty && st.opts.reactNative && !CODE_FILE.test(firstParty)) {
    return `${NPM_PREFIX}${noteNpm(st, firstParty, names)}.js`;
  }
  if (firstParty) {
    const v = versionOf(st, firstParty);
    entry.deps.push({ abs: firstParty, v });
    return `${FS_PREFIX}${firstParty}?v=${v}`;
  }
  if (st.compat) {
    const u = compatDepUrl(st, spec, names);
    if (u) return u;
    // fall through: unmapped next/* server surface, node:/scheme — leave to the browser.
  }
  if (spec === "denext" || spec.startsWith("denext/")) return `${DEP_PREFIX}${depSlug(spec)}.js`;
  return spec; // node:/data:/http(s): — leave for the browser (native client won't hit these)
}
