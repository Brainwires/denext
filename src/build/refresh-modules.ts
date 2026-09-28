// Fast Refresh family registrations for the BUNDLED dev paths that build with `deno bundle`.
//
// The esbuild paths get them from `spaRefreshPlugin` (an onLoad hook) and the unbundled loop
// from its per-module transform; `deno bundle` takes no load plugins. Without this, a bundled
// denext-native SPA registered no component at all (every edit remounted the whole app) and the
// bundled App Router only its route-structural components and client-reference exports (an
// edit remounted every other component: a row, a card, a form field lost its state).
//
// Each app module that declares a component is instrumented ahead of the bundle — the same
// `registerFamily` + DevTools-metadata footer the plugin appends — written to a temp dir with
// its relative imports absolutized, and substituted through the bundle's import map (the
// mechanism the feature fold, the auto-memo compiler and the qrl extraction use).

import { fromFileUrl, join, toFileUrl } from "@std/path";
import { collectComponents, refreshFooter } from "./spa-refresh-plugin.ts";
import {
  absolutizeSpecifiers,
  applyEdits,
  type Edit,
  parseModule,
  writeTransformedModules,
} from "./swc-ast.ts";
import { appSourceFiles, type SpaModuleRedirects } from "./spa/features.ts";

/**
 * A module relocated to a temp dir must not resolve anything against its own URL other than its
 * static imports (which are absolutized): `import.meta` and a relative dynamic `import()` would
 * point into the temp dir. Such a module is left as written (its components remount on edit).
 */
const PINNED_TO_LOCATION = /import\.meta|import\s*\(\s*["'`]\.{1,2}\//;

/** Component source: JSX modules. */
const JSX_MODULE = /\.[jt]sx$/;

/**
 * One module with its Fast Refresh footer appended and its relative imports absolutized, or
 * unchanged when it declares no component (or cannot be relocated).
 *
 * @param source The module source.
 * @param url The module's ORIGINAL `file://` URL (the family id prefix).
 * @param base Where `source` lives, which its relative imports resolve against (`url`, or an
 *   earlier pass's output).
 */
async function instrumentForRefresh(
  source: string,
  url: string,
  base = url,
): Promise<{ code: string; changed: boolean }> {
  const unchanged = { code: source, changed: false };
  if (PINNED_TO_LOCATION.test(source)) return unchanged;
  const parsed = await parseModule(source);
  if (!parsed) return unchanged;
  const { names, metas } = collectComponents(parsed, url);
  if (names.length === 0) return unchanged; // hook-only and plain modules stay in place
  const edits: Edit[] = [];
  absolutizeSpecifiers(parsed.ctx, parsed.body, base, edits);
  const code = applyEdits(parsed.ctx.bytes, edits) + refreshFooter(url, names, metas);
  return { code, changed: true };
}

/**
 * Instrument each component module in `files` into `<outDir>/refresh`, over an earlier pass's
 * output where `prior` has one (so it composes with the auto-memo compiler / qrl extraction).
 *
 * @returns `original module URL → instrumented module URL`, including `prior`'s other entries.
 */
export async function compileRefreshModules(
  files: string[],
  prior: Record<string, string>,
  opts: { outDir: string },
): Promise<Record<string, string>> {
  const map = await writeTransformedModules(
    files.filter((f) => JSX_MODULE.test(f)),
    join(opts.outDir, "refresh"),
    (source, url) => instrumentForRefresh(source, url, prior[url]),
    (file) => {
      const transformed = prior[toFileUrl(file).href];
      return transformed ? fromFileUrl(transformed) : file;
    },
  );
  return { ...prior, ...map };
}

/**
 * The bundled denext-native SPA's dev registrations: every component module under
 * `projectDir`, instrumented into a temp dir.
 *
 * @param projectDir The app's root.
 * @returns The import-map redirects and their cleanup.
 */
export async function spaNativeRefresh(projectDir: string): Promise<SpaModuleRedirects> {
  const outDir = await Deno.makeTempDir({ prefix: "denext_spa_refresh_" });
  const importMap = await compileRefreshModules(await appSourceFiles(projectDir), {}, { outDir });
  return {
    importMap,
    cleanup: () => Deno.remove(outDir, { recursive: true }).catch(() => {}),
  };
}
