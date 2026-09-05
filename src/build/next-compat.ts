/**
 * next-compat bundling: run **real npm React libraries** (Radix, react-hook-form,
 * sonner, lucide, …) on denext's single React by rewriting `react`/`react-dom`/
 * `react-is`/`react/*` → denext at bundle time — the same importer-insensitive
 * alias mechanism Preact uses for `preact/compat`, but applied through esbuild so
 * it also rewrites imports *inside* npm packages (which a Deno import-map alias
 * cannot reach).
 *
 * The one subtlety this module solves: esbuild + the Deno loader would otherwise
 * instantiate denext **twice** — app-code importers land in esbuild's `file`
 * namespace while npm importers land in the Deno loader's namespace, so the same
 * denext module resolves under two `(path, namespace)` keys → two hook
 * dispatchers → "no dispatcher installed" at SSR. We funnel **all** denext-runtime
 * code (the prebuilt compat bundle) through one dedicated esbuild namespace so it
 * can only ever be one instance.
 *
 * esbuild + `@luca/esbuild-deno-loader` are **build-time only** — they never enter
 * a shipped bundle or the denext runtime.
 *
 * @module
 */

import { denoPlugins } from "@luca/esbuild-deno-loader";
import * as esbuild from "esbuild";
import {
  basename,
  dirname,
  fromFileUrl,
  isAbsolute,
  join,
  relative,
  resolve,
  toFileUrl,
} from "@std/path";
import {
  frameworkFileUrl,
  frameworkImports,
  frameworkRootUrl,
  loaderConfigPath,
  minDepAgeConfig,
  readAliasPrefixes,
  readFrameworkJson,
} from "./bundle.ts";

/** The esbuild namespace all prebuilt denext-runtime modules are funneled into. */
const DENEXT_NS = "denext-runtime";

/**
 * The react-family specifiers rewritten to denext, mapped to the prebuilt entry
 * file name (within the runtime dir). Its keys are the canonical
 * `REACT_FAMILY_SPECIFIERS` set (see `./react-specifiers.ts`);
 * `tests/react-specifiers.test.ts` guards against drift.
 */
export const REACT_ALIASES: Record<string, string> = {
  "react": "react.js",
  "react-dom": "react-dom.js",
  "react-dom/client": "react-dom-client.js",
  "react-dom/server": "react-dom-server.js",
  "react-dom/server.browser": "react-dom-server.js",
  "react-dom/server.edge": "react-dom-server.js",
  "react-dom/test-utils": "react-dom-test-utils.js",
  "react-is": "react-is.js",
  "react/jsx-runtime": "jsx-runtime.js",
  "react/jsx-dev-runtime": "jsx-runtime.js",
};

/**
 * `next/*` specifiers rewritten to denext's compat modules → prebuilt entry file.
 * Without this, esbuild resolves `next/font/google`, `next/link`, … from the real
 * `next` npm package in node_modules (component/font APIs that don't run on
 * denext), so app code that imports them breaks at SSR. Component/hook/font-facing
 * modules only — server-only surfaces (`next/server`, `next/og`, `next/cache`)
 * are left to normal resolution.
 */
export const NEXT_ALIASES: Record<string, string> = {
  "next": "next-index.js",
  "next/link": "next-link.js",
  "next/script": "next-script.js",
  "next/dynamic": "next-dynamic.js",
  "next/navigation": "next-navigation.js",
  "next/form": "next-form.js",
  "next/font/google": "next-font-google.js",
  "next/font/local": "next-font-local.js",
  // Server-facing surfaces. Safe to include now that the OG/image optimizers
  // (@cf-wasm satori/resvg/photon .wasm) are imported LAZILY (see
  // image-optimizer.ts / image-response.ts) — a static import previously pulled
  // .wasm into the browser prebuild and broke it.
  "next/headers": "next-headers.js",
  "next/image": "next-image.js",
  "next/og": "next-og.js",
  "next/cache": "next-cache.js",
  "next/server": "next-server.js",
};

/**
 * denext source entrypoints prebuilt into the shared runtime (one graph). `baseUrl` may be
 * ANY absolute URL — `file://` for a checkout, `https://jsr.io/@denext/denext/<v>/` when the
 * framework runs from JSR (the common production case), `http://` in tests — or a plain
 * filesystem path (a caller passing a local `frameworkRoot()`), which is turned into a
 * `file://` URL. Only a bare path goes through `toFileUrl`; a remote root used to hit it
 * and throw "Path must be absolute", breaking every `denext export`/`build` of a
 * compat-mode app installed from JSR.
 */
export function runtimeEntryPoints(baseUrl: string): Record<string, string> {
  const base = /^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl) ? baseUrl : toFileUrl(baseUrl).href;
  const u = (rel: string) => new URL(rel, base).href;
  return {
    "react": u("src/compat/react.ts"),
    "react-dom": u("src/compat/react-dom.ts"),
    "react-dom-client": u("src/compat/react-dom-client.ts"),
    "react-dom-server": u("src/compat/react-dom-server.ts"),
    "react-dom-test-utils": u("src/compat/test-utils.ts"),
    "react-is": u("src/compat/react-is.ts"),
    "jsx-runtime": u("src/jsx/jsx-runtime.ts"),
    // The SSR renderer must come from the SAME prebuilt graph as the aliased
    // react, or the server renders with a different dispatcher than the app's
    // components use.
    "ssr": u("src/jsx/render-to-string.ts"),
    "ssr-stream": u("src/jsx/render-to-stream.ts"),
    "client": u("src/client/mod.ts"),
    // Live Server Components (`<Live>` + transport) — the generated Flight entry
    // imports it from `denext/live`; prebuilt into the same shared graph.
    "live": u("src/live.ts"),
    // Deferred island hydration bootstrap — the generated Flight entry dynamically
    // imports it from `denext/lazy` only when a page has client:* islands.
    "lazy": u("src/lazy.ts"),
    // The generated entries' boot/HMR plumbing and the dev inspector — imported from
    // `denext/client-runtime` / `denext/devtools`; prebuilt into the same shared graph.
    "client-runtime": u("src/client/client-runtime.ts"),
    "devtools": u("src/devtools.ts"),
    // next/* compat modules (see NEXT_ALIASES) — prebuilt into the same graph so
    // they share the one denext instance.
    "next-index": u("src/compat/next/index.ts"),
    "next-link": u("src/compat/next/link.ts"),
    "next-script": u("src/compat/next/script.ts"),
    "next-dynamic": u("src/compat/next/dynamic.ts"),
    "next-navigation": u("src/compat/next/navigation.ts"),
    "next-form": u("src/compat/next/form.ts"),
    "next-font-google": u("src/compat/next/font/google.ts"),
    "next-font-local": u("src/compat/next/font/local.ts"),
    "next-headers": u("src/compat/next/headers.ts"),
    "next-image": u("src/compat/next/image.ts"),
    "next-og": u("src/compat/next/og.ts"),
    "next-cache": u("src/compat/next/cache.ts"),
    "next-server": u("src/compat/next/server.ts"),
    // The Remix compat runtime (`denext/remix`) — prebuilt into the same graph so a
    // migrated Remix app's client components share the one denext instance.
    "remix": u("src/compat/remix/client.ts"),
  };
}

/** Options for {@link prebuildDenextRuntime}. */
export interface PrebuildOptions {
  /** Output directory for the prebuilt runtime files. */
  outDir: string;
  /** denext framework root (defaults to the running framework). */
  frameworkRoot?: string;
  /** Path to the project's `deno.json` (for the deno loader's resolution). */
  configPath?: string;
  /** Compile in the class-component runtime (default false → DCE'd out). */
  classComponents?: boolean;
}

/** The esbuild `define` that gates the class-component runtime (see class-flag.ts). */
function classDefine(classComponents?: boolean): Record<string, string> {
  return { __DENEXT_CLASS_COMPONENTS__: JSON.stringify(!!classComponents) };
}

/**
 * Prebuild denext's compat + SSR entrypoints into one shared, self-contained
 * runtime (esbuild `splitting` dedupes the denext core into a single chunk, so
 * every entry shares one hook dispatcher / reconciler). Produces plain ESM JS
 * with no bare `@std`/`jsr:` imports left, so the app build can load it with
 * esbuild's own resolver.
 *
 * @param options Where to emit + which framework/config to resolve against.
 * @returns The absolute runtime directory.
 */
