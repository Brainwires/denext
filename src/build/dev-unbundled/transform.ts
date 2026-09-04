// Unbundled dev: the per-module transform (one first-party file → browser ESM with its
// imports rewritten to dev URLs) and the transform of a GENERATED entry module.

import * as esbuild from "esbuild";
import { dirname, fromFileUrl, toFileUrl } from "@std/path";
import { collectComponentNames, refreshFooter } from "../spa-refresh-plugin.ts";
import { swcParse } from "../swc-ast.ts";
import { resolveFirstParty, rewriteSpecifier } from "./resolve.ts";
import {
  addImporter,
  loaderFor,
  norm,
  type TransformEntry,
  type UnbundledState,
  versionOf,
} from "./state.ts";

/** Shared esbuild options: transform ONE module, everything else externalized. */
function singleModuleBuild(
  entryPoints: string[],
  plugins: esbuild.Plugin[],
): Promise<esbuild.BuildResult<{ write: false }>> {
  return esbuild.build({
    entryPoints,
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    jsxImportSource: "denext",
    sourcemap: "inline",
    logLevel: "silent",
    plugins,
  });
}

function outputText(result: esbuild.BuildResult<{ write: false }>): string {
  return new TextDecoder().decode(result.outputFiles![0].contents);
}

/** The cached transform of `abs` if its source and every dep version are unchanged. */
function cachedTransform(st: UnbundledState, abs: string, mtimeMs: number): TransformEntry | null {
  const hit = st.cache.get(abs);
  if (!hit || hit.mtimeMs !== mtimeMs) return null;
  return hit.deps.every((d) => versionOf(st, d.abs) === d.v) ? hit : null;
}

async function mtimeOf(abs: string): Promise<number> {
  try {
    return (await Deno.stat(abs)).mtime?.getTime() ?? 0;
  } catch {
    return 0; // missing — esbuild reports it
  }
}

/**
 * Component detection (best-effort): a module exporting ≥1 component self-accepts and
 * gets the Fast Refresh footer registering each export's family. Returns the footer.
 */
async function refreshFooterFor(
  st: UnbundledState,
  abs: string,
  entry: TransformEntry,
): Promise<string> {
  try {
    const source = await Deno.readTextFile(abs);
    const names = collectComponentNames(await (await swcParse())(source));
    if (names.length > 0) {
      entry.selfAccepting = true;
      st.accepting.add(abs);
      return refreshFooter(toFileUrl(abs).href, names);
    }
    st.accepting.delete(abs); // e.g. a component was removed by the edit
  } catch { /* unreadable/unparsable — no footer, treated as non-accepting */ }
  return "";
}

/** esbuild plugin: load `abs` (+ footer), externalize + rewrite every import it makes. */
function moduleRewritePlugin(
  st: UnbundledState,
  abs: string,
  footer: string,
  entry: TransformEntry,
): esbuild.Plugin {
  return {
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
        const firstParty = await resolveFirstParty(st, args.path, args.importer || abs);
        if (firstParty) addImporter(st, firstParty, abs);
        return { path: rewriteSpecifier(st, args.path, firstParty, entry), external: true };
      });
    },
  };
}

/**
 * Transform + rewrite one first-party module for the browser (cached by mtime and
 * its deps' versions). Externalizes every import to a dev URL and, for a component
 * module, appends the Fast Refresh footer that registers each export's family (the
 * hook that makes an edit swap in place).
 */
export async function transform(st: UnbundledState, abs: string): Promise<TransformEntry> {
  const mtimeMs = await mtimeOf(abs);
  const hit = cachedTransform(st, abs, mtimeMs);
  if (hit) return hit;

  const entry: TransformEntry = { mtimeMs, code: "", deps: [], selfAccepting: false };
  st.known.add(abs);
  const footer = await refreshFooterFor(st, abs, entry);
  // No deno-loader: every import is externalized by the rewrite plugin, so esbuild only
  // transforms this one file (JSX/TS via its built-in loaders) — a warm rebuild is
  // ~5ms, the property that makes per-module HMR feel instant.
  const result = await singleModuleBuild([abs], [moduleRewritePlugin(st, abs, footer, entry)]);
  entry.code = outputText(result);
  st.cache.set(abs, entry);
  return entry;
}

const ENTRY_NS = "denext-entry";

/** esbuild plugin: serve the virtual generated entry and rewrite its imports. */
function entryRewritePlugin(
  st: UnbundledState,
  src: string,
  importerKey: string,
  sink: TransformEntry,
): esbuild.Plugin {
  const { appDir } = st.opts;
  return {
    name: "denext-dev-entry-rewrite",
    setup(build) {
      // The virtual entry: resolve the synthetic id (incl. as an entry point) into
      // our namespace, and load it from the generated source.
      build.onResolve(
        { filter: /^denext-entry$/ },
        () => ({ path: ENTRY_NS, namespace: ENTRY_NS }),
      );
      build.onLoad({ filter: /.*/, namespace: ENTRY_NS }, () => ({
        contents: src,
        loader: "tsx",
        resolveDir: appDir,
      }));
      // Externalize + rewrite every import the entry makes (the synthetic entry id is
      // claimed by the resolve above, so this only ever sees the entry's own imports:
      // page/layouts/islands by `file://` URL and `denext/*` by bare specifier).
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.path === ENTRY_NS) return null; // handled above
        const firstParty = args.path.startsWith("file://")
          ? norm(fromFileUrl(args.path))
          : await resolveFirstParty(st, args.path, args.importer || appDir);
        if (firstParty) addImporter(st, firstParty, importerKey);
        return { path: rewriteSpecifier(st, args.path, firstParty, sink), external: true };
      });
    },
  };
}

/**
 * Transform a GENERATED entry module (route or flight) so its `denext/*` and its
 * page/layout/island imports become dev URLs, and record the imported first-party
 * modules as importers of `importerKey`. The entry is regenerated per request; its
 * recorded deps go to a throwaway sink (only real source modules are cached), but its
 * importer edges DO go into the graph so HMR propagation can decide reload vs update.
 */
export async function transformGeneratedEntry(
  st: UnbundledState,
  src: string,
  importerKey: string,
): Promise<string> {
  const sink: TransformEntry = { mtimeMs: 0, code: "", deps: [], selfAccepting: true };
  const result = await singleModuleBuild([ENTRY_NS], [
    entryRewritePlugin(st, src, importerKey, sink),
  ]);
  return outputText(result);
}
