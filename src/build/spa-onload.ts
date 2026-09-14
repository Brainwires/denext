// Shared esbuild `onLoad` scaffolding for the SPA-mode source transforms (Fast Refresh in
// dev, the auto-memo compiler in prod). Both transform only the app's own first-party
// source (`.tsx`/`.jsx` by default; Fast Refresh also claims `.ts` for hook metadata), skip
// npm deps and the generated entry wrapper, and are
// correctness-first: an unreadable file or a throwing transform leaves the module exactly as
// written. Factored here so each plugin only supplies its per-module transform.

import type * as esbuild from "esbuild";

/** Options for {@linkcode firstPartyTsxPlugin}. */
export interface FirstPartyOnLoadOptions {
  /**
   * Which module paths the `onLoad` claims. Default `/\.(tsx|jsx)$/` (component source). A
   * matched `.ts` module is handed back with esbuild's `ts` loader (JSX would mis-parse
   * its `<T>x` casts); everything else keeps `tsx`.
   */
  filter?: RegExp;
}

/** The default `onLoad` filter: first-party component source only. */
const TSX_FILTER = /\.(tsx|jsx)$/;

/** The esbuild loader a claimed module is returned under. */
function loaderFor(path: string): esbuild.Loader {
  return path.endsWith(".ts") ? "ts" : "tsx";
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
 * @param options Optional `onLoad` filter (default: `.tsx`/`.jsx` only).
 */
export function firstPartyTsxPlugin(
  name: string,
  projectDir: string,
  transform: (source: string, path: string) => Promise<string | null> | string | null,
  options: FirstPartyOnLoadOptions = {},
): esbuild.Plugin {
  const filter = options.filter ?? TSX_FILTER;
  return {
    name,
    setup(build) {
      build.onLoad({ filter }, async (args) => {
        // Only the app's own first-party source: skip npm deps and the generated SPA entry
        // wrapper (`.entries/index.tsx`), which has no components and whose `import` already
        // pulls the real modules in.
        if (
          args.path.includes("/node_modules/") ||
          args.path.includes("/.entries/") ||
          !args.path.startsWith(projectDir)
        ) {
          return null; // let the deno-loader load it unchanged
        }
        let source: string;
        try {
          source = await Deno.readTextFile(args.path);
        } catch {
          return null; // unreadable → defer to the loader (which reports the error)
        }
        const loader = loaderFor(args.path);
        try {
          const out = await transform(source, args.path);
          return { contents: out ?? source, loader };
        } catch {
          return { contents: source, loader }; // best-effort → the module bundles as written
        }
      });
    },
  };
}
