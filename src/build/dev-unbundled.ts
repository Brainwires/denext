// Unbundled dev server (Vite-class dev loop).
//
// The bundled dev path re-bundles a whole route through a `deno bundle` subprocess
// on every save (~hundreds of ms) and the client re-imports the entire route entry.
// This module serves each source module UNBUNDLED — transformed on demand (~5ms,
// warm esbuild) at its own URL, with its imports rewritten to dev URLs — so the
// browser loads the native ESM graph. On an edit only the changed module is
// re-transformed and re-imported; the reconciler's family-current substitution
// (see refresh-runtime `enablePerModuleRefresh`) swaps the new code onto the live
// fiber tree with hook state intact. That is true per-module HMR.
//
// Dev-only. esbuild + the deno-loader are build-time tools; nothing here ships.
//
// URL scheme (all under `/_denext/` so the strict dev CSP's `script-src 'self'` and
// the same-origin dev-endpoint gate already cover it):
//   /_denext/@dep/<slug>.js   a pre-bundled dependency (denext core — single instance)
//   /_denext/@fs<abs-path>     a first-party source module, transformed + rewritten
//   /_denext/@entry?p=<route>  the generated unbundled client entry for a route
//   /_denext/@empty.js         the shared empty shim (stylesheet imports resolve here)
//
// @module

import { denoPlugins } from "@luca/esbuild-deno-loader";
import * as esbuild from "esbuild";
import { dirname, fromFileUrl, join, resolve, toFileUrl } from "@std/path";
import { ensureDir } from "@std/fs";
import type { PageRoute, RouteManifest } from "../router/manifest.ts";
import {
  frameworkImports,
  generateFlightEntry,
  generateRouteEntry,
  routeSourceFiles,
} from "./bundle.ts";
import type { BoundaryManifest } from "./module-graph.ts";
import { collectComponentNames, refreshFooter } from "./spa-refresh-plugin.ts";
import { swcParse } from "./swc-ast.ts";
import {
  BROWSER_CONDITIONS,
  catalogResolverPlugin,
  NEXT_ALIASES,
  nodeBuiltinStubPlugin,
  prebuildDenextRuntime,
  REACT_ALIASES,
} from "./next-compat.ts";

/** Dev URL prefixes (see the module header). */
const DEP_PREFIX = "/_denext/@dep/";
const FS_PREFIX = "/_denext/@fs";
const ENTRY_PATH = "/_denext/@entry";
const EMPTY_MODULE = "/_denext/@empty.js";
/** next-compat only: the on-demand npm dependency bundle (Vite-optimizeDeps style). */
const NPM_PREFIX = "/_denext/@npm/";

/** Extensions probed when resolving an extensionless relative/alias import. */
const EXTS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".json", ".mdx", ".md"];

/**
 * denext dependencies pre-bundled for the browser (native App Router). Each is
 * bundled into one ESM served under {@link DEP_PREFIX}; `splitting` hoists the shared
 * denext core into a chunk they all import → a single denext instance across the page.
 * Keyed by URL slug (the bare specifier with `/` → `_`) → framework-relative source.
 */
const DEP_ENTRYPOINTS: Record<string, string> = {
  "denext": "mod.ts",
  "denext_client": "src/client/mod.ts",
  "denext_jsx-runtime": "src/jsx/jsx-runtime.ts",
  "denext_live": "src/live.ts",
  "denext_lazy": "src/lazy.ts",
  "denext_devtools": "src/devtools.ts",
};

/** The URL slug for a bare `denext`/`denext/x` specifier (matches DEP_ENTRYPOINTS keys). */
function depSlug(spec: string): string {
  return spec.replace(/[^\w.-]/g, "_");
}

/**
 * Canonicalize a path through the filesystem's real path, so a graph key derived from
 * an import resolution and a `Deno.watchFs` event path (which macOS may realpath to
 * `/private/var/…`) compare equal. Falls back to the input when the file is gone.
 */
function norm(p: string): string {
  try {
    return Deno.realPathSync(p);
  } catch {
    return p;
  }
}

/** esbuild loader for a source path's extension (default tsx — permissive for JSX). */
function loaderFor(path: string): esbuild.Loader {
  if (path.endsWith(".ts")) return "ts";
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return "js";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".jsx")) return "jsx";
  return "tsx";
}

