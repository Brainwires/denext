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

import { basename, dirname, fromFileUrl, join, relative, resolve, toFileUrl } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { ensureDir, walk } from "@std/fs";
import { denoExecutable, frameworkImports, readFrameworkJson } from "./bundle.ts";
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

/** True for a CSS-module file (`*.module.css` / `*.module.scss` / `*.module.sass`). */
export function isCssModule(path: string): boolean {
  return /\.module\.(css|scss|sass)$/i.test(path);
}

/** True for a plain `.css` file. */
export function isCss(path: string): boolean {
  return /\.css$/i.test(path);
}

/** True for a Sass source file (`.scss` / `.sass`) — compiled to CSS before lightningcss. */
export function isSass(path: string): boolean {
  return /\.(scss|sass)$/i.test(path);
}

/** True for any stylesheet denext extracts (CSS or Sass). */
export function isStyleFile(path: string): boolean {
  return isCss(path) || isSass(path);
}

// dart-sass (npm:sass) is pure JS and runs in Deno; loaded lazily so a CSS-only app
// never pays for it. Compiles `.scss`/`.sass` to CSS, resolving `@use`/`@import` relative
// to the file and along the nearest `node_modules` (so `@import "pkg/..."` resolves).
let sassMod: Promise<typeof import("sass")> | null = null;
function sassCompiler(): Promise<typeof import("sass")> {
  if (!sassMod) sassMod = import("sass");
  return sassMod;
}

