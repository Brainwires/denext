// Shared esbuild `onLoad` scaffolding for the SPA-mode source transforms (Fast Refresh in
// dev, the auto-memo compiler in prod). Both transform only the app's own first-party
// source (`.tsx`/`.jsx` by default; Fast Refresh also claims `.ts` for hook metadata, and the
// prod feature fold the plain `.ts`/`.mts`/`.js`/`.mjs` modules that import `denext/feature`), skip
// npm deps and the generated entry wrapper, and are
// correctness-first: an unreadable file or a throwing transform leaves the module exactly as
// written. Factored here so each plugin only supplies its per-module transform.

import type * as esbuild from "esbuild";
import { SEPARATOR } from "@std/path";
import { hasPathSegment, inNodeModules } from "./path-segments.ts";

/** Options for {@linkcode firstPartyTsxPlugin}. */
export interface FirstPartyOnLoadOptions {
  /**
   * Which module paths the `onLoad` claims. Default `/\.(tsx|jsx)$/` (component source). A
   * matched `.ts` module is handed back with esbuild's `ts` loader (JSX would mis-parse
   * its `<T>x` casts); everything else keeps `tsx`.
   */
  filter?: RegExp;
  /**
   * A cheap pre-filter for a sparse transform: a claimed module whose source does not contain
   * this text, or that `transform` leaves unchanged, is handed back to the next loader (the
   * deno-loader) as if never claimed, so nothing else about its load changes.
   */
  deferUnless?: string;
}

/** The default `onLoad` filter: first-party component source only. */
const TSX_FILTER = /\.(tsx|jsx)$/;

/**
 * The esbuild loader a claimed module is returned under: `.ts`/`.mts` → `ts`, `.js`/`.mjs` →
 * the build's own loader for that extension (React Native mode parses `.js` as JSX) or `js`,
 * and component source → `tsx`.
 */
function loaderFor(path: string, build: esbuild.PluginBuild): esbuild.Loader {
  if (path.endsWith(".ts") || path.endsWith(".mts")) return "ts";
  const js = path.match(/\.m?js$/)?.[0];
  if (js) return build.initialOptions?.loader?.[js] ?? "js";
  return "tsx";
}

/** Whether `path` is `projectDir` or lies beneath it (a sibling like `/app-2` for `/app` does not). */
function isInsideProject(path: string, projectDir: string): boolean {
  const root = projectDir.endsWith(SEPARATOR) ? projectDir : projectDir + SEPARATOR;
  return path === projectDir || path.startsWith(root);
}

/**
 * An esbuild plugin whose `onLoad` runs `transform(source, absPath)` on each first-party app
 * module matching `options.filter` (default `.tsx`/`.jsx`). `transform` returns the new source, or `null` to leave it unchanged.
 * npm deps, the generated SPA entry wrapper, and anything outside `projectDir` are skipped;
 * an unreadable file or a throwing transform yields the module verbatim (never miscompiled).
 *
 * @param name The esbuild plugin name (for diagnostics).
 * @param projectDir Absolute project root — only source under it is transformed.
 * @param transform Per-module transform: `(source, absPath) → new source | null`.
 * @param options Optional `onLoad` filter (default: `.tsx`/`.jsx` only) and pre-filter text.
 */
export function firstPartyTsxPlugin(
  name: string,
  projectDir: string,
  transform: (source: string, path: string) => Promise<string | null> | string | null,
  options: FirstPartyOnLoadOptions = {},
): esbuild.Plugin {
  const filter = options.filter ?? TSX_FILTER;
  const { deferUnless } = options;
  return {
    name,
    setup(build) {
      build.onLoad({ filter }, async (args) => {
        // Only the app's own first-party source: skip npm deps and the generated SPA entry
        // wrapper (`.entries/index.tsx`), which has no components and whose `import` already
        // pulls the real modules in.
        if (
          inNodeModules(args.path) ||
          hasPathSegment(args.path, ".entries") ||
          !isInsideProject(args.path, projectDir)
        ) {
          return null; // let the deno-loader load it unchanged
        }
        let source: string;
        try {
          source = await Deno.readTextFile(args.path);
        } catch {
          return null; // unreadable → defer to the loader (which reports the error)
        }
        if (deferUnless !== undefined && !source.includes(deferUnless)) return null;
        const loader = loaderFor(args.path, build);
        try {
          const out = await transform(source, args.path);
          if (out == null && deferUnless !== undefined) return null; // unchanged → not claimed
          return { contents: out ?? source, loader };
        } catch {
          if (deferUnless !== undefined) return null; // best-effort → the loader loads it
          return { contents: source, loader }; // best-effort → the module bundles as written
        }
      });
    },
  };
}