/** A cached module transform: its source mtime, the emitted JS, and its dep edges. */
interface TransformEntry {
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

/**
 * The unbundled dev subsystem for one project. Owns the warm esbuild service, the
 * pre-bundled deps, the per-module transform cache, and the module graph used to
 * compute HMR updates. Created once per dev server; `stop()` on shutdown.
 */
export function createUnbundledDev(opts: UnbundledDevOptions) {
  const { appDir, configPath, outDir, projectDir, compat = false } = opts;
  const depDir = join(outDir, "dev-unbundled", "deps");
  // compat mode: the react→denext runtime prebuild dir, and the on-demand npm bundle dir.
  const runtimeDir = join(outDir, "dev-unbundled", "runtime");
  const npmDir = join(outDir, "dev-unbundled", "npm");

  // Per-module version, bumped when the file changes — stamped into importers' dev
  // URLs (`?v=`) so only a changed dep re-fetches while unchanged deps stay cached.
  const version = new Map<string, number>();
  const bump = (abs: string) => version.set(abs, (version.get(abs) ?? 0) + 1);
  const versionOf = (abs: string) => version.get(abs) ?? 0;

  // Transform cache + the reverse import graph (dep → its importers) for HMR
  // boundary propagation. `known`/`accepting` persist across a cache invalidation (an
  // edit deletes the cache entry, but the module is still a known accept boundary).
  const cache = new Map<string, TransformEntry>();
  const importers = new Map<string, Set<string>>();
  const known = new Set<string>();
  const accepting = new Set<string>();
  const addImporter = (dep: string, importer: string) => {
    let set = importers.get(dep);
    if (!set) importers.set(dep, set = new Set());
    set.add(importer);
  };

  // A merged deno config (framework deps + the app's import map, absolutized) so the
  // deno-loader resolves denext's own @std/jsr deps AND the app's aliases. Written once.
  let mergedConfigPath: string | null = null;
  async function ensureMergedConfig(): Promise<string> {
    if (mergedConfigPath) return mergedConfigPath;
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
    await ensureDir(depDir);
    const p = join(depDir, "deno.merged.json");
    await Deno.writeTextFile(p, JSON.stringify({ imports: merged }));
    mergedConfigPath = p;
    return p;
  }

  // App import-map PREFIX aliases (`~/` → absDir), for resolving alias imports in the
  // transform. Loaded once from the project config.
  let aliasPrefixes: Array<[string, string]> | null = null;
  async function ensureAliases(): Promise<Array<[string, string]>> {
    if (aliasPrefixes) return aliasPrefixes;
    const out: Array<[string, string]> = [];
    try {
      const cfg = JSON.parse(await Deno.readTextFile(configPath)) as {
        imports?: Record<string, string>;
      };
      const baseDir = dirname(configPath);
      for (const [k, v] of Object.entries(cfg.imports ?? {})) {
        if (!k.endsWith("/") || typeof v !== "string") continue;
        let absDir: string | null = null;
        if (v.startsWith("file://")) absDir = fromFileUrl(v.endsWith("/") ? v : v + "/");
        else if (v.startsWith("./") || v.startsWith("../")) absDir = resolve(baseDir, v);
        if (absDir) out.push([k, absDir]);
      }
    } catch { /* no import map — only relatives resolved */ }
    aliasPrefixes = out;
    return out;
  }

  /** Probe an extensionless base path for a real file (exact, +ext, or /index+ext). */
  function probe(base: string): string | null {
    try {
      if (Deno.statSync(base).isFile) return base;
    } catch { /* not an exact file */ }
    for (const e of EXTS) {
      try {
        if (Deno.statSync(base + e).isFile) return base + e;
      } catch { /* keep trying */ }
    }
    for (const e of EXTS) {
      try {
        const idx = join(base, "index" + e);
        if (Deno.statSync(idx).isFile) return idx;
      } catch { /* keep trying */ }
    }
    return null;
  }

  /** Resolve an import specifier from `importerAbs` to an absolute first-party path, or null. */
  async function resolveFirstParty(spec: string, importerAbs: string): Promise<string | null> {
    let hit: string | null = null;
    if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
      hit = probe(resolve(dirname(importerAbs), spec));
    } else {
      for (const [key, absDir] of await ensureAliases()) {
        if (spec === key.slice(0, -1) || spec.startsWith(key)) {
          hit = probe(resolve(absDir, spec.slice(key.length)));
          break;
        }
      }
    }
    return hit ? norm(hit) : null;
  }