export async function prebuildDenextRuntime(options: PrebuildOptions): Promise<string> {
  // A URL base (file:// from a checkout, https:// from JSR) so the runtime entry points and
  // their imports resolve in either mode — the deno loader fetches remote framework sources.
  const rootUrl = options.frameworkRoot ?? frameworkRootUrl();
  const outDir = resolve(options.outDir);
  await Deno.mkdir(outDir, { recursive: true });
  // The deno loader needs a LOCAL config file for jsr:/npm resolution. Materialize denext's
  // own imports (@std, @cf-wasm, npm codecs — the runtime sources' deps) to a temp deno.json,
  // fetched from JSR when denext runs remotely. (The framework's relative self-imports resolve
  // against each entry point's own URL, so only the external deps need to be in this config.)
  const tmpConfig = await Deno.makeTempFile({ suffix: ".deno.json" });
  await Deno.writeTextFile(
    tmpConfig,
    JSON.stringify({ imports: await frameworkImports(), ...minDepAgeConfig(undefined) }),
  );
  try {
    await esbuild.build({
      entryPoints: runtimeEntryPoints(rootUrl),
      outdir: outDir,
      bundle: true,
      splitting: true,
      format: "esm",
      platform: "browser",
      // The wasm codecs behind next/og + next/image are dynamically imported at call
      // time; keep them EXTERNAL so esbuild doesn't try to bundle their `.wasm`
      // (no browser loader for it) here. At SSR runtime they resolve via the merged
      // css-config (which includes denext's framework imports); on the client they
      // are never reached.
      external: ["@denext/photon", "@denext/avif", "@denext/og"],
      define: classDefine(options.classComponents),
      plugins: [...denoPlugins({ configPath: tmpConfig })],
    });
  } finally {
    await Deno.remove(tmpConfig).catch(() => {});
  }
  return outDir;
}

/** Options for {@link bundleNextCompat}. */
export interface BundleNextCompatOptions {
  /** Entry module (a route/client entry or a server render module). */
  entry: string;
  /** The prebuilt runtime dir from {@link prebuildDenextRuntime}. */
  runtimeDir: string;
  /** Output file path. */
  outfile: string;
  /** Project `deno.json` (for resolving app + npm deps via the deno loader). */
  configPath: string;
  /** Bundle target: browser (client) or deno (SSR). */
  platform?: "browser" | "deno";
  /** Minify (production). */
  minify?: boolean;
  /** Extra esbuild `alias` entries (e.g. `@radix-ui/*` → denext primitives later). */
  extraAlias?: Record<string, string>;
  /**
   * Use `@luca/esbuild-deno-loader` for jsr:/@std/https: specifiers. When the app
   * graph is npm + react/denext only (react handled by our plugin, npm by
   * esbuild's native node resolution), this can be `false` to avoid the loader's
   * npm sub-dep quirks. Default `true`.
   */
  denoLoader?: boolean;
  /** Absolute working directory (where node_modules lives) for native resolution. */
  absWorkingDir?: string;
  /** Compile in the class-component runtime (default false → DCE'd out). */
  classComponents?: boolean;
}

/**
 * Resolve an app's OWN source imports (path-alias `@/…` from the deno.json import
 * map, and relative `./`/`../`) by probing extensions — the extensionless imports
 * Next.js apps use everywhere. This is handled here rather than by the deno-loader
 * because its "portable" mode doesn't apply sloppy-imports and its "native" mode
 * hits a graph-reachability mismatch on them. npm/jsr/`.css` (which needs the
 * import-map shim redirect) are left to the deno-loader by returning null.
 */
/** Extensions probed when resolving an extensionless relative/alias import. */
const SOURCE_EXTS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".json", ".mdx", ".md"];

function isFile(p: string): boolean {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
}

/**
 * Probe an extensionless base path for a real source file (exact, `+ext`, or
 * `/index+ext`). Shared with the unbundled dev resolver so both probe the same way.
 */
export function probeSourceFile(base: string): string | null {
  if (isFile(base)) return base;
  for (const e of SOURCE_EXTS) if (isFile(base + e)) return base + e;
  for (const e of SOURCE_EXTS) {
    const idx = join(base, "index" + e);
    if (isFile(idx)) return idx;
  }
  return null;
}

/**
 * The extensionless base an app import resolves to, or null when it is not the app's own
 * source (npm/jsr/bare → the deno-loader). Relative imports include the bare directory
 * forms `.` / `..` (Node resolves these to the directory's `index.*`; esbuild's
 * deno-loader rejects them, so many real codebases that write `import { x } from "."`
 * fail without this); otherwise a path-alias prefix (`~/` → absDir).
 */
function appImportBase(
  spec: string,
  importer: string,
  prefixes: Array<[string, string]>,
): string | null {
  if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
    return importer ? resolve(dirname(importer), spec) : null;
  }
  for (const [key, absDir] of prefixes) {
    if (spec === key.slice(0, -1) || spec.startsWith(key)) {
      return resolve(absDir, spec.slice(key.length));
    }
  }
  return null;
}

/**
 * Resolve an app's OWN source imports (path-alias `@/…` from the deno.json import
 * map, and relative `./`/`../`) by probing extensions — the extensionless imports
 * Next.js apps use everywhere. This is handled here rather than by the deno-loader
 * because its "portable" mode doesn't apply sloppy-imports and its "native" mode
 * hits a graph-reachability mismatch on them. npm/jsr/`.css` (which needs the
 * import-map shim redirect) are left to the deno-loader by returning null.
 */
