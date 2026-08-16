// CSS pipeline: transform `.css` / `.module.css` with lightningcss, and bridge
// the bundler-less server + the browser bundle over the same seam.
//
// Deno cannot `import` a `.css` module (neither the server's runtime `import()`
// nor `deno bundle`). We resolve this by generating, per CSS file, a tiny JS
// *shim* module and an import-map entry redirecting the `.css` URL to it:
//   - a `*.module.css` shim exports (as `default`) the local→scoped class map,
//     so `import s from "./x.module.css"; s.title` yields the hashed name on both
//     server and client;
//   - a global `.css` shim exports `{}` (the import is a side effect; the actual
//     CSS is extracted and delivered via a `<link>`).
// The extracted, transformed CSS is collected separately and emitted next to the
// route bundle.

import { dirname, fromFileUrl, join, relative, resolve, toFileUrl } from "@std/path";
import { ensureDir, walk } from "@std/fs";
import { denoExecutable, frameworkRoot } from "./bundle.ts";
import { compileTailwind } from "./tailwind.ts";

/** Result of transforming one CSS file. */
export interface CssTransform {
  /** The transformed CSS text (prefixed, nested-flattened, optionally minified). */
  css: string;
  /**
   * For a CSS module, the local→scoped class map (`{ title: "aB3_title" }`);
   * empty for a global stylesheet.
   */
  exports: Record<string, string>;
}

/** True for a CSS module file (`*.module.css`), whose classes are scoped. */
export function isCssModule(path: string): boolean {
  return /\.module\.css$/i.test(path);
}

/** True for any CSS file (`*.css`). */
export function isCss(path: string): boolean {
  return /\.css$/i.test(path);
}

// lightningcss-wasm must be initialized once before `transform` is callable.
let lightningReady: Promise<typeof import("lightningcss-wasm")> | null = null;
function lightning(): Promise<typeof import("lightningcss-wasm")> {
  if (!lightningReady) {
    lightningReady = (async () => {
      const mod = await import("lightningcss-wasm");
      await mod.default();
      return mod;
    })();
  }
  return lightningReady;
}

/**
 * Transform a CSS source string with lightningcss. When `cssModules` is set,
 * class names are scoped and the local→scoped map is returned in `exports`.
 *
 * @param source The raw CSS text.
 * @param filename The file name (used for the scope hash and diagnostics).
 * @param opts Transform options.
 */
export async function transformCss(
  source: string,
  filename: string,
  opts: { cssModules?: boolean; minify?: boolean } = {},
): Promise<CssTransform> {
  const { transform } = await lightning();
  const result = transform({
    filename,
    code: new TextEncoder().encode(source),
    cssModules: opts.cssModules ?? false,
    minify: opts.minify ?? false,
  });
  const exports: Record<string, string> = {};
  if (result.exports) {
    for (const [local, info] of Object.entries(result.exports)) {
      // The applied class list is the scoped name plus any `composes:` targets.
      const names = [info.name, ...(info.composes ?? []).map((c) => c.name)];
      exports[local] = names.join(" ");
    }
  }
  return { css: new TextDecoder().decode(result.code), exports };
}

/**
 * Discover every `.css` file reachable from the given entry modules by crawling
 * the import graph with `deno info`. Deno flags `.css` imports as errors
 * ("identified a Css module") but still reports their specifiers, so we collect
 * those rather than skipping them the way {@link crawlLocalModules} does.
 *
 * @param entryFiles Absolute paths of the modules to crawl from.
 * @returns Absolute paths of all `.css` files in the graph (sorted, unique).
 */