  /**
   * Dev URL for a resolved import. First-party paths → `/_denext/@fs<abs>?v=<version>`
   * (records the graph edge + baked version); `denext`/`denext/*` → a pre-bundled dep;
   * a stylesheet → the empty shim (route CSS is linked separately); anything else
   * (node:/data:/http:) passes through unchanged.
   */
  function rewriteSpecifier(
    spec: string,
    firstParty: string | null,
    entry: TransformEntry,
  ): string {
    if (firstParty) {
      const v = versionOf(firstParty);
      entry.deps.push({ abs: firstParty, v });
      return `${FS_PREFIX}${firstParty}?v=${v}`;
    }
    if (/\.(css|scss|sass)(?:[?#].*)?$/i.test(spec)) return EMPTY_MODULE;
    if (compat) {
      const u = compatDepUrl(spec);
      if (u) return u;
      // fall through: unmapped next/* server surface, node:/scheme — leave to the browser.
    }
    if (spec === "denext" || spec.startsWith("denext/")) return `${DEP_PREFIX}${depSlug(spec)}.js`;
    return spec; // node:/data:/http(s): — leave for the browser (native client won't hit these)
  }

  // ---- next-compat dep resolution (react→denext runtime + npm optimizeDeps) --

  /** denext runtime specifiers → their prebuilt runtime file (compat client graph). */
  const DENEXT_RUNTIME_FILE: Record<string, string> = {
    "denext/client": "client.js",
    "denext/jsx-runtime": "jsx-runtime.js",
    "denext/jsx-dev-runtime": "jsx-runtime.js",
    "denext/live": "live.js",
    "denext/lazy": "lazy.js",
  };

  // npm bare specifiers the client graph imports (compat), pre-bundled together (one
  // esbuild `splitting` pass) so packages sharing a transitive dep — React context
  // providers especially — get ONE instance. `react` is external → the shared runtime.
  const npmSpecs = new Set<string>();
  function noteNpm(spec: string): string {
    npmSpecs.add(spec);
    return depSlug(spec);
  }

  /**
   * The dev URL for a non-first-party specifier in compat mode: react-family and
   * `next/*` → the prebuilt runtime under {@link DEP_PREFIX}; `denext/*` → the same
   * runtime; an npm package → the on-demand npm bundle under {@link NPM_PREFIX}.
   * Returns null to fall through (unmapped `next/*` server surface, `node:`/scheme).
   */
  function compatDepUrl(spec: string): string | null {
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
    return `${NPM_PREFIX}${noteNpm(spec)}.js`;
  }

  // ---- Dependency pre-bundle ------------------------------------------------

  let depsBuilt: Promise<void> | null = null;
  function ensureDeps(): Promise<void> {
    if (depsBuilt) return depsBuilt;
    depsBuilt = (async () => {
      const cfg = await ensureMergedConfig();
      // Resolve each denext dep to its framework source URL (file:// from a checkout,
      // https:// from JSR) so the deno-loader can fetch it either way.
      const base = new URL("../../", import.meta.url).href;
      const entryPoints: Record<string, string> = {};
      for (const [slug, rel] of Object.entries(DEP_ENTRYPOINTS)) {
        entryPoints[slug] = new URL(rel, base).href;
      }
      await ensureDir(depDir);
      await esbuild.build({
        entryPoints,
        outdir: depDir,
        bundle: true,
        splitting: true,
        format: "esm",
        platform: "browser",
        sourcemap: "inline",
        jsx: "automatic",
        jsxImportSource: "denext",
        // Native helper packages (used by next/og etc.) are lazily imported at
        // runtime — never reached by native App Router client code; keep external.
        external: ["@denext/photon", "@denext/avif", "@denext/og"],
        plugins: [...denoPlugins({ configPath: cfg })],
      });
    })();
    return depsBuilt;
  }

  // compat: prebuild the react→denext runtime (react/react-dom/next/* + denext client,
  // jsx, live, lazy) into ONE shared graph (esbuild `splitting` → a single denext
  // instance). Served under DEP_PREFIX; the app's own react/npm imports point here.
  let runtimeBuilt: Promise<void> | null = null;
  function ensureRuntime(): Promise<void> {
    return runtimeBuilt ??= prebuildDenextRuntime({
      outDir: runtimeDir,
      configPath,
      classComponents: opts.classComponents ?? true,
    }).then(() => {});
  }

  /** The @dep pre-bundle the client entry needs before it runs: runtime (compat) or denext (native). */
  function ensureClientDeps(): Promise<void> {
    return compat ? ensureRuntime() : ensureDeps();
  }

  // compat: an esbuild plugin marking react-family / next/* / denext-runtime specifiers
  // EXTERNAL, pointing at the shared prebuilt runtime's dev URLs — so an npm package's
  // own `import "react"` resolves to denext's single React (never a second copy).
  function runtimeExternalPlugin(): esbuild.Plugin {
    return {
      name: "denext-runtime-external",
      setup(build) {
        build.onResolve(
          {
            filter:
              /^react$|^react\/|^react-dom$|^react-dom\/|^react-is$|^next$|^next\/|^denext(\/|$)/,
          },
          (args) => {
            const u = compatDepUrl(args.path);
            return u ? { path: u, external: true } : null;
          },
        );
      },
    };
  }

  // compat: on-demand npm dependency bundle (Vite optimizeDeps). ALL discovered npm
  // specifiers are bundled together in one `splitting` pass so packages sharing a
  // transitive dep get one instance; `react` is external (shared runtime). Rebuilt when
  // a newly-transformed module discovers a spec not yet in the bundle.
  let npmBuilt = new Set<string>();
  let npmBuilding: Promise<void> | null = null;
  async function ensureNpmBundle(): Promise<void> {
    while (npmBuilding) await npmBuilding;
    if ([...npmSpecs].every((s) => npmBuilt.has(s)) && npmSpecs.size > 0) return;
    if (npmSpecs.size === 0) return;
    npmBuilding = (async () => {
      const specs = [...npmSpecs];
      const entryPoints: Record<string, string> = {};
      for (const s of specs) entryPoints[depSlug(s)] = s;
      await ensureDir(npmDir);
      await esbuild.build({
        entryPoints,
        outdir: npmDir,
        bundle: true,
        splitting: true,
        format: "esm",
        platform: "browser",
        sourcemap: "inline",
        jsx: "automatic",
        jsxImportSource: "react",
        absWorkingDir: projectDir,
        logLevel: "silent",
        plugins: [
          runtimeExternalPlugin(),
          catalogResolverPlugin(projectDir, "all", BROWSER_CONDITIONS),
          nodeBuiltinStubPlugin(),
        ],
      });
      npmBuilt = new Set(specs);
    })();
    try {
      await npmBuilding;
    } finally {
      npmBuilding = null;
    }
  }

  // ---- Per-module transform -------------------------------------------------

  /**
   * Transform + rewrite one first-party module for the browser (cached by mtime and
   * its deps' versions). Externalizes every import to a dev URL and, for a component
   * module, appends the Fast Refresh footer that registers each export's family (the
   * hook that makes an edit swap in place).
   */
  async function transform(abs: string): Promise<TransformEntry> {
    let mtimeMs = 0;
    try {
      mtimeMs = (await Deno.stat(abs)).mtime?.getTime() ?? 0;
    } catch { /* missing — fall through, esbuild reports it */ }
    const hit = cache.get(abs);
    if (
      hit && hit.mtimeMs === mtimeMs &&
      hit.deps.every((d) => versionOf(d.abs) === d.v)
    ) {
      return hit;
    }

    const entry: TransformEntry = { mtimeMs, code: "", deps: [], selfAccepting: false };
    known.add(abs);

    // Component detection (best-effort): a module exporting ≥1 component self-accepts.
    let footer = "";
    try {
      const source = await Deno.readTextFile(abs);
      const names = collectComponentNames(await (await swcParse())(source));
      if (names.length > 0) {
        footer = refreshFooter(toFileUrl(abs).href, names);
        entry.selfAccepting = true;
        accepting.add(abs);
      } else {
        accepting.delete(abs); // e.g. a component was removed by the edit
      }
    } catch { /* unreadable/unparsable — no footer, treated as non-accepting */ }

    const rewritePlugin: esbuild.Plugin = {
      name: "denext-dev-rewrite",
      setup(build) {
        // Load the entry with the Fast Refresh footer appended (its `denext/client`
        // import is rewritten to the dep below). Only the entry is loaded — every
        // other import is externalized — so this fires once.
        build.onLoad({ filter: /.*/ }, async (args) => {
          if (args.path !== abs) return null;
          const src = await Deno.readTextFile(abs);
          return { contents: src + footer, loader: loaderFor(abs), resolveDir: dirname(abs) };
        });
        build.onResolve({ filter: /.*/ }, async (args) => {
          if (args.kind === "entry-point") return null;
          const firstParty = await resolveFirstParty(args.path, args.importer || abs);
          if (firstParty) addImporter(firstParty, abs);
          return { path: rewriteSpecifier(args.path, firstParty, entry), external: true };
        });
      },
    };

    // No deno-loader: every import is externalized by `rewritePlugin`, so esbuild only
    // transforms this one file (JSX/TS via its built-in loaders) — a warm rebuild is
    // ~5ms, the property that makes per-module HMR feel instant.
    const result = await esbuild.build({
      entryPoints: [abs],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      jsx: "automatic",
      jsxImportSource: "denext",
      sourcemap: "inline",
      logLevel: "silent",
      plugins: [rewritePlugin],
    });
    entry.code = new TextDecoder().decode(result.outputFiles![0].contents);
    cache.set(abs, entry);
    return entry;
  }

  // ---- Generated unbundled entry --------------------------------------------

  /** The client entry URL for a route (points the shell's module <script> here). */
  function entryUrlFor(route: PageRoute): string {
    return `${ENTRY_PATH}?p=${encodeURIComponent(route.routePath)}`;
  }

  /**
   * Whether a route's client entry can be served unbundled. Every module the entry
   * imports (page, layouts, templates, loading/error boundaries, slots) must be
   * transformable by esbuild's built-in loaders — JS/TS/JSX/TSX. A route with an
   * `.mdx`/`.md` entry module (which needs the full MDX pipeline) keeps the bundled
   * path; the caller falls back for it and the whole surface stays correct.
   */
  function supportsRoute(route: PageRoute): boolean {
    return routeSourceFiles(route).every((f) => /\.(tsx|ts|jsx|js|mjs|cjs)$/.test(f));
  }

  /**
   * Transform a GENERATED entry module (route or flight) so its `denext/*` and its
   * page/layout/island imports become dev URLs, and record the imported first-party
   * modules as importers of `importerKey`. The entry is regenerated per request; its
   * recorded deps go to a throwaway sink (only real source modules are cached), but its
   * importer edges DO go into the graph so HMR propagation can decide reload vs update.
   */
  async function transformGeneratedEntry(src: string, importerKey: string): Promise<string> {
    const sink: TransformEntry = { mtimeMs: 0, code: "", deps: [], selfAccepting: true };
    const NS = "denext-entry";
    const rewritePlugin: esbuild.Plugin = {
      name: "denext-dev-entry-rewrite",
      setup(build) {
        // The virtual entry: resolve the synthetic id (incl. as an entry point) into
        // our namespace, and load it from the generated source.
        build.onResolve(
          { filter: /^denext-entry$/ },
          () => ({ path: "denext-entry", namespace: NS }),
        );
        build.onLoad({ filter: /.*/, namespace: NS }, () => ({
          contents: src,
          loader: "tsx",
          resolveDir: appDir,
        }));
        // Externalize + rewrite every import the entry makes (the synthetic entry id is
        // claimed by the resolve above, so this only ever sees the entry's own imports:
        // page/layouts/islands by `file://` URL and `denext/*` by bare specifier).
        build.onResolve({ filter: /.*/ }, async (args) => {
          if (args.path === "denext-entry") return null; // handled above
          const firstParty = args.path.startsWith("file://")
            ? norm(fromFileUrl(args.path))
            : await resolveFirstParty(args.path, args.importer || appDir);
          if (firstParty) addImporter(firstParty, importerKey);
          return { path: rewriteSpecifier(args.path, firstParty, sink), external: true };
        });
      },
    };
    const result = await esbuild.build({
      entryPoints: ["denext-entry"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      jsx: "automatic",
      jsxImportSource: "denext",
      sourcemap: "inline",
      logLevel: "silent",
      plugins: [rewritePlugin],
    });
    return new TextDecoder().decode(result.outputFiles![0].contents);
  }

  /**
   * Serve a route's generated client entry (page/layouts/templates/boundaries),
   * transformed through {@link transformGeneratedEntry}. Its imported modules become
   * `@fs` dev URLs served unbundled with per-module footers.
   */
  function serveEntry(route: PageRoute): Promise<string> {
    return transformGeneratedEntry(
      generateRouteEntry(route, true, true),
      `entry:${route.routePath}`,
    );
  }

  /**
   * Serve the app-wide FLIGHT client entry unbundled: each `"use client"` island is
   * imported by its `@fs` dev URL (served on its own with a per-module footer), so an
   * island edit hot-swaps that single module in place. The flight `registry` (clientId
   * -> fn, for Flight parsing) and Live/resumability wiring are unchanged; only the
   * island modules move off the bundled entry. `ensureDeps` first — the entry imports
   * `denext/client` and `denext/live`. All islands share the `entry:flight` importer
   * key; since each island self-accepts, an edit propagates to itself (an in-place
   * update), never to the entry (a reload).
   */
  async function serveFlightEntry(boundary: BoundaryManifest): Promise<string> {
    await ensureClientDeps();
    return transformGeneratedEntry(generateFlightEntry(boundary, true, true), "entry:flight");
  }

  /** The SPA client entry URL (no `?p=` — SPA has a single entry, not routes). */
  function spaEntryUrl(): string {
    return ENTRY_PATH;
  }

  /**
   * Serve the SPA's generated client entry: enable per-module Fast Refresh, then import
   * the app's single entry (`main.tsx`) by its `@fs` URL. The app's whole module graph is
   * then served unbundled, so any component edit hot-swaps that one module in place. Its
   * `denext`/`react`/npm imports resolve through {@link rewriteSpecifier} like any route.
   */
  async function serveSpaEntry(): Promise<string> {
    await ensureClientDeps();
    const abs = norm(opts.spaEntry!);
    const src = `// denext generated SPA entry (dev, unbundled) — do not edit.\n` +
      `import { enablePerModuleRefresh, installDevtools } from "denext/client";\n` +
      `enablePerModuleRefresh();\ninstallDevtools();\n` +
      `await import(${JSON.stringify(toFileUrl(abs).href)});\n`;
    return transformGeneratedEntry(src, "entry:spa");
  }

  // ---- HTTP handling --------------------------------------------------------

  const jsHeaders = {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "no-store",
  } as const;

  function js(code: string, status = 200): Response {
    return new Response(code, { status, headers: jsHeaders });
  }

  /** Handle an unbundled dev request, or return null if the URL isn't ours. */
  async function handle(_request: Request, url: URL, manifest: RouteManifest): Promise<
    Response | null
  > {
    const path = url.pathname;

    if (path === EMPTY_MODULE) return js("export default {};\n");

    if (path.startsWith(DEP_PREFIX)) {
      try {
        await ensureClientDeps();
      } catch (err) {
        return js(errStub("dep prebundle", err), 500);
      }
      // compat serves react/next/denext from the react→denext runtime prebuild; native
      // serves the denext-only @dep set. Runtime + native chunks (`chunk-*.js`) live in
      // the same dir as their entries, so a single readTextFile covers both.
      const name = path.slice(DEP_PREFIX.length);
      try {
        return js(await Deno.readTextFile(join(compat ? runtimeDir : depDir, name)));
      } catch {
        return js(`// dep not found: ${name}`, 404);
      }
    }

    if (path.startsWith(NPM_PREFIX)) {
      try {
        await ensureNpmBundle();
      } catch (err) {
        return js(errStub("npm prebundle", err), 500);
      }
      const name = path.slice(NPM_PREFIX.length);
      try {
        return js(await Deno.readTextFile(join(npmDir, name)));
      } catch {
        return js(`// npm dep not found: ${name}`, 404);
      }
    }

    if (path.startsWith(FS_PREFIX)) {
      const abs = norm(decodeURIComponent(path.slice(FS_PREFIX.length)));
      try {
        const entry = await transform(abs);
        return js(entry.code);
      } catch (err) {
        return js(errStub(abs, err), 500);
      }
    }

    if (path === ENTRY_PATH) {
      const routePath = url.searchParams.get("p");
      // SPA: no `?p=` — serve the single app entry unbundled.
      if (routePath === null && opts.spaEntry) {
        try {
          return js(await serveSpaEntry());
        } catch (err) {
          return js(errStub("spa entry", err), 500);
        }
      }
      const route = manifest.pages.find((p) => p.routePath === routePath);
      if (!route) return js("// route not found", 404);
      try {
        // The deps must be built before the entry runs (it imports denext/client).
        await ensureClientDeps();
        return js(await serveEntry(route));
      } catch (err) {
        return js(errStub("entry", err), 500);
      }
    }

    return null;
  }

  function errStub(what: string, err: unknown): string {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    return `console.error(${JSON.stringify(`denext dev transform error (${what}):\n` + msg)});`;
  }

  // ---- HMR change computation ----------------------------------------------

  /**
   * Compute the HMR action for a batch of changed first-party paths. Returns:
   *  - `updates` — accept-boundary module dev URLs to re-import in place;
   *  - `reload`  — a changed module IS on an unbundled route but propagates to the
   *                route entry (a structural change), so the page must fully reload;
   *  - `unknownOnly` — NONE of the changed modules is in the unbundled client graph
   *                (a flight-route island, a bundled/MDX route's module, or a
   *                server-only file). The caller falls back to the bundled
   *                whole-entry Fast Refresh, which those routes still honor — so a
   *                default-on unbundled loop never downgrades an island edit to a
   *                full reload.
   */
  function onChange(
    changedRaw: string[],
  ): { updates: string[]; reload: boolean; unknownOnly: boolean } {
    const changed = changedRaw.map(norm);
    const boundaries = new Set<string>();
    let anyKnown = false;
    let structuralReload = false;
    for (const abs of changed) {
      bump(abs);
      cache.delete(abs); // force re-transform on next serve
      if (!known.has(abs) && !importers.has(abs)) continue; // not ours — caller falls back
      anyKnown = true;
      const found = propagate(abs, new Set());
      if (found === null) {
        structuralReload = true;
        continue;
      }
      for (const b of found) boundaries.add(b);
    }
    const epoch = Date.now();
    const updates = [...boundaries].map((abs) =>
      `${FS_PREFIX}${abs}?t=${epoch}&v=${versionOf(abs)}`
    );
    return { updates, reload: structuralReload, unknownOnly: !anyKnown };
  }

  /**
   * Find the accept boundaries an edit to `abs` propagates to: `abs` itself if it
   * self-accepts, else its importers (transitively) up to the nearest self-accepting
   * modules. Returns null when propagation reaches a module the client graph never
   * imported (nothing to re-import → full reload).
   */
  function propagate(abs: string, seen: Set<string>): Set<string> | null {
    if (seen.has(abs)) return new Set();
    seen.add(abs);
    // Never seen in the client graph (a server-only module, or edited before load) → reload.
    if (!known.has(abs) && !importers.has(abs)) return null;
    // A component module self-accepts: its edit swaps in place via family substitution.
    if (accepting.has(abs)) return new Set([abs]);
    const ups = importers.get(abs);
    if (!ups || ups.size === 0) return null; // dead end, no accepting boundary
    const out = new Set<string>();
    for (const up of ups) {
      if (up.startsWith("entry:")) return null; // reached the route entry → reload
      const r = propagate(up, seen);
      if (r === null) return null;
      for (const b of r) out.add(b);
    }
    return out;
  }

  async function stop(): Promise<void> {
    await esbuild.stop().catch(() => {});
  }

  return {
    handle,
    entryUrlFor,
    spaEntryUrl,
    supportsRoute,
    serveFlightEntry,
    onChange,
    stop,
    // exposed for tests
    _internal: { transform, propagate, versionOf, ensureDeps },
  };
}

export type UnbundledDev = ReturnType<typeof createUnbundledDev>;