function appResolverPlugin(configPath: string): esbuild.Plugin {
  // Path-alias prefixes (e.g. "~/" → "./src/"), loaded once from the app's deno.json — the
  // form `denext migrate` emits.
  let prefixes: Array<[string, string]> | null = null;
  const ensure = async () => prefixes ??= await readAliasPrefixes(configPath);
  return {
    name: "denext-app-resolver",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        // Only claim imports FROM plain files (app source), never from modules the
        // deno-loader owns (npm/jsr namespaces), and never stylesheets (.css/.scss/.sass —
        // the CSS pipeline's shim redirect points them at a shim via the import map).
        if (args.namespace !== "file" && args.namespace !== "") return null;
        const p = args.path;
        if (/\.(css|scss|sass)$/i.test(p.replace(/[?#].*$/, ""))) return null;
        const base = appImportBase(p, args.importer, await ensure());
        if (base) {
          const found = probeSourceFile(base);
          return found ? { path: found } : null;
        }
        // tsconfig `baseUrl: "."` — Next resolves a bare, path-shaped specifier
        // (`app/foo/bar`, `components/x`) against the project root. Try that as a LAST
        // resort (a real npm package won't have a matching file under the root, and the
        // probe only claims an actual file), so `import x from "app/context/y"` works.
        const isRelative = p === "." || p === ".." || p.startsWith("./") || p.startsWith("../");
        if (!isRelative && /\//.test(p) && !p.startsWith("@")) {
          const rootProbe = probeSourceFile(resolve(dirname(configPath), p));
          if (rootProbe) return { path: rootProbe };
        }
        return null; // npm/jsr/bare → deno-loader
      });
    },
  };
}

/**
 * Server-bundle variant of {@link denextRuntimePlugin}: rewrite every react-family
 * and `next/*` import to denext, but mark those denext modules **external** (point
 * at denext's own source files). The SSR bundle then imports the SAME denext
 * modules the main renderer (`render-to-string.ts`) does — Deno dedupes them by
 * URL, so there is exactly ONE denext instance (one hook dispatcher) shared
 * between the renderer and the rendered components. A prebuilt/inlined runtime
 * would instead give the components a second denext → "no dispatcher installed".
 *
 * (Only valid for the `deno`/SSR platform, where the external `file://` denext
 * imports resolve at runtime. The client/browser bundle must inline the runtime.)
 */
async function denextExternalPlugin(): Promise<esbuild.Plugin> {
  const exportsMap = (await readFrameworkJson("deno.json")).exports as Record<string, string>;
  // spec → denext source URL (external), in the framework's own scheme (file:// or the remote
  // JSR URL). Export keys are "./" + spec. The deno loader resolves the external URL at bundle
  // time whether the framework is a local checkout or served from JSR.
  const specToUrl = new Map<string, string>();
  for (const spec of [...Object.keys(REACT_ALIASES), ...Object.keys(NEXT_ALIASES)]) {
    const key = "./" + spec;
    const rel = exportsMap?.[key];
    if (rel) specToUrl.set(spec, frameworkFileUrl(rel));
  }
  const filter = /^react$|^react\/|^react-dom$|^react-dom\/|^react-is$|^next$|^next\//;
  return {
    name: "denext-external",
    setup(build) {
      build.onResolve({ filter }, (args) => {
        const url = specToUrl.get(args.path);
        return url ? { path: url, external: true } : null;
      });
      // denext's own subpaths (`denext`, `denext/server`, `denext/remix`,
      // `denext/remix/server`, …) → the framework's OWN source, marked external so the
      // SSR bundle shares the one denext instance (a bundled copy would double the
      // dispatcher) and so their `jsr:@std/*` deps aren't dragged through the portable
      // esbuild loader. Resolved via the framework `exports` map; unknown subpaths fall
      // through to normal resolution.
      build.onResolve({ filter: /^denext$|^denext\// }, (args) => {
        const sub = args.path === "denext" ? "." : "./" + args.path.slice("denext/".length);
        const rel = exportsMap?.[sub];
        return rel ? { path: frameworkFileUrl(rel), external: true } : null;
      });
    },
  };
}

/**
 * Resolve a react-family specifier to its denext runtime file — **never** to the
 * real npm React (which would instantiate a second React alongside denext's). A
 * mapped specifier ({@link REACT_ALIASES}) resolves directly; an unmapped subpath
 * (e.g. `react/experimental`, `react-dom/static`) fails **safe** to the base
 * `react`/`react-dom` runtime and returns a `warning` so the gap surfaces at build
 * time rather than silently loading real React. Exported for testing.
 *
 * @param spec The react-family import specifier.
 * @returns The runtime `file` to resolve to, and a `warning` when it was unmapped.
 */
export function resolveReactFamilyFile(spec: string): { file: string; warning?: string } {
  const mapped = REACT_ALIASES[spec];
  if (mapped) return { file: mapped };
  const base = spec.startsWith("react-dom") ? "react-dom" : "react";
  return {
    file: REACT_ALIASES[base],
    warning: `denext next-compat: unmapped react-family import "${spec}" → mapped to ` +
      `denext's "${base}" runtime (never real React). If it needs a distinct module, ` +
      `add it to REACT_ALIASES.`,
  };
}

/**
 * The esbuild plugin that funnels every react-family import (from app code AND
 * npm packages) into the single prebuilt denext runtime, all under one namespace
 * so denext is instantiated exactly once.
 */
/**
 * denext's own client/SSR/jsx specifiers, aliased to the SAME prebuilt graph so the
 * generated route entry shares the one denext instance.
 */
const DENEXT_RUNTIME_FILES: Record<string, string> = {
  "denext/ssr": "ssr.js",
  "denext/ssr-stream": "ssr-stream.js",
  "denext/client": "client.js",
  "denext/live": "live.js",
  "denext/lazy": "lazy.js",
  "denext/client-runtime": "client-runtime.js",
  "denext/devtools": "devtools.js",
  "denext/jsx-runtime": "jsx-runtime.js",
  "denext/jsx-dev-runtime": "jsx-runtime.js",
  // The Remix compat client runtime (a migrated Remix app's client components).
  "denext/remix": "remix.js",
};

/**
 * Server-only denext subpaths (`denext/remix/server`, `denext/server`) can't be inlined
 * into the browser-oriented prebuilt runtime — they pull denext's server internals
 * (`request-context` → `jsr:@std/*`). On the SSR (deno) bundle mark them EXTERNAL to the
 * framework source so Deno resolves them (and their jsr deps) at load time; the client
 * bundle never imports them.
 */
function serverOnlyExternalResolver(): (
  args: esbuild.OnResolveArgs,
) => Promise<esbuild.OnResolveResult | null> {
  let exportsMap: Record<string, string> | null = null;
  return async (args) => {
    exportsMap ??= (await readFrameworkJson("deno.json")).exports as Record<string, string>;
    const rel = exportsMap["./" + args.path.slice("denext/".length)];
    return rel ? { path: frameworkFileUrl(rel), external: true } : null;
  };
}

/**
 * Relative imports *within* the prebuilt runtime (shared chunks) stay in the namespace,
 * keyed by absolute path → single instance. A `node:` builtin left in the prebuilt runtime
 * (e.g. `node:async_hooks` for AsyncLocalStorage) must NOT be resolved as a file here —
 * defer it so the platform-appropriate handler takes it: esbuild externalizes it for the
 * deno/node SSR bundle, and the node-builtin stub empties it for the browser bundle.
 * (Which prebuilt chunk carries the import varies with esbuild's code-splitting, so this
 * can surface on any runtime file.) denext's native helper packages
 * (`@denext/og`/`@denext/photon`/`@denext/avif`, used by next/og etc.) are NOT prebuilt
 * runtime files on disk, so they stay external — the platform loader resolves them (jsr,
 * or the local workspace) at load time, same as `node:`.
 */
function resolveWithinRuntime(args: esbuild.OnResolveArgs): esbuild.OnResolveResult | null {
  if (args.path.startsWith("node:")) return null;
  if (/^@denext\/(og|photon|avif)(\/|$)/.test(args.path)) {
    return { path: args.path, external: true };
  }
  return { path: resolve(dirname(args.importer), args.path), namespace: DENEXT_NS };
}

/**
 * The esbuild plugin that funnels every react-family import (from app code AND
 * npm packages) into the single prebuilt denext runtime, all under one namespace
 * so denext is instantiated exactly once.
 */
function denextRuntimePlugin(runtimeDir: string): esbuild.Plugin {
  const runtimeFile = (file: string) => ({ path: join(runtimeDir, file), namespace: DENEXT_NS });
  return {
    name: "denext-runtime",
    setup(build) {
      // react-family bare specifiers → prebuilt runtime file, in our namespace.
      const filter = /^react$|^react\/|^react-dom$|^react-dom\/|^react-is$/;
      build.onResolve({ filter }, (args) => {
        const { file, warning } = resolveReactFamilyFile(args.path);
        return { ...runtimeFile(file), warnings: warning ? [{ text: warning }] : undefined };
      });
      // next/* → denext compat modules (font/link/navigation/… — see NEXT_ALIASES),
      // so app code resolves them to denext instead of the real `next` npm package.
      build.onResolve({ filter: /^next$|^next\// }, (args) => {
        const file = NEXT_ALIASES[args.path];
        return file ? runtimeFile(file) : null;
      });
      build.onResolve(
        { filter: /^denext\/remix\/server$|^denext\/server$/ },
        serverOnlyExternalResolver(),
      );
      build.onResolve({ filter: /^denext\// }, (args) => {
        const file = DENEXT_RUNTIME_FILES[args.path];
        return file ? runtimeFile(file) : null;
      });
      build.onResolve({ filter: /.*/, namespace: DENEXT_NS }, resolveWithinRuntime);
      // Load prebuilt runtime files from disk as plain JS.
      build.onLoad({ filter: /.*/, namespace: DENEXT_NS }, async (args) => ({
        contents: await Deno.readTextFile(args.path),
        loader: "js",
        resolveDir: dirname(args.path),
      }));
    },
  };
}

/**
 * Node built-ins (with and without the `node:` prefix) that are **safe to stub** with
 * an empty module in a browser bundle — either they have no browser meaning (I/O /
 * system modules), or their browser equivalent is a global so the module import is a
 * Node-path signal (`url` → global `URL`, parsing-only legacy modules).
 *
 * Deliberately excludes browser-relevant / genuinely-polyfilled built-ins (`buffer`,
 * `crypto`, `stream`, `util`, `events`, `process`, `zlib`, `assert`, `timers`,
 * `console`): silently emptying those would turn a real browser dependency into an
 * `undefined` runtime crash, so we let esbuild resolve them (or fail loudly, signalling
 * a genuine polyfill need) rather than hide it.
 */
const STUBBABLE_BUILTINS: ReadonlySet<string> = new Set([
  "fs",
  "path",
  "os",
  "net",
  "tls",
  "dns",
  "dgram",
  "http",
  "http2",
  "https",
  "child_process",
  "cluster",
  "worker_threads",
  "inspector",
  "readline",
  "repl",
  "tty",
  "v8",
  "vm",
  "wasi",
  "module",
  "perf_hooks",
  "async_hooks",
  "diagnostics_channel",
  "trace_events",
  "domain",
  "constants",
  "sys",
  // Node-legacy modules whose browser equivalents are globals / parsing-only:
  "url",
  "querystring",
  "punycode",
  "string_decoder",
]);

/**
 * Every Node built-in module name (the {@link STUBBABLE_BUILTINS} plus the
 * browser-relevant ones deliberately excluded there). Used to recognize a bare
 * `import "crypto"` / `require("stream")` in app or npm code so the SSR (deno) bundle
 * can point it at Deno's `node:` implementation.
 */
const NODE_BUILTINS: ReadonlySet<string> = new Set([
  ...STUBBABLE_BUILTINS,
  "assert",
  "buffer",
  "console",
  "crypto",
  "events",
  "process",
  "stream",
  "timers",
  "util",
  "zlib",
]);

/** Whether a specifier is a bare Node built-in import (`crypto`, `fs/promises`, `stream/web`). */
function nodeBuiltinName(spec: string): string | null {
  if (spec.startsWith("node:")) return null; // already explicit
  const head = spec.split("/")[0];
  return NODE_BUILTINS.has(head) ? spec : null;
}

/**
 * For the **deno/SSR** bundle, resolve a bare Node built-in import (`import "crypto"`,
 * `require("stream/web")`) to its explicit `node:` specifier, marked external so Deno's
 * native Node compat loads it. The esbuild deno-loader otherwise claims the bare name and
 * fails ("not prefixed with / or ./ … and not in import map") — real npm libs and app
 * server code (`import crypto from "crypto"`) hit this constantly. Browser bundles keep
 * the existing {@link nodeBuiltinStubPlugin} behavior (empty-stub the Node-only ones).
 */
function nodeBuiltinResolvePlugin(): esbuild.Plugin {
  return {
    name: "denext-node-builtin-resolve",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.namespace !== "file" && args.namespace !== "") return null;
        const spec = nodeBuiltinName(args.path);
        return spec ? { path: "node:" + spec, external: true } : null;
      });
    },
  };
}