/** The nearest ancestor `node_modules` dir of `file` (for Sass package `@import`s), if any. */
function nearestNodeModules(file: string): string[] {
  let dir = dirname(file);
  for (let i = 0; i < 20; i++) {
    const nm = join(dir, "node_modules");
    try {
      if (Deno.statSync(nm).isDirectory) return [nm];
    } catch { /* keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [];
}

/** Compile a `.scss`/`.sass` file to a CSS string (indented syntax for `.sass`). */
async function compileSass(file: string): Promise<string> {
  const sass = await sassCompiler();
  // `compile()` infers the syntax (`.sass` indented vs `.scss`) from the file extension.
  const result = sass.compile(file, {
    loadPaths: nearestNodeModules(file),
    quietDeps: true,
    silenceDeprecations: ["import", "legacy-js-api", "global-builtin", "color-functions"],
  });
  return result.css;
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
export async function discoverCssFiles(
  entryFiles: string[],
  appConfigPath?: string,
): Promise<string[]> {
  if (entryFiles.length === 0) return [];
  const tmpDir = await Deno.makeTempDir({ prefix: "denext_css_graph_" });
  const barrel = join(tmpDir, "barrel.ts");
  // `deno info` resolves each module's imports via the `deno.json` nearest to it —
  // the app's own config — NOT a `--config` override. When that config has the
  // css→shim redirects mirrored in (anchoring apps; see buildAppCss), every `.css`
  // resolves to its empty shim and the crawl finds none. So temporarily strip those
  // redirects from the app config for the duration of the crawl, restoring it after
  // (every build re-mirrors them, so an interrupted crawl self-heals next build).
  const restore = appConfigPath ? await stripCssShims(appConfigPath) : null;
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
      if (m.specifier.startsWith("file://") && isStyleFile(m.specifier)) {
        found.add(fromFileUrl(m.specifier));
      }
    }
    return [...found].sort();
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
    if (restore) await restore();
  }
}

/**
 * Temporarily remove css→shim import-map entries (values under `css-shims/`) from a
 * `deno.json`, returning a function that restores the original file verbatim. A no-op
 * (returns a no-op restore) when the config has no such entries or can't be read.
 */
async function stripCssShims(configPath: string): Promise<() => Promise<void>> {
  let original: string;
  try {
    original = await Deno.readTextFile(configPath);
  } catch {
    return () => Promise.resolve();
  }
  let cfg: { imports?: Record<string, string> } & Record<string, unknown>;
  try {
    // Parse as JSONC — a `deno.json` may carry comments / trailing commas, and a
    // plain `JSON.parse` throwing on those used to silently no-op here, leaving the
    // css→shim redirects in place so `deno info` resolved every `.css` to its empty
    // shim and the build shipped with NO stylesheets and no warning.
    cfg = parseJsonc(original) as typeof cfg;
  } catch (err) {
    // Even JSONC failed — warn LOUDLY rather than silently emitting empty CSS.
    console.warn(
      `denext: could not parse ${configPath} to strip CSS shims (${
        err instanceof Error ? err.message : String(err)
      }); route stylesheets may not be extracted. Ensure the config is valid JSON/JSONC.`,
    );
    return () => Promise.resolve();
  }
  const imports = cfg?.imports;
  if (!imports || typeof imports !== "object") return () => Promise.resolve();
  const kept = Object.fromEntries(
    Object.entries(imports).filter(([, v]) => !String(v).includes("/css-shims/")),
  );
  if (Object.keys(kept).length === Object.keys(imports).length) {
    return () => Promise.resolve(); // nothing to strip
  }
  cfg.imports = kept;
  // Written as plain JSON for the crawl window; the restore rewrites the ORIGINAL
  // text verbatim, so any comments/formatting in a JSONC config are preserved.
  await Deno.writeTextFile(configPath, JSON.stringify(cfg, null, 2) + "\n");
  return () => Deno.writeTextFile(configPath, original);
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
    const isModule = isCssModule(file);
    let cssText = "";
    let exports: Record<string, string> = {};
    try {
      // Sass files are compiled to CSS first (resolving their own @use/@import), then run
      // through lightningcss exactly like a `.css` file — so scoping/minify are unchanged.
      const source = isSass(file) ? await compileSass(file) : await Deno.readTextFile(file);
      const t = await transformCss(source, file, { cssModules: isModule, minify: opts.minify });
      cssText = t.css;
      exports = t.exports;
    } catch (err) {
      // One unparseable sheet — often a vendored / cross-package file pulled in via the
      // import-graph crawl — must not sink the whole build. Warn loudly (naming the file),
      // then emit an empty passthrough shim so the import still resolves; the route simply
      // ships without that sheet's rules. An author's own broken stylesheet surfaces here
      // by name rather than as an unlabeled Promise.all rejection.
      console.warn(
        `denext: could not compile stylesheet ${file} (${
          err instanceof Error ? err.message : String(err)
        }); it is omitted from the build.`,
      );
    }
    css.set(file, cssText);
    classMaps.set(file, exports);

    // The shim gives server + client a real module to import in place of the CSS.
    const shimBody = isModule
      ? `export default ${JSON.stringify(exports)};\n`
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
    if (!(value.startsWith("./") || value.startsWith("../"))) {
      out[key] = value;
      continue;
    }
    const abs = toFileUrl(resolve(baseDir, value)).href;
    // Keep a trailing slash so a prefix mapping (`"~/": "./src/"`) resolves its
    // subpaths correctly — `resolve` strips it.
    out[key] = value.endsWith("/") && !abs.endsWith("/") ? abs + "/" : abs;
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
  /**
   * The app's own `deno.json` path (the module loader's config). The CSS graph crawl
   * ({@linkcode discoverCssFiles}) temporarily strips the css→shim redirects from it
   * so `deno info` sees the REAL `.css` imports — `deno info` resolves each module via
   * the `deno.json` nearest to it, so a `--config` override alone wouldn't help.
   */
  appConfigPath: string;
  /** Absolute paths of every `.css` file discovered in the project. */
  cssFiles: string[];
  /**
   * css→shim redirects that must be applied to the app's OWN `deno.json` for the build,
   * or `undefined` when none are needed. Present only when the app config anchors module
   * resolution to itself (a manual `node_modules`, or `npm:` imports — converted Next/SPA
   * apps): Deno then resolves an app module's css imports via the app's own `deno.json`,
   * not the `--config` we re-exec with, so those redirects have to live there too. The
   * CLI applies them TRANSIENTLY around the re-exec ({@linkcode injectAppConfigRedirects} +
   * {@linkcode restoreAppConfig}), leaving the committed `deno.json` byte-identical.
   */
  appConfigRedirects?: Record<string, string>;
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
   * The app's top-level entry sources (SPA entry, or every route's page/layout files).
   * When given, an import-graph crawl ({@linkcode discoverCssFiles}) unions any style
   * files reachable from them into the filesystem walk — so stylesheets that live
   * OUTSIDE `projectDir` (a monorepo app importing `.scss` from sibling workspace
   * packages, or a vendored `.css` under `node_modules`) still get a shim and are
   * compiled. The walk alone only sees files under `projectDir`.
   */
  entryFiles?: string[];
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
      // `.scss`/`.sass` are compiled to CSS in generateCssAssets; a Sass PARTIAL
      // (`_foo.scss`) is only ever `@use`d by another sheet, never imported directly,
      // so skip it here (compiling it standalone would emit nothing / duplicate vars).
      exts: [".css", ".scss", ".sass"],
      includeDirs: false,
      skip: [/[/\\]\.denext[/\\]/, /[/\\]node_modules[/\\]/, /[/\\]\.git[/\\]/],
      match: [/(?:^|[/\\])(?!_)[^/\\]*\.(?:css|scss|sass)$/],
    })
  ) {
    if (excluded?.has(resolve(entry.path))) continue;
    cssFiles.push(entry.path);
  }

  // Union in stylesheets reachable from the entry graph that the walk can't see —
  // those OUTSIDE `projectDir` (sibling workspace packages, vendored `node_modules`
  // sheets). `discoverCssFiles` crawls via `deno info`, so it only ever reports files
  // the app actually imports. Skip Sass partials (`_foo.scss`, only ever `@use`d) to
  // match the walk's `(?!_)` filter, and skip the Tailwind input we deliberately
  // excluded above. In-`projectDir` files the walk already has are deduped by the Set.
  if (opts.entryFiles && opts.entryFiles.length > 0) {
    const seen = new Set(cssFiles.map((f) => resolve(f)));
    for (const found of await discoverCssFiles(opts.entryFiles, opts.configPath)) {
      const abs = resolve(found);
      if (seen.has(abs)) continue;
      if (excluded?.has(abs)) continue;
      if (/^_/.test(basename(found))) continue; // Sass partial
      seen.add(abs);
      cssFiles.push(found);
    }
  }

  if (cssFiles.length === 0) return null;
  cssFiles.sort();

  const shimDir = join(opts.outDir, "css-shims");
  await ensureDir(shimDir);
  const assets = await generateCssAssets(cssFiles, shimDir, { minify: opts.minify });

  // Tailwind: the raw INPUT (`@import "tailwindcss"`) is excluded from the walk above,
  // so only the compiled OUTPUT is collectable. But an app commonly imports the input
  // path it authored (`import "./index.css"`) rather than the generated output. Alias
  // the input to the output so importing EITHER resolves to the same shim (bundler /
  // `deno info`) and collects the same compiled CSS ({@linkcode extractRouteCss}).
  // Without this, importing the raw input emits no stylesheet — the app builds unstyled
  // (and the raw `@import "tailwindcss"` would otherwise break the esbuild CSS loader).
  if (opts.tailwind) {
    const inPath = resolve(opts.tailwind.input);
    const outPath = resolve(opts.tailwind.output);
    const outShim = assets.importMap[toFileUrl(outPath).href];
    if (outShim) assets.importMap[toFileUrl(inPath).href] = outShim;
    const outCss = assets.css.get(outPath);
    if (outCss != null) assets.css.set(inPath, outCss);
  }

  // Emit a deno config (imports resolved to absolute so its own location does
  // not matter): framework imports (for @std/*, denext/*) + project imports
  // (win on overlap) + the CSS redirects. jsr/npm values pass through so Deno's
  // native subpath resolution (e.g. `@std/http/cookie`) keeps working.
  const fwConfig = await readFrameworkJson("deno.json");
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
      ...await frameworkImports(),
      ...appImports,
      ...assets.importMap,
      ...aliasCssRedirects,
    },
  };
  // Carry the app's `nodeModulesDir` through: the CLI re-execs the build with this
  // config, and a manual-`node_modules` app (yarn/pnpm SPA, converted monorepos) then
  // needs the setting to link its npm deps — without it Deno errors "Linking npm
  // packages requires a node_modules directory" the moment a route pulls an npm import.
  const appCfgRaw = await readJson(opts.configPath) as { nodeModulesDir?: unknown };
  const nmd = appCfgRaw?.nodeModulesDir;
  if (nmd && nmd !== "none" && nmd !== false) merged.nodeModulesDir = nmd;
  const configPath = join(opts.outDir, "css-config.json");
  await Deno.writeTextFile(configPath, JSON.stringify(merged, null, 2));

  // Deno resolves an app module's imports using the deno.json discovered next to it
  // (the app's own config), not the `--config` denext re-execs with — so when the app
  // config anchors resolution (declares `nodeModulesDir` / has `npm:` imports, as
  // converted Next/SPA apps do), aliased/relative `.css` imports in app modules bypass
  // the shim redirects in css-config.json and crash at build. Those redirects therefore
  // have to be applied to the app's OWN deno.json — but only TRANSIENTLY, so the
  // committed config is left untouched: this function just reports the set to apply, and
  // the CLI injects + restores them around the re-exec. Skipped for a JSONC config we
  // can't round-trip; css-config.json still covers the main module graph.
  let appConfigRedirects: Record<string, string> | undefined;
  try {
    const appCfg = JSON.parse(await Deno.readTextFile(opts.configPath));
    const anchors = !!appCfg.nodeModulesDir ||
      Object.values(appCfg.imports ?? {}).some((v) => String(v).startsWith("npm:"));
    if (anchors) appConfigRedirects = { ...assets.importMap, ...aliasCssRedirects };
  } catch { /* unreadable/JSONC app config — css-config.json still covers the main graph */ }

  return { ...assets, configPath, appConfigPath: opts.configPath, cssFiles, appConfigRedirects };
}