export async function discoverCssFiles(entryFiles: string[]): Promise<string[]> {
  if (entryFiles.length === 0) return [];
  const tmpDir = await Deno.makeTempDir({ prefix: "denext_css_graph_" });
  const barrel = join(tmpDir, "barrel.ts");
  try {
    const body = entryFiles.map((f) => `import ${JSON.stringify(toFileUrl(f).href)};`).join("\n");
    await Deno.writeTextFile(barrel, body + "\n");
    const command = new Deno.Command(denoExecutable(), {
      // sloppy-imports so extensionless Next.js app imports resolve in the CSS
      // graph crawl (permissive fallback; see runDenoBundle in bundle.ts).
      args: ["info", "--unstable-sloppy-imports", "--json", barrel],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await command.output();
    if (code !== 0) {
      throw new Error(`deno info failed (${code}):\n${new TextDecoder().decode(stderr)}`);
    }
    const info = JSON.parse(new TextDecoder().decode(stdout)) as {
      modules: Array<{ specifier: string }>;
    };
    const found = new Set<string>();
    for (const m of info.modules) {
      if (m.specifier.startsWith("file://") && isCss(m.specifier)) {
        found.add(fromFileUrl(m.specifier));
      }
    }
    return [...found].sort();
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

/** The generated CSS assets for a set of source files. */
export interface CssAssets {
  /**
   * Import-map redirects (`css file URL` → `shim file URL`) so both the server
   * `import()` and `deno bundle` resolve every `.css` import to its shim.
   */
  importMap: Record<string, string>;
  /** Transformed CSS text keyed by absolute source path (empty when no CSS). */
  css: Map<string, string>;
  /** Scoped class maps keyed by absolute source path (CSS modules only). */
  classMaps: Map<string, Record<string, string>>;
}

/**
 * Transform each CSS file and write its JS shim into `shimDir`, returning the
 * import-map redirects plus the extracted CSS and class maps.
 *
 * @param cssFiles Absolute paths of the `.css` files to process.
 * @param shimDir Directory to write the generated shim modules into.
 * @param opts Minify flag.
 */
export async function generateCssAssets(
  cssFiles: string[],
  shimDir: string,
  opts: { minify?: boolean } = {},
): Promise<CssAssets> {
  const importMap: Record<string, string> = {};
  const css = new Map<string, string>();
  const classMaps = new Map<string, Record<string, string>>();

  await Promise.all(cssFiles.map(async (file, i) => {
    const source = await Deno.readTextFile(file);
    const isModule = isCssModule(file);
    const t = await transformCss(source, file, { cssModules: isModule, minify: opts.minify });
    css.set(file, t.css);
    classMaps.set(file, t.exports);

    // The shim gives server + client a real module to import in place of the CSS.
    const shimBody = isModule
      ? `export default ${JSON.stringify(t.exports)};\n`
      : `export default {};\n`;
    const shimPath = join(shimDir, `css_${i}.js`);
    await Deno.writeTextFile(shimPath, shimBody);
    importMap[toFileUrl(file).href] = toFileUrl(shimPath).href;
  }));

  return { importMap, css, classMaps };
}

/** Concatenate transformed CSS in a stable (path-sorted) order. */
export function concatCss(css: Map<string, string>): string {
  return [...css.keys()].sort().map((k) => css.get(k)!).filter((s) => s.trim().length > 0)
    .join("\n");
}

/** Resolve an import-map `imports` table's relative values to absolute file URLs. */
function normalizeImports(
  imports: Record<string, string>,
  baseDir: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(imports)) {
    out[key] = (value.startsWith("./") || value.startsWith("../"))
      ? toFileUrl(resolve(baseDir, value)).href
      : value;
  }
  return out;
}

// deno-lint-ignore no-explicit-any
async function readJson(path: string): Promise<any> {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch {
    return {};
  }
}

/** Read a config file's `imports` map (empty when the file is absent/invalid). */
async function readImports(configPath: string): Promise<Record<string, string>> {
  const cfg = await readJson(configPath);
  return normalizeImports(cfg.imports ?? {}, dirname(configPath));
}

/** Result of {@linkcode buildAppCss}: everything needed by server + client + docs. */
export interface AppCss extends CssAssets {
  /**
   * Path to a generated deno config (`--config` for the module loader) whose
   * `imports` redirect every `.css` to its shim. A config (not a bare import
   * map) is used so native jsr/npm subpath resolution still works.
   */
  configPath: string;
  /** Absolute paths of every `.css` file discovered in the project. */
  cssFiles: string[];
}

/**
 * Build the whole project's CSS assets: scan for `.css` files, transform each,
 * write a JS shim per file, and emit a merged deno config (framework + project
 * imports normalized to absolute, plus the CSS redirects) so the module loader —
 * and `deno bundle` (via {@linkcode CssAssets.importMap}) — can resolve every
 * `.css` import.
 *
 * Returns `null` when the project has no CSS at all (no re-exec/link needed).
 *
 * @param opts Project directory, its config path, and the build output dir.
 */
export async function buildAppCss(opts: {
  projectDir: string;
  configPath: string;
  outDir: string;
  minify?: boolean;
  /**
   * Tailwind integration (absolute input/output paths). When set, denext compiles
   * the input → output with the standalone binary before the walk, and excludes the
   * *input* from the walk (its raw `@import "tailwindcss"` is not valid lightningcss
   * input; the compiled *output* flows through the pipeline normally).
   */
  tailwind?: { input: string; output: string };
}): Promise<AppCss | null> {
  // Compile Tailwind first so its output exists for the walk below.
  if (opts.tailwind) {
    await compileTailwind({
      input: opts.tailwind.input,
      output: opts.tailwind.output,
      minify: opts.minify,
      cwd: opts.projectDir,
    });
  }
  const excluded = opts.tailwind ? new Set([resolve(opts.tailwind.input)]) : null;

  const cssFiles: string[] = [];
  for await (
    const entry of walk(opts.projectDir, {
      exts: [".css"],
      includeDirs: false,
      skip: [/[/\\]\.denext[/\\]/, /[/\\]node_modules[/\\]/, /[/\\]\.git[/\\]/],
    })
  ) {
    if (excluded?.has(resolve(entry.path))) continue;
    cssFiles.push(entry.path);
  }
  if (cssFiles.length === 0) return null;
  cssFiles.sort();

  const shimDir = join(opts.outDir, "css-shims");
  await ensureDir(shimDir);
  const assets = await generateCssAssets(cssFiles, shimDir, { minify: opts.minify });

  // Emit a deno config (imports resolved to absolute so its own location does
  // not matter): framework imports (for @std/*, denext/*) + project imports
  // (win on overlap) + the CSS redirects. jsr/npm values pass through so Deno's
  // native subpath resolution (e.g. `@std/http/cookie`) keeps working.
  const fwConfig = await readJson(join(frameworkRoot(), "deno.json"));
  const appImports = await readImports(opts.configPath);
  // CSS imported via a path alias (`@/styles/x.css`, universal in Next apps)
  // bypasses the file-URL→shim redirect below: import-map resolution is
  // single-pass, so the `@/` prefix rewrites the specifier to the css file URL
  // and the URL→shim redirect is never re-applied. Emit explicit alias-form keys
  // — being longer/more specific than the `@/` prefix, they win — so aliased css
  // imports resolve straight to the shim (denext's own examples use relative css
  // imports, which resolve to the file URL directly and never hit this).
  const aliasCssRedirects: Record<string, string> = {};
  for (const [key, target] of Object.entries(appImports)) {
    if (!key.endsWith("/") || !target.startsWith("file://")) continue;
    const targetDir = fromFileUrl(target);
    for (const cssFile of cssFiles) {
      const rel = relative(targetDir, cssFile);
      if (rel.startsWith("..")) continue; // css not under this alias root
      const shim = assets.importMap[toFileUrl(cssFile).href];
      if (shim) aliasCssRedirects[key + rel.split("\\").join("/")] = shim;
    }
  }
  const merged: Record<string, unknown> = {
    compilerOptions: fwConfig.compilerOptions,
    imports: {
      ...await readImports(join(frameworkRoot(), "deno.json")),
      ...appImports,
      ...assets.importMap,
      ...aliasCssRedirects,
    },
  };
  const configPath = join(opts.outDir, "css-config.json");
  await Deno.writeTextFile(configPath, JSON.stringify(merged, null, 2));

  // Deno resolves an app module's imports using the deno.json discovered next to
  // it (the app's own config), not the `--config` denext re-execs with — so when
  // the app config anchors resolution (e.g. it declares `nodeModulesDir`/npm
  // imports, as converted Next apps do), aliased/relative `.css` imports in app
  // modules bypass the shim redirects in css-config.json and crash at SSR.
  // Mirror the css→shim redirects into the app's own config, additively, so they
  // apply whichever config Deno picks. Skipped silently for a JSONC config we
  // can't round-trip; css-config.json still covers the main module graph.
  try {
    const appCfg = JSON.parse(await Deno.readTextFile(opts.configPath));
    // Only needed when the app config anchors module resolution to itself — i.e.
    // it declares `nodeModulesDir` or has npm: imports (converted Next apps). A
    // plain denext project resolves app modules via the re-exec's --config, so
    // leave its deno.json untouched (keeps denext's own examples pristine).
    const anchors = !!appCfg.nodeModulesDir ||
      Object.values(appCfg.imports ?? {}).some((v) => String(v).startsWith("npm:"));
    if (!anchors) throw new Error("skip");
    appCfg.imports ??= {};
    let changed = false;
    for (const [k, v] of Object.entries({ ...assets.importMap, ...aliasCssRedirects })) {
      if (appCfg.imports[k] !== v) {
        appCfg.imports[k] = v;
        changed = true;
      }
    }
    if (changed) {
      await Deno.writeTextFile(opts.configPath, JSON.stringify(appCfg, null, 2) + "\n");
    }
  } catch { /* unreadable/JSONC app config — css-config.json still covers the main graph */ }

  return { ...assets, configPath, cssFiles };
}

/**
 * Extract the CSS a single route needs: crawl the route's source files, keep the
 * transformed CSS for those reachable `.css` files (in path order), and
 * concatenate. Returns `""` when the route pulls in no CSS.
 *
 * @param routeFiles The route's top-level source files (page, layouts, …).
 * @param assets The app's CSS assets from {@linkcode buildAppCss}.
 */
export async function extractRouteCss(routeFiles: string[], assets: AppCss): Promise<string> {
  const used = new Set(await discoverCssFiles(routeFiles));
  const parts = new Map<string, string>();
  for (const file of assets.css.keys()) {
    if (used.has(file)) parts.set(file, assets.css.get(file)!);
  }
  return concatCss(parts);
}