/**
 * For **browser** bundles, stub Node built-ins (`fs`, `path`, …) with an empty
 * module — the esbuild parallel to webpack's `resolve.fallback: { fs: false }`.
 * Some browser-capable npm libraries (e.g. `@techstark/opencv-js`, `scribe.js-ocr`)
 * `require("fs")`/`import "node:path"` inside Node-only code paths that never run in
 * the browser; without this, esbuild's browser target fails to resolve them. The
 * empty CommonJS stub lets both default and named imports resolve (to `undefined`),
 * and the Node-only branch simply isn't taken at runtime. Browser-usable built-ins are
 * intentionally NOT stubbed (see {@link STUBBABLE_BUILTINS}).
 */
export function nodeBuiltinStubPlugin(): esbuild.Plugin {
  const STUB_NS = "denext-node-stub";
  return {
    name: "denext-node-builtin-stub",
    setup(build) {
      build.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, (args) => {
        const bare = args.path.replace(/^node:/, "").split("/")[0];
        if (!STUBBABLE_BUILTINS.has(bare)) return null;
        return { path: args.path, namespace: STUB_NS };
      });
      // CommonJS empty module: named imports resolve at runtime to `undefined`,
      // so esbuild never errors on "no matching export".
      build.onLoad({ filter: /.*/, namespace: STUB_NS }, () => ({
        contents: "module.exports = {};",
        loader: "js",
      }));
    },
  };
}

/**
 * esbuild plugin enforcing the npm `server-only` / `client-only` poison packages
 * at **build time** (Next.js parity). `server-only` imported into a CLIENT
 * (browser) bundle — or `client-only` into a SERVER bundle — fails the build with
 * a clear error, so a server module carrying secrets/DB/fs access can't silently
 * ship to the browser and blow up only at runtime. On the allowed side the module
 * resolves to an empty stub (it's just a marker, exports nothing).
 *
 * @param isServer True for the SSR (deno) bundle, false for the browser bundle.
 */
/**
 * Decide whether importing `spec` (`server-only`/`client-only`) is legal in this
 * bundle: returns a build-error message when it's on the WRONG side (server-only
 * in a client bundle, or client-only in a server bundle), else `null` (allowed).
 * Exported for testing.
 *
 * @param spec The imported specifier.
 * @param isServer True for the SSR (deno) bundle, false for the browser bundle.
 * @param importer The importing module (for the error message), if known.
 */
export function checkEnvPoison(
  spec: string,
  isServer: boolean,
  importer?: string,
): string | null {
  const from = importer ? ` (from ${importer})` : "";
  if (spec === "server-only" && !isServer) {
    return `"server-only" was imported into a CLIENT bundle${from}. A server-only ` +
      `module (secrets, DB, fs) must never ship to the browser — move it behind a ` +
      `Server Component or a "use server" boundary.`;
  }
  if (spec === "client-only" && isServer) {
    return `"client-only" was imported into a SERVER bundle${from}. A client-only ` +
      `module (browser APIs, effects) must not run on the server — import it only ` +
      `from a "use client" module.`;
  }
  return null;
}

function envPoisonPlugin(isServer: boolean): esbuild.Plugin {
  const NS = "denext-env-poison";
  return {
    name: "denext-env-poison",
    setup(build) {
      build.onResolve({ filter: /^server-only$|^client-only$/ }, (args) => {
        const error = checkEnvPoison(args.path, isServer, args.importer);
        return error ? { errors: [{ text: error }] } : { path: args.path, namespace: NS };
      });
      build.onLoad({ filter: /.*/, namespace: NS }, () => ({ contents: "", loader: "js" }));
    },
  };
}

/**
 * Bundle `entry` (client hydration entry or SSR render module) with all react
 * imports — including those inside npm packages — rewritten to the single
 * prebuilt denext runtime.
 *
 * @param options Bundle configuration.
 */
/**
 * Banner for the SSR (`platform:"deno"`) bundle. esbuild's `platform:"node"` leaves node
 * built-ins external and emits `require("node:fs")` for CJS deps that reach them (e.g.
 * gray-matter reading the filesystem). Deno's ESM scope has no `require`, so esbuild's
 * `__require` fallback throws `Dynamic require of "node:fs" is not supported`. esbuild's
 * `__require` helper first honors a real `require` when one is in scope, so define a
 * module-scoped one via `node:module`'s `createRequire` — then externalized CJS requires
 * of node built-ins resolve at runtime instead of throwing.
 */
const DENO_REQUIRE_BANNER = 'import{createRequire as __denextCreateRequire}from"node:module";' +
  "var require=__denextCreateRequire(import.meta.url);";

export async function bundleNextCompat(options: BundleNextCompatOptions): Promise<void> {
  const plugins: esbuild.Plugin[] = [
    envPoisonPlugin(options.platform === "deno"),
    denextRuntimePlugin(options.runtimeDir),
  ];
  // Browser bundles: stub Node built-ins that appear only in npm libs' Node-only
  // code paths (the deno/SSR platform keeps the real built-ins).
  if (options.platform !== "deno") plugins.push(nodeBuiltinStubPlugin());
  if (options.denoLoader ?? true) {
    // The portable loader resolves npm/jsr in-process (no spawned `deno`).
    plugins.push(...denoPlugins({
      configPath: await loaderConfigPath(options.configPath, dirname(options.outfile)),
      loader: "portable",
    }));
  }
  await esbuild.build({
    entryPoints: [options.entry],
    outfile: options.outfile,
    bundle: true,
    format: "esm",
    // "node" for the SSR bundle (Deno emulates Node; enables node_modules lookup +
    // node export conditions), "browser" for the client bundle.
    platform: options.platform === "deno" ? "node" : "browser",
    minify: options.minify ?? false,
    jsx: "automatic",
    jsxImportSource: "react",
    alias: options.extraAlias,
    absWorkingDir: options.absWorkingDir,
    define: classDefine(options.classComponents),
    ...(options.platform === "deno" ? { banner: { js: DENO_REQUIRE_BANNER } } : {}),
    plugins,
  });
}