/** Sidecar holding the app `deno.json`'s pre-build bytes (for transient css injection). */
function appConfigBackupPath(outDir: string): string {
  return join(outDir, "app-config.pre-css.json");
}

/**
 * Inject css→shim redirects into the app's `deno.json` for the duration of the build,
 * backing up its exact original bytes first so {@linkcode restoreAppConfig} can put it
 * back byte-identical. A no-op (and no backup) when every redirect is already present.
 * Run by the CLI in the re-exec PARENT, before spawning the build child.
 *
 * @param configPath The app's `deno.json`.
 * @param outDir The `.denext` output dir (holds the backup).
 * @param redirects The css→shim entries to add ({@link AppCss.appConfigRedirects}).
 */
export async function injectAppConfigRedirects(
  configPath: string,
  outDir: string,
  redirects: Record<string, string>,
): Promise<void> {
  const original = await Deno.readTextFile(configPath);
  const appCfg = JSON.parse(original) as { imports?: Record<string, string> };
  appCfg.imports ??= {};
  let changed = false;
  for (const [k, v] of Object.entries(redirects)) {
    if (appCfg.imports[k] !== v) {
      appCfg.imports[k] = v;
      changed = true;
    }
  }
  if (!changed) return; // nothing to inject → nothing to restore
  await ensureDir(outDir);
  const bak = appConfigBackupPath(outDir);
  await Deno.remove(bak).catch(() => {}); // symlink-clobber guard
  await Deno.writeTextFile(bak, original);
  await Deno.writeTextFile(configPath, JSON.stringify(appCfg, null, 2) + "\n");
}

/**
 * Restore the app's `deno.json` from the backup {@linkcode injectAppConfigRedirects}
 * made — leaving it byte-identical to before the build — then delete the backup. A no-op
 * when there is no backup. Run after the build child exits (and defensively at the start
 * of the next build, to self-heal a crashed run that couldn't restore).
 *
 * @param configPath The app's `deno.json`.
 * @param outDir The `.denext` output dir (holds the backup).
 */
export async function restoreAppConfig(configPath: string, outDir: string): Promise<void> {
  const bak = appConfigBackupPath(outDir);
  const original = await Deno.readTextFile(bak).catch(() => null);
  if (original === null) return;
  await Deno.writeTextFile(configPath, original);
  await Deno.remove(bak).catch(() => {});
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
  const used = new Set(await discoverCssFiles(routeFiles, assets.appConfigPath));
  const parts = new Map<string, string>();
  for (const file of assets.css.keys()) {
    if (used.has(file)) parts.set(file, assets.css.get(file)!);
  }
  return concatCss(parts);
}
