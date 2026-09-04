// Unbundled dev: the dependency pre-bundles — the native denext `@dep` set, the compat
// react→denext runtime, and the compat on-demand npm bundle (Vite optimizeDeps).

import { denoPlugins } from "@luca/esbuild-deno-loader";
import * as esbuild from "esbuild";
import { ensureDir } from "@std/fs";
import {
  BROWSER_CONDITIONS,
  catalogResolverPlugin,
  nodeBuiltinStubPlugin,
  prebuildDenextRuntime,
} from "../next-compat.ts";
import { compatDepUrl, ensureMergedConfig } from "./resolve.ts";
import { DEP_ENTRYPOINTS, depSlug, type UnbundledState } from "./state.ts";

/** Bundle the native denext `@dep` set once (shared core hoisted into one chunk). */
async function buildDeps(st: UnbundledState): Promise<void> {
  const cfg = await ensureMergedConfig(st);
  // Resolve each denext dep to its framework source URL (file:// from a checkout,
  // https:// from JSR) so the deno-loader can fetch it either way.
  const base = new URL("../../../", import.meta.url).href;
  const entryPoints: Record<string, string> = {};
  for (const [slug, rel] of Object.entries(DEP_ENTRYPOINTS)) {
    entryPoints[slug] = new URL(rel, base).href;
  }
  await ensureDir(st.depDir);
  await esbuild.build({
    entryPoints,
    outdir: st.depDir,
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
}

/** The native `@dep` pre-bundle (built once, awaited by every caller). */
export function ensureDeps(st: UnbundledState): Promise<void> {
  return st.depsBuilt ??= buildDeps(st);
}

/**
 * compat: prebuild the react→denext runtime (react/react-dom/next/* + denext client,
 * jsx, live, lazy) into ONE shared graph (esbuild `splitting` → a single denext
 * instance). Served under DEP_PREFIX; the app's own react/npm imports point here.
 */
function ensureRuntime(st: UnbundledState): Promise<void> {
  return st.runtimeBuilt ??= prebuildDenextRuntime({
    outDir: st.runtimeDir,
    configPath: st.opts.configPath,
    classComponents: st.opts.classComponents ?? true,
  }).then(() => {});
}

/** The @dep pre-bundle the client entry needs before it runs: runtime (compat) or denext (native). */
export function ensureClientDeps(st: UnbundledState): Promise<void> {
  return st.compat ? ensureRuntime(st) : ensureDeps(st);
}

/**
 * compat: an esbuild plugin marking react-family / next/* / denext-runtime specifiers
 * EXTERNAL, pointing at the shared prebuilt runtime's dev URLs — so an npm package's
 * own `import "react"` resolves to denext's single React (never a second copy).
 */
function runtimeExternalPlugin(st: UnbundledState): esbuild.Plugin {
  return {
    name: "denext-runtime-external",
    setup(build) {
      build.onResolve(
        {
          filter:
            /^react$|^react\/|^react-dom$|^react-dom\/|^react-is$|^next$|^next\/|^denext(\/|$)/,
        },
        (args) => {
          const u = compatDepUrl(st, args.path);
          return u ? { path: u, external: true } : null;
        },
      );
    },
  };
}

/** One npm optimizeDeps pass over every discovered specifier (see ensureNpmBundle). */
async function buildNpmBundle(st: UnbundledState): Promise<void> {
  const specs = [...st.npmSpecs];
  const entryPoints: Record<string, string> = {};
  for (const s of specs) entryPoints[depSlug(s)] = s;
  await ensureDir(st.npmDir);
  await esbuild.build({
    entryPoints,
    outdir: st.npmDir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    sourcemap: "inline",
    jsx: "automatic",
    jsxImportSource: "react",
    absWorkingDir: st.opts.projectDir,
    logLevel: "silent",
    plugins: [
      runtimeExternalPlugin(st),
      catalogResolverPlugin(st.opts.projectDir, "all", BROWSER_CONDITIONS),
      nodeBuiltinStubPlugin(),
    ],
  });
  st.npmBuilt = new Set(specs);
}

/**
 * compat: on-demand npm dependency bundle (Vite optimizeDeps). ALL discovered npm
 * specifiers are bundled together in one `splitting` pass so packages sharing a
 * transitive dep get one instance; `react` is external (shared runtime). Rebuilt when
 * a newly-transformed module discovers a spec not yet in the bundle.
 */
export async function ensureNpmBundle(st: UnbundledState): Promise<void> {
  while (st.npmBuilding) await st.npmBuilding;
  if (st.npmSpecs.size === 0) return;
  if ([...st.npmSpecs].every((s) => st.npmBuilt.has(s))) return;
  st.npmBuilding = buildNpmBundle(st);
  try {
    await st.npmBuilding;
  } finally {
    st.npmBuilding = null;
  }
}