/** Options for {@link bundleNextCompatModules}. */
export interface BundleNextCompatModulesOptions {
  /** Map of output base name → entry module path (multi-entry). */
  entryPoints: Record<string, string>;
  /**
   * The prebuilt runtime dir from {@link prebuildDenextRuntime} — required unless
   * {@link denextExternal} is set (external mode doesn't inline a runtime).
   */
  runtimeDir?: string;
  /**
   * SSR mode: rewrite react/next → denext's own source files as **external**
   * imports (not inlined), so the bundle shares the ONE denext instance the SSR
   * renderer uses. Use for `platform: "deno"` server bundles. The browser bundle
   * must leave this off (it inlines the prebuilt runtime instead).
   */
  denextExternal?: boolean;
  /** Output directory (per-entry `.js` + shared `chunk-*.js` land here). */
  outdir: string;
  /** Project `deno.json` (for resolving app + npm deps via the deno loader). */
  configPath: string;
  /** Bundle target: browser (client) or deno (SSR). */
  platform?: "browser" | "deno";
  /** Minify (production). */
  minify?: boolean;
  /** Use `@luca/esbuild-deno-loader` for jsr:/@std/https: (default true). */
  denoLoader?: boolean;
  /** deno-loader resolution mode: "native" spawns `deno` (honors sloppy-imports +
   * full import map); "portable" resolves in-process. Default "portable". */
  denoLoaderMode?: "portable" | "native";
  /** Absolute working directory (where node_modules lives). */
  absWorkingDir?: string;
  /** Compile in the class-component runtime (default false → DCE'd out). */
  classComponents?: boolean;
  /**
   * Extra esbuild plugins, inserted BEFORE the built-in ones so their
   * `onResolve`/`onLoad` hooks win. Used by the compat Flight bundle to redirect
   * `"use server"` modules to client action stubs (server code stripped).
   */
  extraPlugins?: esbuild.Plugin[];
  /**
   * Extra esbuild `define` replacements merged over the built-in class-flag define
   * (a later key wins). Keys are member expressions replaced verbatim in the
   * source — e.g. `{ "import.meta.env.VITE_X": '"value"' }` provides the compile-time
   * env substitution a Vite `define` block does (SPA mode uses this for `import.meta.env`).
   */
  define?: Record<string, string>;
  /**
   * Vite-style asset handling. When set, enables `?url`/`?raw`/`?inline`/`?worker`
   * imports and emits bare asset imports (`.wasm`/`.woff2`/…) + `new URL(…,
   * import.meta.url)` as files under `outdir`, minting URLs prefixed with
   * `publicPath` (point it at where the assets are served, e.g. `/_denext/client/`).
   */
  assets?: AssetOptions;
  /**
   * Package names whose version in the app `package.json` is a pnpm
   * `catalog:`/`workspace:*` reference. The esbuild deno-loader's workspace resolver
   * throws on those version strings, so denext front-runs it: these packages are
   * resolved straight from `node_modules` (honoring their `exports`/`main`) against
   * `absWorkingDir`. Non-catalog deps still go through the deno-loader.
   */
  catalogPackages?: string[];
  /**
   * `experimental.nodeResolve`: resolve EVERY bare npm specifier from `node_modules`
   * (denext's tolerant resolver), superseding {@link catalogPackages}. Deno's strict
   * `npm:` loader then never touches app deps, so incomplete `exports` maps and
   * `catalog:`/`workspace:*` versions stop mattering — the "seamless migration" path.
   * Requires `absWorkingDir`. Off → the narrow `catalogPackages` behavior is unchanged.
   */
  resolveAllNodeModules?: boolean;
  /**
   * App MDX config (`denext.config.ts` `mdx`): unified remark/rehype/recma plugin lists
   * forwarded to MDX's `compile` for `.mdx`/`.md` sources. Omit for the baseline
   * plain-MDX loader.
   */
  mdxOptions?: MdxBuildOptions;
  /**
   * CSS shim map (stylesheet file URL → precompiled JS shim path) from `buildAppCss`.
   * When set, every `.css`/`.scss`/`.sass` import is redirected to its shim uniformly —
   * needed so stylesheets imported from OUTSIDE the app dir (sibling workspace packages)
   * resolve, which esbuild's default resolver can't do. Omit when the app has no CSS.
   */
  cssImportMap?: Record<string, string>;
}

/**
 * An esbuild content-loader name — the value type of {@link AssetOptions.loaders}
 * (mirrors esbuild's own `Loader` union so the public API doesn't expose a type from
 * the esbuild dependency).
 */
export type AssetLoader =
  | "base64"
  | "binary"
  | "copy"
  | "css"
  | "dataurl"
  | "default"
  | "empty"
  | "file"
  | "js"
  | "json"
  | "jsx"
  | "local-css"
  | "text"
  | "ts"
  | "tsx";

/** Vite-style asset handling for the compat bundle (see {@link BundleNextCompatModulesOptions.assets}). */
export interface AssetOptions {
  /** URL prefix prepended to every emitted asset/chunk URL (e.g. `"/_denext/client/"`). */
  publicPath: string;
  /** esbuild `assetNames` template. Default `"assets/[name]-[hash]"`. */
  assetNames?: string;
  /** Extra extension→loader entries merged over the built-in asset loaders. */
  loaders?: Record<string, AssetLoader>;
}

// @mdx-js/mdx is loaded lazily so an app without any `.mdx`/`.md` never pays for it.
let mdxCompile: Promise<typeof import("@mdx-js/mdx")["compile"]> | null = null;
function mdxCompiler(): Promise<typeof import("@mdx-js/mdx")["compile"]> {
  if (!mdxCompile) mdxCompile = import("@mdx-js/mdx").then((m) => m.compile);
  return mdxCompile;
}

/**
 * MDX build options threaded from `denext.config.ts` (`mdx`). Mirrors the compile-time
 * subset of the app's MDX config; typed loosely so this build module stays decoupled
 * from the server config types. Plugin lists are unified `PluggableList`s.
 */
export interface MdxBuildOptions {
  /** remark (Markdown AST) plugins — unified `Pluggable[]` (fn or `[fn, options]`). */
  remarkPlugins?: unknown[];
  /** rehype (HTML AST) plugins — unified `Pluggable[]`. */
  rehypePlugins?: unknown[];
  /** recma (JS AST) plugins — unified `Pluggable[]`. */
  recmaPlugins?: unknown[];
  /** Options forwarded to MDX's `remark-rehype` bridge (`remarkRehypeOptions`). */
  remarkRehypeOptions?: Record<string, unknown>;
  /** MDX `providerImportSource` (module exporting `useMDXComponents`), if used. */
  providerImportSource?: string;
}

/**
 * Compile one MDX/Markdown source to a JS module string (React automatic runtime,
 * `jsxImportSource: "react"` → aliased to denext downstream). With no `opts` this is
 * the baseline plain-MDX/CommonMark path; when the app configures `mdx` in
 * `denext.config.ts`, its unified remark/rehype/recma plugin lists (e.g. Codehike, GFM)
 * are forwarded verbatim to MDX's `compile`. Exported for unit testing the plugin wiring.
 */
export async function compileMdxSource(
  path: string,
  source: string,
  opts?: MdxBuildOptions,
): Promise<string> {
  const compile = await mdxCompiler();
  // deno-lint-ignore no-explicit-any -- unified Pluggable[] carried loosely; MDX validates.
  const pluggable = (v: unknown[] | undefined): any => (v && v.length > 0 ? v : undefined);
  const compiled = await compile(
    { path, value: source },
    {
      jsxImportSource: "react",
      remarkPlugins: pluggable(opts?.remarkPlugins),
      rehypePlugins: pluggable(opts?.rehypePlugins),
      recmaPlugins: pluggable(opts?.recmaPlugins),
      remarkRehypeOptions: opts?.remarkRehypeOptions,
      providerImportSource: opts?.providerImportSource,
    },
  );
  return String(compiled);
}

/**
 * esbuild plugin: compile `.mdx` / `.md` to a React component module (see
 * {@link compileMdxSource}). App-configured MDX plugins are forwarded when `opts` is set.
 */
function mdxPlugin(opts?: MdxBuildOptions): esbuild.Plugin {
  return {
    name: "denext-mdx",
    setup(build) {
      build.onLoad({ filter: /\.mdx?$/ }, async (args) => {
        const source = await Deno.readTextFile(args.path);
        return {
          contents: await compileMdxSource(args.path, source, opts),
          loader: "js",
          resolveDir: dirname(args.path),
        };
      });
    },
  };
}

/**
 * esbuild plugin: redirect EVERY stylesheet import (`.css`/`.scss`/`.sass`) to its
 * precompiled JS shim, keyed by the imported file's absolute URL in `cssImportMap`
 * (from {@link https | buildAppCss}). This runs ahead of the app resolver and the
 * deno-loader so it applies uniformly — including stylesheets imported by modules
 * OUTSIDE the app dir (a monorepo importing a sibling workspace package's `.scss`),
 * which esbuild's default resolver would otherwise try to load with no `.scss` loader.
 * A stylesheet not in the map (e.g. discovered too late) resolves to an empty shim so
 * the bundle never breaks on a missing CSS loader.
 */
