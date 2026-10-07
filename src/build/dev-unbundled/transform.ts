// Unbundled dev: the per-module transform (one first-party file → browser ESM with its
// imports rewritten to dev URLs) and the transform of a GENERATED entry module.

import * as esbuild from "esbuild";
import { dirname, fromFileUrl, toFileUrl } from "@std/path";
import { collectComponents, refreshFooter } from "../spa-refresh-plugin.ts";
import { transformFeatures } from "../feature-transform.ts";
import { momentumScrollSeed } from "../bundle.ts";
import { parseModule } from "../swc-ast.ts";
import { generateServerStub } from "../client-imports.ts";
import { scanDirective } from "../directives.ts";
import { serverModuleIdFor } from "../boundary-ids.ts";
import { staticExportNames } from "../module-graph.ts";
import { importedNames, prepareReactNativeSource } from "./react-native.ts";
import {
  firstPartyProbe,
  firstPartyResolver,
  resolveFirstParty,
  rewriteSpecifier,
} from "./resolve.ts";
import type { Platform } from "../platform-extensions.ts";
import {
  addImporter,
  loaderFor,
  norm,
  type TransformEntry,
  transformKey,
  type UnbundledState,
  versionOf,
} from "./state.ts";

/** Shared esbuild options: transform ONE module, everything else externalized. */
function singleModuleBuild(
  entryPoints: string[],
  plugins: esbuild.Plugin[],
  define?: Record<string, string>,
): Promise<esbuild.BuildResult<{ write: false }>> {
  return esbuild.build({
    entryPoints,
    define,
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
function cachedTransform(st: UnbundledState, key: string, mtimeMs: number): TransformEntry | null {
  const hit = st.cache.get(key);
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
 * gets the Fast Refresh footer registering each export's family — plus the dev-only
 * DevTools metadata sidecar (source position + hook names). A module of custom hooks only
 * gets the sidecar alone and stays non-accepting (an edit still propagates to its
 * importers). Returns the footer.
 */
async function refreshFooterFor(
  st: UnbundledState,
  abs: string,
  entry: TransformEntry,
  source: string,
  imported: Map<string, Set<string>>,
  platform: Platform,
): Promise<string> {
  try {
    const parsed = await parseModule(source);
    // React Native mode: what the module takes from each package, for its dependency entry.
    if (parsed && st.opts.reactNative) {
      for (const [spec, set] of importedNames(parsed)) imported.set(spec, set);
    }
    const url = toFileUrl(abs).href;
    // Import-map aliases resolve as the rewrite resolves them, so a hook imported by `@/…` is named.
    const firstParty = await firstPartyResolver(st, abs, platform);
    const resolveSpec = (spec: string) => {
      const hit = firstParty(spec);
      return hit ? toFileUrl(hit).href : undefined;
    };
    const { names, metas } = parsed
      ? collectComponents(parsed, url, resolveSpec)
      : { names: [], metas: {} };
    if (names.length > 0) {
      entry.selfAccepting = true;
      st.accepting.add(abs);
    } else st.accepting.delete(abs); // e.g. a component was removed by the edit
    return refreshFooter(url, names, metas);
  } catch { /* unparsable — no footer, treated as non-accepting */ }
  return "";
}

/**
 * The module's source as it is served: as written, or — in React Native mode — with the
 * worklets transform and the `require` hoist applied ({@linkcode prepareReactNativeSource}).
 * A `"use server"` module is served as its action stub instead ({@linkcode actionStub}): its
 * source never reaches the browser. Null when it cannot be read (esbuild then reports the
 * missing file).
 */
async function servedSource(
  st: UnbundledState,
  abs: string,
): Promise<{ source: string | null; action: boolean }> {
  let source: string;
  try {
    source = await Deno.readTextFile(abs);
  } catch {
    return { source: null, action: false };
  }
  if (scanDirective(source) === "server") {
    return { source: await actionStub(st, abs), action: true };
  }
  return {
    source: st.opts.reactNative ? await prepareReactNativeSource(abs, source) : source,
    action: false,
  };
}

/**
 * The action stub the browser gets for the `"use server"` module at `abs`: the dev boundary's
 * id and exports for it, else the id the boundary gives a module (its real path under the app
 * dir) and its static export names.
 */
async function actionStub(st: UnbundledState, abs: string): Promise<string> {
  const url = toFileUrl(await Deno.realPath(abs).catch(() => abs)).href;
  for (const [id, ref] of st.opts.serverModules?.() ?? []) {
    if (ref.url === url || ref.url === toFileUrl(abs).href) {
      return generateServerStub(id, ref.exports);
    }
  }
  return generateServerStub(serverModuleIdFor(st.opts.appDir, url), await staticExportNames(abs));
}

/** esbuild plugin: load `abs` (+ footer), externalize + rewrite every import it makes. */
function moduleRewritePlugin(
  st: UnbundledState,
  abs: string,
  loaded: { source: string | null; footer: string; names: Map<string, Set<string>> },
  entry: TransformEntry,
  platform: Platform,
): esbuild.Plugin {
  const { footer, names } = loaded;
  return {
    name: "denext-dev-rewrite",
    setup(build) {
      // Load the entry with the Fast Refresh footer appended (its `denext/client`
      // import is rewritten to the dep below). Only the entry is loaded — every
      // other import is externalized — so this fires once.
      build.onLoad({ filter: /.*/ }, async (args) => {
        if (args.path !== abs) return null;
        let src = loaded.source ?? await Deno.readTextFile(abs);
        // Fold `feature("KEY")` calls so dev matches a build (values, not DCE). Only when the
        // app configured `features`; a throwing fold leaves the source as written.
        const features = st.opts.features;
        if (features && Object.keys(features).length > 0) {
          try {
            const folded = await transformFeatures(src, features);
            if (folded.changed) src = folded.code;
          } catch { /* best-effort — bundle the module as written */ }
        }
        return {
          contents: src + footer,
          loader: loaderFor(abs, st.opts.reactNative !== undefined),
          resolveDir: dirname(abs),
        };
      });
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === "entry-point") return null;
        const firstParty = await resolveFirstParty(st, args.path, args.importer || abs, platform);
        if (firstParty) addImporter(st, firstParty, abs);
        return {
          path: rewriteSpecifier(st, args.path, firstParty, entry, names.get(args.path)),
          external: true,
        };
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
export async function transform(
  st: UnbundledState,
  abs: string,
  platform: Platform = "web",
): Promise<TransformEntry> {
  const mtimeMs = await mtimeOf(abs);
  const key = transformKey(abs, platform);
  const hit = cachedTransform(st, key, mtimeMs);
  if (hit) return hit;

  const entry: TransformEntry = { mtimeMs, code: "", deps: [], selfAccepting: false };
  st.known.add(abs);
  const { source, action } = await servedSource(st, abs);
  const names = new Map<string, Set<string>>();
  // An action stub registers no components (an edit to the action reloads its importers).
  const footer = source === null || action
    ? ""
    : await refreshFooterFor(st, abs, entry, source, names, platform);
  // No deno-loader: every import is externalized by the rewrite plugin, so esbuild only
  // transforms this one file (JSX/TS via its built-in loaders) — a warm rebuild is
  // ~5ms, the property that makes per-module HMR feel instant.
  const result = await singleModuleBuild(
    [abs],
    [moduleRewritePlugin(st, abs, { source, footer, names }, entry, platform)],
    st.opts.define,
  );
  entry.code = outputText(result);
  st.cache.set(key, entry);
  return entry;
}

const ENTRY_NS = "denext-entry";

/** esbuild plugin: serve the virtual generated entry and rewrite its imports. */
function entryRewritePlugin(
  st: UnbundledState,
  src: string,
  importerKey: string,
  sink: TransformEntry,
  platform: Platform,
): esbuild.Plugin {
  const { appDir } = st.opts;
  // A page / island the entry names by file URL takes the target's platform file too.
  const probe = firstPartyProbe(st, platform);
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
          ? norm(probe(fromFileUrl(args.path)) ?? fromFileUrl(args.path))
          : await resolveFirstParty(st, args.path, args.importer || appDir, platform);
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
  platform: Platform = "web",
): Promise<string> {
  const sink: TransformEntry = { mtimeMs: 0, code: "", deps: [], selfAccepting: true };
  const seeded = momentumScrollSeed(st.opts.momentumSafeScroll) + src;
  const result = await singleModuleBuild([ENTRY_NS], [
    entryRewritePlugin(st, seeded, importerKey, sink, platform),
  ]);
  return outputText(result);
}
