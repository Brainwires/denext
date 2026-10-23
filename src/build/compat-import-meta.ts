// `import.meta` in the next-compat SERVER bundle: each app module keeps naming its own source file.
//
// The compat server side is ONE esbuild bundle under `.denext/server/`, so every module bundled
// into it would see the bundle's `import.meta.url`: `fs.readFile(new URL("./font.ttf",
// import.meta.url))` in a route (an OG image route loading its font, as Next.js supports) read
// `.denext/server/font.ttf` and failed. Next's server build keeps the source module's URL. This
// pins `import.meta.url` / `.filename` / `.dirname` / `.resolve` in each of the app's own modules
// to the source file (the server copies' {@linkcode pinImportMeta}), relative to the bundle's
// own URL, so the project and its `.denext` can move together: a container image, or a
// `denext build --compile` binary, which embeds `app/` (its sibling files included) under
// another root.

import { dirname, extname, join, toFileUrl } from "@std/path";
import type * as esbuild from "./esbuild/mod.ts";
import { isInside } from "./compat-chain.ts";
import { wrapOnLoad } from "./onload-wrap.ts";
import { inNodeModules } from "./path-segments.ts";
import { pinImportMeta } from "./swc-ast.ts";

/** The JS/TS modules pinned. */
const SOURCE_MODULE = /\.(?:[cm]?[jt]sx?)$/;

/** Where the pins apply and what they are relative to. */
export interface ImportMetaPinOptions {
  /** The project root: only its own modules (outside `node_modules` and the build dir) are pinned. */
  projectDir: string;
  /** The build dir (`.denext`): generated modules there keep the bundle's `import.meta`. */
  buildDir: string;
  /**
   * The directory the bundle's modules are written to, which the pins are relative to; omit for
   * absolute pins (a build whose outputs do not all sit in one directory).
   */
  outdir?: string;
  /** Parse `.js` as JSX (the bundle's own `.js` loader). */
  jsxInJs?: boolean;
}

/**
 * `plugins` with the app modules they load pinned (see the module comment), followed by a loader
 * for an app module none of them answers that names `import.meta` (esbuild's own loading would
 * leave it unpinned).
 *
 * @param plugins The server bundle's plugins, in precedence order.
 * @param options Where the pins apply.
 */
export function pinImportMetaPlugins(
  plugins: esbuild.Plugin[],
  options: ImportMetaPinOptions,
): esbuild.Plugin[] {
  const pin = pinner(options);
  const wrapped = wrapOnLoad(plugins, async (result, args) => {
    if (!result || result.contents === undefined || args.namespace !== "file") return result;
    const code = typeof result.contents === "string"
      ? result.contents
      : new TextDecoder().decode(result.contents);
    const out = await pin(code, args.path);
    return out === null ? result : { ...result, contents: out };
  });
  return [...wrapped, {
    name: "denext-import-meta-pin",
    setup(build) {
      build.onLoad({ filter: SOURCE_MODULE, namespace: "file" }, async (args) => {
        if (!owned(args.path, options)) return undefined;
        const code = await Deno.readTextFile(args.path);
        const out = await pin(code, args.path);
        if (out === null) return undefined;
        return {
          contents: out,
          loader: loaderFor(args.path, options.jsxInJs),
          resolveDir: dirname(args.path),
        };
      });
    },
  }];
}

/** The pin for one module's code, or `null` when it is not pinned (or names no `import.meta`). */
function pinner(
  options: ImportMetaPinOptions,
): (code: string, path: string) => Promise<string | null> {
  const copyUrl = options.outdir === undefined
    ? undefined
    : toFileUrl(join(options.outdir, "app.js")).href;
  return async (code, path) => {
    if (!code.includes("import.meta") || !owned(path, options)) return null;
    const out = await pinImportMeta(code, toFileUrl(path).href, { copyUrl });
    return out === code ? null : out;
  };
}

/** Whether `path` is one of the app's own source modules. */
function owned(path: string, options: ImportMetaPinOptions): boolean {
  return SOURCE_MODULE.test(path) && !inNodeModules(path) && isInside(path, options.projectDir) &&
    !isInside(path, options.buildDir);
}

/** The esbuild loader for a source module by its extension. */
function loaderFor(path: string, jsxInJs?: boolean): esbuild.Loader {
  const ext = extname(path).slice(1);
  if (ext === "ts" || ext === "tsx" || ext === "jsx") return ext;
  if (ext === "mts" || ext === "cts") return "ts";
  return ext === "js" && jsxInJs ? "jsx" : "js";
}
