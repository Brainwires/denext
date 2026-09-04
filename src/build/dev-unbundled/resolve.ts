// Unbundled dev: specifier resolution — first-party imports to absolute paths, and every
// import to its dev URL (`@fs`, `@dep`, `@npm`, the empty shim, or pass-through).

import { dirname, join, resolve, toFileUrl } from "@std/path";
import { ensureDir } from "@std/fs";
import { frameworkImports, readAliasPrefixes } from "../bundle.ts";
import { NEXT_ALIASES, REACT_ALIASES } from "../next-compat.ts";
import {
  DENEXT_RUNTIME_FILE,
  DEP_PREFIX,
  depSlug,
  EMPTY_MODULE,
  EXTS,
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

function isFile(p: string): boolean {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
}

/** Probe an extensionless base path for a real file (exact, +ext, or /index+ext). */
function probe(base: string): string | null {
  if (isFile(base)) return base;
  for (const e of EXTS) if (isFile(base + e)) return base + e;
  for (const e of EXTS) {
    const idx = join(base, "index" + e);
    if (isFile(idx)) return idx;
  }
  return null;
}

/** Resolve an import specifier from `importerAbs` to an absolute first-party path, or null. */
export async function resolveFirstParty(
  st: UnbundledState,
  spec: string,
  importerAbs: string,
): Promise<string | null> {
  let hit: string | null = null;
  if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
    hit = probe(resolve(dirname(importerAbs), spec));
  } else {
    for (const [key, absDir] of await ensureAliases(st)) {
      if (spec === key.slice(0, -1) || spec.startsWith(key)) {
        hit = probe(resolve(absDir, spec.slice(key.length)));
        break;
      }
    }
  }
  return hit ? norm(hit) : null;
}

/** compat: record an npm bare specifier for the on-demand bundle; returns its URL slug. */
function noteNpm(st: UnbundledState, spec: string): string {
  st.npmSpecs.add(spec);
  return depSlug(spec);
}

/**
 * The dev URL for a non-first-party specifier in compat mode: react-family and
 * `next/*` → the prebuilt runtime under {@link DEP_PREFIX}; `denext/*` → the same
 * runtime; an npm package → the on-demand npm bundle under {@link NPM_PREFIX}.
 * Returns null to fall through (unmapped `next/*` server surface, `node:`/scheme).
 */
export function compatDepUrl(st: UnbundledState, spec: string): string | null {
  if (/^react$|^react\//.test(spec) || /^react-dom$|^react-dom\//.test(spec)) {
    const f = REACT_ALIASES[spec] ?? (spec.startsWith("react-dom") ? "react-dom.js" : "react.js");
    return `${DEP_PREFIX}${f}`;
  }
  if (spec === "react-is") return `${DEP_PREFIX}react-is.js`;
  if (spec === "next" || spec.startsWith("next/")) {
    const f = NEXT_ALIASES[spec];
    return f ? `${DEP_PREFIX}${f}` : null;
  }
  const dfile = DENEXT_RUNTIME_FILE[spec];
  if (dfile) return `${DEP_PREFIX}${dfile}`;
  if (spec === "denext") return `${DEP_PREFIX}react.js`; // bare denext API == the react shim
  if (/^(node:|data:|https?:)/.test(spec)) return null;
  return `${NPM_PREFIX}${noteNpm(st, spec)}.js`;
}

/**
 * Dev URL for a resolved import. First-party paths → `/_denext/@fs<abs>?v=<version>`
 * (records the graph edge + baked version); `denext`/`denext/*` → a pre-bundled dep;
 * a stylesheet → the empty shim (route CSS is linked separately); anything else
 * (node:/data:/http:) passes through unchanged.
 */
export function rewriteSpecifier(
  st: UnbundledState,
  spec: string,
  firstParty: string | null,
  entry: TransformEntry,
): string {
  if (firstParty) {
    const v = versionOf(st, firstParty);
    entry.deps.push({ abs: firstParty, v });
    return `${FS_PREFIX}${firstParty}?v=${v}`;
  }
  if (/\.(css|scss|sass)(?:[?#].*)?$/i.test(spec)) return EMPTY_MODULE;
  if (st.compat) {
    const u = compatDepUrl(st, spec);
    if (u) return u;
    // fall through: unmapped next/* server surface, node:/scheme — leave to the browser.
  }
  if (spec === "denext" || spec.startsWith("denext/")) return `${DEP_PREFIX}${depSlug(spec)}.js`;
  return spec; // node:/data:/http(s): — leave for the browser (native client won't hit these)
}