function cssShimPlugin(cssImportMap: Record<string, string>): esbuild.Plugin {
  const EMPTY_NS = "denext-css-empty";
  return {
    name: "denext-css-shim",
    setup(build) {
      build.onResolve({ filter: /\.(css|scss|sass)(?:[?#].*)?$/i }, (args) => {
        // Resolve the stylesheet to an absolute path (relative to its importer), strip
        // any `?query`/`#hash`, and look up the shim the CSS pipeline generated for it.
        const clean = args.path.replace(/[?#].*$/, "");
        const abs = clean.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(clean)
          ? clean
          : resolve(args.resolveDir || dirname(args.importer), clean);
        const shim = cssImportMap[toFileUrl(abs).href];
        if (shim) return { path: fromFileUrl(shim) }; // real .js shim on disk
        return { path: abs, namespace: EMPTY_NS }; // unknown sheet → empty module
      });
      build.onLoad({ filter: /.*/, namespace: EMPTY_NS }, () => ({
        contents: "export default {};\n",
        loader: "js",
      }));
    },
  };
}

/** Default extension→loader map for Vite-style bare asset imports (emitted as files → URL). */
const DEFAULT_ASSET_LOADERS: Record<string, esbuild.Loader> = {
  ".wasm": "file",
  ".woff": "file",
  ".woff2": "file",
  ".ttf": "file",
  ".otf": "file",
  ".png": "file",
  ".jpg": "file",
  ".jpeg": "file",
  ".gif": "file",
  ".webp": "file",
  ".avif": "file",
  ".svg": "file",
  ".ico": "file",
  ".mp3": "file",
  ".mp4": "file",
  ".webm": "file",
};

/** Split a bare specifier into `[packageName, subpath]` (subpath `""` for the root, else `/x`). */
export function splitPackageSpecifier(spec: string): [string, string] {
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return [name, spec.slice(name.length)];
}

/**
 * Export conditions for the **browser** (client) compat bundle, in priority order.
 * `browser` first so a package's browser build wins in island/Flight code.
 */
export const BROWSER_CONDITIONS = ["browser", "import", "module", "default"];
/**
 * Export conditions for the **SSR** (`platform:"deno"`) bundle. `node` first and NO
 * `browser`, so a package's Node build is chosen at server-render time (picking the
 * browser condition here pulls browser-only code — e.g. an HTML-entity decoder doing
 * `document.createElement` at module scope — into SSR → `document is not defined`).
 *
 * CJS-first: `require`/`default` are tried before `import`/`module`. The SSR bundle
 * interops CJS heavily (transpiled npm packages), and an ESM-only conditional build can
 * lack a default export a CJS consumer needs — e.g. tslib's `import` condition resolves
 * to `modules/index.js` (named exports, no default), so styled-components' CJS code
 * (`tslib.default.__extends`) throws; its `default` condition (`tslib.js`, CJS) has the
 * default. `import`/`module` remain as a fallback so pure-ESM packages still resolve.
 * This mirrors Node's own `require()` resolution (which never consults `import`).
 */
export const SSR_CONDITIONS = ["node", "require", "default", "import", "module"];

/** Resolve a conditions node (string, or `{ import|browser|default: … }`) to a target string. */
function resolveConditions(node: unknown, conditions: string[]): string | null {
  if (typeof node === "string") return node;
  if (node && typeof node === "object" && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>;
    for (const c of conditions) {
      if (c in obj) {
        const r = resolveConditions(obj[c], conditions);
        if (r) return r;
      }
    }
  }
  return null;
}

/**
 * Resolve a package `exports` map for `subpath` (`""` = root, else `/sub`) to a
 * relative target, honoring conditions and `./*` wildcards. Returns `null` when the
 * package has no `exports` or the subpath isn't exported (caller falls back to main).
 */
export function resolveExportsField(
  exportsField: unknown,
  subpath: string,
  conditions: string[] = BROWSER_CONDITIONS,
): string | null {
  const key = subpath === "" ? "." : "." + subpath;
  if (typeof exportsField === "string") return subpath === "" ? exportsField : null;
  if (!exportsField || typeof exportsField !== "object") return null;
  const exp = exportsField as Record<string, unknown>;
  const keys = Object.keys(exp);
  const isSubpathMap = keys.some((k) => k === "." || k.startsWith("./"));
  if (!isSubpathMap) return subpath === "" ? resolveConditions(exp, conditions) : null;
  if (key in exp) return resolveConditions(exp[key], conditions);
  return resolveWildcardExport(exp, key, conditions);
}

/** `./*` wildcard patterns (e.g. `"./*": "./dist/esm/*.js"`): the first key matching `key`. */
function resolveWildcardExport(
  exp: Record<string, unknown>,
  key: string,
  conditions: string[],
): string | null {
  for (const k of Object.keys(exp)) {
    const star = k.indexOf("*");
    if (star === -1) continue;
    const pre = k.slice(0, star), post = k.slice(star + 1);
    if (!key.startsWith(pre) || !key.endsWith(post) || key.length < pre.length + post.length) {
      continue;
    }
    const target = resolveConditions(exp[k], conditions);
    if (target) return target.replace("*", key.slice(pre.length, key.length - post.length));
  }
  return null;
}

/** Probe a resolved path for a real file, trying common JS/TS extensions + an index. */
async function probePackageFile(base: string): Promise<string | null> {
  const cands = [
    base,
    ...[".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"].map((e) => base + e),
    ...[".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"].map((e) => join(base, "index" + e)),
  ];
  for (const c of cands) {
    try {
      if ((await Deno.stat(c)).isFile) return c;
    } catch { /* keep trying */ }
  }
  return null;
}

/** Resolve `subpath` within a concrete package dir via its `exports`/`module`/`main`. */
export async function resolveInPackageDir(
  pkgDir: string,
  subpath: string,
  conditions: string[] = BROWSER_CONDITIONS,
): Promise<string | null> {
  let pkg: { exports?: unknown; module?: string; main?: string };
  try {
    pkg = JSON.parse(await Deno.readTextFile(join(pkgDir, "package.json")));
  } catch {
    return null;
  }
  let rel = pkg.exports ? resolveExportsField(pkg.exports, subpath, conditions) : null;
  // No `exports` field: fall back to the legacy fields. The SSR bundle (no `browser`
  // condition) prefers `main` (the Node/CJS build) over `module` so an isomorphic-but-
  // browser-leaning ESM build doesn't reach server render; the browser bundle keeps
  // `module` first for tree-shakeable ESM.
  const prefersNode = conditions === SSR_CONDITIONS;
  if (!rel) {
    rel = subpath === ""
      ? (prefersNode
        ? (pkg.main ?? pkg.module ?? "index.js")
        : (pkg.module ?? pkg.main ?? "index.js"))
      : "." + subpath;
  }
  const file = await probePackageFile(join(pkgDir, rel.replace(/^\.\//, "")));
  if (!file) return null;
  // Realpath through pnpm's symlink: a package's private deps live next to its REAL
  // location (`.pnpm/<parent>/node_modules/<dep>`), so the next importer-relative walk
  // must start from the real dir — exactly what Node's resolver does (and why pnpm works).
  try {
    return await Deno.realPath(file);
  } catch {
    return file;
  }
}

/**
 * Resolve a bare `spec` (`effect`, `effect/Array`, `@t3tools/shared/devProxy`) to a
 * concrete file by walking up `node_modules` from `fromDir` — the standard node
 * algorithm, which handles both hoisted deps (`apps/web/node_modules/<pkg>`) and
 * pnpm's nested layout (a package's own deps under `.pnpm/<parent>/node_modules/`).
 * Honors the package's `exports` map (else `module`/`main`/`index`). Also resolves Node's
 * **package self-reference**: a module inside a package importing its OWN package by name
 * (`@t3tools/client-runtime/media-source` from `packages/client-runtime/src/…`) resolves
 * through that package's `exports` — pnpm links a workspace package into its consumers'
 * `node_modules`, never into its own, so the walk alone can't find it.
 */
export async function resolveNodeFrom(
  fromDir: string,
  spec: string,
  conditions: string[] = BROWSER_CONDITIONS,
): Promise<string | null> {
  const [name, subpath] = splitPackageSpecifier(spec);
  let dir = fromDir;
  for (;;) {
    const r = await resolveInPackageDir(join(dir, "node_modules", name), subpath, conditions);
    if (r) return r;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const self = await selfPackageDir(fromDir, name);
  return self ? await resolveInPackageDir(self, subpath, conditions) : null;
}

/**
 * The nearest ancestor of `fromDir` whose `package.json` is named `name` (Node's self-
 * reference rule), or null. Stops at a `node_modules` boundary — a dependency's own tree
 * is not "self" for the importing app.
 */
async function selfPackageDir(fromDir: string, name: string): Promise<string | null> {
  let dir = fromDir;
  for (;;) {
    if (basename(dir) === "node_modules") return null;
    try {
      const pkg = JSON.parse(await Deno.readTextFile(join(dir, "package.json")));
      if (pkg?.name === name) return dir;
    } catch { /* no package.json here */ }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * esbuild plugin that front-runs the deno-loader for pnpm `catalog:`/`workspace:*`
 * packages, whose version strings the loader's workspace resolver can't parse.
 * Registered after {@link appResolverPlugin} (so relative/alias imports win first)
 * and before the deno-loader, and only when the app HAS catalog/workspace deps. It
 * resolves a named catalog package (imported by app code) from the app's hoisted
 * `node_modules`, and everything else importer-relative (a node_modules walk) — which
 * covers a catalog package's whole transitive subtree AND a workspace package's raw
 * source importing its own locally-declared `catalog:` dep. It claims ONLY when a file
 * is found; anything else (jsr:/https:, or unresolved) falls through to the deno-loader.
 * `react`/`next/*` are claimed earlier by the runtime plugin, so they still map to denext.
 *
 * @param projectDir Where the app's `node_modules` lives (for the named packages).
 * @param packages The catalog/workspace package names declared by the app, or `"all"` to
 *   resolve EVERY bare npm specifier from `node_modules` (the `experimental.nodeResolve`
 *   path — Deno's strict `npm:` loader never touches app deps, so incomplete `exports`
 *   globs and `catalog:`/`workspace:*` version strings stop mattering). denext's resolver
 *   is a strict superset of Deno's: it returns `null` for anything it can't place, so the
 *   deno-loader still gets its shot — the plugin only ever resolves MORE, never less.
 */
export function catalogResolverPlugin(
  projectDir: string,
  packages: Set<string> | "all",
  conditions: string[] = BROWSER_CONDITIONS,
): esbuild.Plugin {
  const all = packages === "all";
  return {
    name: all ? "denext-node-modules-resolver" : "denext-pnpm-catalog-resolver",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.namespace !== "file" && args.namespace !== "") return null;
        if (args.path.startsWith(".") || args.path.startsWith("/")) return null;
        // Scheme specifiers (npm:/jsr:/node:/http:/data:) belong to the deno-loader and
        // denext's own runtime imports — never intercept them. (The narrow catalog set is
        // always plain package names, so this only gates the `"all"` path.)
        if (all && /^[a-z][a-z0-9+.-]*:/.test(args.path)) return null;
        const [name] = splitPackageSpecifier(args.path);
        const inNodeModules = args.importer.includes("/node_modules/");
        // `"all"`: always walk up from the importer's own dir (Node semantics) — this is
        // what lets a workspace package's SOURCE file (outside the app root) resolve its
        // deps from its own `node_modules`, not just the app's. The narrow catalog set
        // keeps its app-root bias for hoisted direct deps (backward-compatible).
        const fromDir = all
          ? (args.importer ? dirname(args.importer) : projectDir)
          : (packages.has(name) && !inNodeModules) || !args.importer
          ? projectDir
          : dirname(args.importer);
        const resolved = await resolveNodeFrom(fromDir, args.path, conditions);
        return resolved ? { path: resolved } : null;
      });
    },
  };
}

/** Deterministic short hash of a string (FNV-1a, base36) — for worker asset names. */
function assetHash(s: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

/**
 * esbuild plugin for Vite-style asset imports (`?url`/`?raw`/`?inline`/`?worker`).
 * Registered BEFORE {@link appResolverPlugin} (whose `probe` would null-resolve a
 * `?query` path and hand it to the deno-loader, which then errors). Each query form
 * resolves the real module through the full plugin chain (`build.resolve`, so
 * relative/alias/npm all work), then routes it to a namespace whose loader emits the
 * right thing: `?url`→a file (URL string), `?raw`→text, `?inline`→data URL,
 * `?worker`→a nested build + a `new Worker(url)` stub. Bare `.wasm`/`.woff2`/… and
 * `new URL(…, import.meta.url)` are handled by esbuild's own `loader` map + this
 * build's `assetNames`/`publicPath` (no plugin needed).
 *
 * @param assets Public-path/asset-name config.
 * @param workerBuild Builds a worker module as its own entry into `outdir`, returning
 *   the public URL of the emitted chunk (memoized by the caller per resolved path).
 */
/** The esbuild namespace each Vite query flag loads through. */
const VITE_ASSET_NS: Record<string, string> = {
  url: "vite-url",
  raw: "vite-raw",
  inline: "vite-inline",
  worker: "vite-worker",
};

/** The `?worker` module: a class whose constructor spawns the emitted worker chunk. */
function workerStub(url: string): string {
  return `export default class { constructor(o){ return new Worker(new URL(${
    JSON.stringify(url)
  }, import.meta.url), { type: "module", ...o }); } }`;
}

function viteAssetPlugin(
  assets: AssetOptions,
  workerBuild: (entryPath: string, outName: string) => Promise<void>,
): esbuild.Plugin {
  const QUERY = /\?(url|raw|inline|worker)(&[^?]*)?$/;
  const workerCache = new Map<string, string>();
  /** Emit (once per resolved path) the worker's own bundle and return its public URL. */
  const workerUrl = async (path: string): Promise<string> => {
    let url = workerCache.get(path);
    if (!url) {
      const name = `worker-${assetHash(path)}`;
      await workerBuild(path, `assets/${name}`);
      url = assets.publicPath + `assets/${name}.js`;
      workerCache.set(path, url);
    }
    return url;
  };
  return {
    name: "denext-vite-assets",
    setup(build) {
      build.onResolve({ filter: QUERY }, async (args) => {
        const qIdx = args.path.indexOf("?");
        const base = args.path.slice(0, qIdx);
        const flag = args.path.slice(qIdx + 1).split("&")[0];
        // Resolve the real module through the full chain (skip our own plugin — the
        // query is stripped, so it can't re-match — avoiding recursion).
        const resolved = await build.resolve(base, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir || (args.importer ? dirname(args.importer) : ""),
          namespace: args.namespace,
        });
        if (resolved.errors.length > 0) return { errors: resolved.errors };
        return { path: resolved.path, namespace: VITE_ASSET_NS[flag] ?? "vite-url" };
      });
      build.onLoad({ filter: /.*/, namespace: "vite-url" }, async (args) => ({
        contents: await Deno.readFile(args.path),
        loader: "file",
        resolveDir: dirname(args.path),
      }));
      build.onLoad({ filter: /.*/, namespace: "vite-raw" }, async (args) => ({
        contents: await Deno.readTextFile(args.path),
        loader: "text",
      }));
      build.onLoad({ filter: /.*/, namespace: "vite-inline" }, async (args) => ({
        contents: await Deno.readFile(args.path),
        loader: "dataurl",
      }));
      build.onLoad({ filter: /.*/, namespace: "vite-worker" }, async (args) => ({
        contents: workerStub(await workerUrl(args.path)),
        loader: "js",
      }));
    },
  };
}

/**
 * Node-modules resolution ahead of the deno-loader. `nodeResolve` covers EVERY bare
 * specifier (seamless migration); otherwise just the narrow pnpm catalog:/workspace: set
 * whose version strings the loader's resolver can't parse. Export conditions follow the
 * target: SSR (deno) picks Node builds, the client bundle picks browser builds — so
 * browser-only code never reaches server render.
 */
function nodeModulesPlugins(options: BundleNextCompatModulesOptions): esbuild.Plugin[] {
  const conditions = options.platform === "deno" ? SSR_CONDITIONS : BROWSER_CONDITIONS;
  if (!options.absWorkingDir) return [];
  if (options.resolveAllNodeModules) {
    return [catalogResolverPlugin(options.absWorkingDir, "all", conditions)];
  }
  if (options.catalogPackages && options.catalogPackages.length > 0) {
    return [
      catalogResolverPlugin(options.absWorkingDir, new Set(options.catalogPackages), conditions),
    ];
  }
  return [];
}

/**
 * The compat plugin chain, in precedence order: caller plugins first (e.g. the Flight
 * bundle's `"use server"` → client-stub redirect); `server-only`/`client-only` poison;
 * the denext runtime (SSR: external shared instance; client: inlined prebuilt runtime);
 * Vite-style asset imports (MUST precede the app resolver, which would otherwise
 * null-resolve a `?query` path to the deno-loader); the `.css`/`.scss`/`.sass` → shim
 * redirect (ahead of the app resolver/deno-loader so it also catches stylesheets from
 * sibling workspace packages); MDX; a Prisma ESM/Deno client under `generated/` kept
 * EXTERNAL on the server bundle (its native engine loading doesn't survive esbuild; a
 * file:// external can't load in the browser anyway); the app's own `@/…`/relative
 * extensionless imports; bare Node built-ins → `node:` on the SSR bundle; node_modules
 * resolution; the browser built-in stub; and finally the deno-loader.
 */
async function compatPlugins(
  options: BundleNextCompatModulesOptions,
  workerBuild: (entryPath: string, outName: string) => Promise<void>,
): Promise<esbuild.Plugin[]> {
  const deno = options.platform === "deno";
  const plugins: esbuild.Plugin[] = [
    ...(options.extraPlugins ?? []),
    envPoisonPlugin(deno),
    options.denextExternal
      ? await denextExternalPlugin()
      : denextRuntimePlugin(options.runtimeDir!),
    ...(options.assets ? [viteAssetPlugin(options.assets, workerBuild)] : []),
    ...(options.cssImportMap ? [cssShimPlugin(options.cssImportMap)] : []),
    mdxPlugin(options.mdxOptions),
    ...(deno ? [prismaGeneratedClientExternalPlugin(options.configPath)] : []),
    appResolverPlugin(options.configPath),
    ...(deno ? [nodeBuiltinResolvePlugin()] : []),
    ...nodeModulesPlugins(options),
  ];
  if (!deno) plugins.push(nodeBuiltinStubPlugin());
  if (options.denoLoader ?? true) {
    plugins.push(...denoPlugins({
      configPath: await loaderConfigPath(options.configPath, options.outdir),
      loader: options.denoLoaderMode ?? "portable",
    }));
  }
  return plugins;
}

/**
 * Bundle MANY entries in ONE code-split pass. `splitting` hoists the shared
 * denext runtime (and any npm lib imported by more than one entry) into common
 * `chunk-*.js` files that every entry imports. When the outputs are later
 * imported together at runtime (a route's page + layouts + templates + boundary
 * modules), Deno dedupes those shared chunks by URL → **one** denext instance
 * across the whole tree. This is the single-instance guarantee that a per-entry
 * `bundleNextCompat` (which would inline denext into each output) cannot give.
 *
 * @param options Bundle configuration.
 */
export async function bundleNextCompatModules(
  options: BundleNextCompatModulesOptions,
): Promise<void> {
  const assets = options.assets;
  // Build a worker module as its own entry into the same outdir (a nested pass, so a
  // `?worker` import bundles independently). Same runtime/config/define/loaders; no
  // extraPlugins (the worker isn't a Flight bundle). Caller memoizes per resolved path.
  const workerBuild = (entryPath: string, outName: string): Promise<void> =>
    bundleNextCompatModules({
      ...options,
      entryPoints: { [outName]: entryPath },
      extraPlugins: undefined,
    });
  const deno = options.platform === "deno";
  await esbuild.build({
    entryPoints: options.entryPoints,
    outdir: options.outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: deno ? "node" : "browser",
    minify: options.minify ?? false,
    jsx: "automatic",
    jsxImportSource: "react",
    absWorkingDir: options.absWorkingDir,
    // Wasm codecs (next/og, next/image) are lazily imported and resolve at SSR
    // runtime — keep them external so esbuild never tries to bundle their .wasm.
    external: ["@denext/photon", "@denext/avif", "@denext/og"],
    define: { ...classDefine(options.classComponents), ...options.define },
    ...(deno ? { banner: { js: DENO_REQUIRE_BANNER } } : {}),
    // Vite-style asset emission: bare `.wasm`/`.woff2`/… + `new URL(…)` → files
    // under `outdir`, URLs prefixed with `publicPath` (where they are served).
    ...(assets
      ? {
        loader: { ...DEFAULT_ASSET_LOADERS, ...assets.loaders },
        assetNames: assets.assetNames ?? "assets/[name]-[hash]",
        publicPath: assets.publicPath,
      }
      : {}),
    plugins: await compatPlugins(options, workerBuild),
  });
}

/**
 * esbuild plugin for the compat Flight (browser) bundle: redirect every
 * `"use server"` module to a generated client action stub, so server-only code
 * never enters the island bundle. Mirrors the import-map redirect the native
 * `bundleFlightEntry` uses, but as an esbuild `onLoad` keyed on the module's
 * absolute path (after the app resolver has resolved it) — the client islands
 * reach these modules transitively (an island importing a `"use server"` action).
 *
 * @param servers Map of stable module id → `{ url, exports }` (boundary manifest).
 * @param stubOf Generate the stub source for a `(moduleId, exports)` pair.
 */
export function serverStubPlugin(
  servers: Iterable<[string, { url: string; exports: string[] }]>,
  stubOf: (moduleId: string, exports: string[]) => string,
): esbuild.Plugin {
  const byPath = new Map<string, { id: string; exports: string[] }>();
  for (const [id, ref] of servers) {
    byPath.set(fromFileUrl(ref.url), { id, exports: ref.exports });
  }
  return {
    name: "denext-server-stub",
    setup(build) {
      build.onLoad({ filter: /\.(tsx?|jsx?|mjs|cjs)$/, namespace: "file" }, (args) => {
        const s = byPath.get(args.path);
        if (!s) return null;
        return { contents: stubOf(s.id, s.exports), loader: "ts", resolveDir: dirname(args.path) };
      });
    },
  };
}

/** Release esbuild's long-lived service process (call once at process end). */
export function stopNextCompat(): Promise<void> {
  return esbuild.stop();
}

/**
 * Run `fn` (typically one or more {@link prebuildDenextRuntime}/
 * {@link bundleNextCompat} calls) and **always** release esbuild's service
 * afterwards — even if `fn` throws. Use this for one-shot builds so a failed
 * build can never orphan the esbuild service process. Long-lived callers (the dev
 * server) should instead call {@link stopNextCompat} on shutdown.
 *
 * @param fn The build work to run.
 * @returns Whatever `fn` resolves to.
 */
export async function withEsbuild<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    await esbuild.stop();
  }
}

/** Convert a filesystem path to a `file://` URL string (for dynamic import). */
export function toImportUrl(path: string): string {
  return toFileUrl(resolve(path)).href;
}

/**
 * Keep a Prisma ESM/Deno client (produced by `denext migrate`'s Prisma wiring under
 * `<project>/generated/`) EXTERNAL on the server bundle. The generated client loads a native
 * query engine via a `globalThis['__dirname']` shim and bakes generator config that esbuild
 * mangles when bundled — breaking `new PrismaClient({ adapter })` and `__dirname` at runtime.
 * Externalizing (file://) lets the deno SSR runtime load it unbundled, exactly as the native
 * (non-compat) build path does. Registered only for `platform:"deno"`, ahead of the app
 * resolver. The `@prisma/client/runtime` content check leaves an unrelated `generated/` dir
 * bundled normally.
 */
function prismaGeneratedClientExternalPlugin(configPath: string): esbuild.Plugin {
  const projectRoot = dirname(configPath);
  return {
    name: "denext-prisma-external",
    setup(build) {
      // Migrate writes the client import with an explicit path segment (`generated/…/client`),
      // so a narrow filter keeps this off the hot path for every other resolve.
      build.onResolve({ filter: /generated[\\/].*client/ }, async (args) => {
        if (args.namespace !== "file" && args.namespace !== "") return null;
        if (!args.importer || !(args.path.startsWith("./") || args.path.startsWith("../"))) {
          return null;
        }
        const file = resolve(dirname(args.importer), args.path);
        const rel = relative(join(projectRoot, "generated"), file);
        if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
        const isPrisma = await Deno.readTextFile(file)
          .then((src) => src.includes("@prisma/client/runtime"))
          .catch(() => false);
        return isPrisma ? { path: toFileUrl(file).href, external: true } : null;
      });
    },
  };
}
