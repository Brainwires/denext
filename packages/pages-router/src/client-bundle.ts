// The Pages Router client bundler: turn the scanned page tree into browser
// hydration bundles (+ per-route CSS) and serve them under `/_denext/pages/`.
//
// denext bundles with `deno bundle` (the Deno CLI's own bundler — no npm), via
// the public `@denext/denext/bundle` primitive. Every route's generated entry
// imports the same shared runtime and `_app`, so a single code-split pass hoists
// those into one shared chunk downloaded once and reused across soft navigations.
//
// CSS: `buildAppCss` (from `@denext/denext/build/css`) redirects every `.css`
// import to a JS shim so `deno bundle` never parses CSS as JS; `extractRouteCss`
// collects each route's reachable CSS, served as `/_denext/pages/<id>.css` and
// linked at SSR for a styled first paint.
//
// Two serving modes:
//   • dev   — bundle lazily in-process, cache in memory, re-bundle when the set
//             of page files changes (new/removed routes picked up without restart);
//   • prod  — read the bundles a `denext build` step pre-wrote to disk; if none
//             are present (e.g. running from source without a build), fall back to
//             an in-process bundle so the app still works.

import { join } from "@std/path";
// Pipeline primitives come from the router-plugin toolkit (semver-stable facade).
import { type AppCss, buildAppCss, bundleRoutes, extractRouteCss } from "@denext/denext/plugin-kit";
import { generateClientEntry, routeId } from "./client-entry.ts";
import type { PagesScan } from "./scan.ts";

/** URL prefix every Pages Router client bundle is served under. */
export const PAGES_PREFIX = "/_denext/pages/";

/** The manifest a build step writes alongside the bundles for prod to read. */
interface DiskManifest {
  /** routePath → emitted entry basename. */
  entries: Record<string, string>;
  /** routePath → its CSS basename (present only for routes that pull in CSS). */
  css?: Record<string, string>;
}

/** A completed bundle pass: emitted files + the per-route entry/CSS basenames. */
interface Built {
  /** Signature of the scan this was built from (`"disk"` when read pre-built). */
  sig: string;
  /** Every emitted JS file (entries + shared chunks) keyed by basename. */
  files: Map<string, string>;
  /** routePath → its entry basename in {@linkcode files}. */
  entryByRoute: Map<string, string>;
  /** CSS text keyed by basename (`<routeId>.css`). */
  cssFiles: Map<string, string>;
  /** routePath → its CSS basename in {@linkcode cssFiles} (only routes with CSS). */
  cssByRoute: Map<string, string>;
}

/** Options for {@linkcode createClientBundler}. */
export interface ClientBundlerOptions {
  /** Resolve the current scanned page tree (re-scanned per call in dev). */
  getScan: () => PagesScan | Promise<PagesScan>;
  /** deno config path used for import resolution when bundling. */
  configPath: string;
  /** Absolute project root (scanned for CSS; base for shim output). */
  projectRoot: string;
  /** Dev mode: emit sourcemaps, skip minify, re-bundle on route-set changes. */
  dev: boolean;
  /** Tailwind input/output (absolute) when the project uses Tailwind. */
  tailwind?: { input: string; output: string };
  /** Prod: directory holding pre-built bundles (from the build step), if any. */
  readDir?: string;
}

/** The bundler handed to the request handler and (optionally) the build step. */
export interface ClientBundler {
  /** The client bundle URL for a route (`/_denext/pages/<id>.js`), or null. */
  urlFor(routePath: string): Promise<string | null>;
  /** The stylesheet URL for a route (`/_denext/pages/<id>.css`), or null. */
  cssUrlFor(routePath: string): Promise<string | null>;
  /** Serve a `/_denext/pages/*.js` or `*.css` request, or null if not ours. */
  serve(pathname: string): Promise<Response | null>;
  /**
   * Pre-bundle every route into `outDir/pages-client/` (a build step). Returns the
   * per-route entry/CSS basenames so a downstream step (SSG) can build asset URLs
   * without re-bundling.
   */
  prebuild(
    outDir: string,
  ): Promise<
    { entryByRoute: Map<string, string>; cssByRoute: Map<string, string> }
  >;
}

/** Best-effort mtime (ms) of a file, or 0 — used to bust the dev cache on edits. */
async function mtimeOf(filePath: string): Promise<number> {
  try {
    return (await Deno.stat(filePath)).mtime?.getTime() ?? 0;
  } catch {
    return 0;
  }
}

/**
 * A stable signature of the page set — changes when routes are added/removed. In
 * dev it also folds in file mtimes so editing a page's source rebuilds the bundle.
 */
async function signature(scan: PagesScan, dev: boolean): Promise<string> {
  const files = [scan.app, scan.document, ...scan.pages.map((p) => p.filePath)]
    .filter(
      (f): f is string => !!f,
    );
  const parts = scan.pages.map((p) => `${p.routePath}\0${p.filePath}`).sort();
  let base = `${scan.app ?? ""}::${scan.document ?? ""}::${parts.join("|")}`;
  if (dev) {
    const mtimes = await Promise.all(
      files.sort().map(async (f) => `${f}@${await mtimeOf(f)}`),
    );
    base += `::${mtimes.join("|")}`;
  }
  return base;
}

/** Generate the entry sources for a scan (one per page route). */
function entriesFor(
  scan: PagesScan,
  dev: boolean,
): Array<{ key: string; source: string }> {
  return scan.pages.map((p) => ({
    key: p.routePath,
    source: generateClientEntry({
      routePath: p.routePath,
      pageFile: p.filePath,
      appFile: scan.app,
      dev,
    }),
  }));
}

/** The source files whose import graph a route's CSS is crawled from. */
function routeSourceFiles(scan: PagesScan, pageFile: string): string[] {
  return [pageFile, scan.app, scan.document].filter((f): f is string => !!f);
}

/** Run one code-split bundle pass over the scan's page entries (+ per-route CSS). */
async function bundle(
  scan: PagesScan,
  opts: ClientBundlerOptions,
  sig: string,
  cssOutDir: string,
): Promise<Built> {
  const empty: Built = {
    sig,
    files: new Map(),
    entryByRoute: new Map(),
    cssFiles: new Map(),
    cssByRoute: new Map(),
  };
  if (scan.pages.length === 0) return empty;

  // CSS assets for the whole project (null when there is no CSS at all). Its
  // importMap redirects `.css` → JS shim so the bundle doesn't parse CSS as JS.
  const appCss: AppCss | null = await buildAppCss({
    projectDir: opts.projectRoot,
    configPath: opts.configPath,
    outDir: cssOutDir,
    minify: !opts.dev,
    tailwind: opts.tailwind,
  });

  const out = await bundleRoutes(entriesFor(scan, opts.dev), {
    configPath: opts.configPath,
    minify: !opts.dev,
    dev: opts.dev,
    importMap: appCss?.importMap,
  });

  const cssFiles = new Map<string, string>();
  const cssByRoute = new Map<string, string>();
  if (appCss) {
    for (const page of scan.pages) {
      const text = await extractRouteCss(
        routeSourceFiles(scan, page.filePath),
        appCss,
      );
      if (text.trim().length === 0) continue;
      const name = `${routeId(page.routePath)}.css`;
      cssFiles.set(name, text);
      cssByRoute.set(page.routePath, name);
    }
  }

  return {
    sig,
    files: out.files,
    entryByRoute: out.entries,
    cssFiles,
    cssByRoute,
  };
}

/** Read pre-built bundles + manifest from `dir`; null if absent/unreadable. */
async function readFromDisk(dir: string): Promise<Built | null> {
  try {
    const manifest = JSON.parse(
      await Deno.readTextFile(join(dir, "manifest.json")),
    ) as DiskManifest;
    const files = new Map<string, string>();
    const cssFiles = new Map<string, string>();
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile) continue;
      if (e.name.endsWith(".js")) {
        files.set(e.name, await Deno.readTextFile(join(dir, e.name)));
      } else if (e.name.endsWith(".css")) {
        cssFiles.set(e.name, await Deno.readTextFile(join(dir, e.name)));
      }
    }
    return {
      sig: "disk",
      files,
      entryByRoute: new Map(Object.entries(manifest.entries)),
      cssFiles,
      cssByRoute: new Map(Object.entries(manifest.css ?? {})),
    };
  } catch {
    return null;
  }
}

const headers = (contentType: string, dev: boolean): HeadersInit => ({
  "content-type": contentType,
  "cache-control": dev ? "no-cache" : "public, max-age=31536000, immutable",
});

/**
 * Create the client bundler for a Pages Router instance. Its {@linkcode
 * ClientBundler.urlFor}/{@linkcode ClientBundler.cssUrlFor} feed the SSR `<script>`
 * and `<link>`; {@linkcode ClientBundler.serve} answers `/_denext/pages/*` requests
 * from the plugin's claim-hook; {@linkcode ClientBundler.prebuild} is the build step.
 */
export function createClientBundler(opts: ClientBundlerOptions): ClientBundler {
  // Dev / on-demand CSS shims land under the project's `.denext` output dir.
  const cssOutDir = join(opts.projectRoot, ".denext");
  let cache: Built | null = null;
  let inflight: { sig: string; promise: Promise<Built> } | null = null;

  async function ensure(): Promise<Built> {
    // Prod: the page set is fixed, so build (or read pre-built) exactly once and
    // reuse it — never re-bundle on later requests.
    if (opts.readDir) {
      if (cache) return cache;
      const disk = await readFromDisk(opts.readDir);
      if (disk) return (cache = disk);
      // No pre-built bundles on disk — fall through and bundle in-process once. This
      // needs the `deno` executable (it shells out to `deno bundle`), so a `deno
      // compile`d binary without one will error: run `denext build` before `start`.
    }
    const scan = await opts.getScan();
    const sig = await signature(scan, opts.dev);
    if (cache && cache.sig === sig) return cache;
    if (!inflight || inflight.sig !== sig) {
      inflight = { sig, promise: bundle(scan, opts, sig, cssOutDir) };
    }
    const built = await inflight.promise;
    cache = built;
    inflight = null;
    return built;
  }

  return {
    async urlFor(routePath: string): Promise<string | null> {
      const base = (await ensure()).entryByRoute.get(routePath);
      return base ? PAGES_PREFIX + base : null;
    },

    async cssUrlFor(routePath: string): Promise<string | null> {
      const base = (await ensure()).cssByRoute.get(routePath);
      return base ? PAGES_PREFIX + base : null;
    },

    async serve(pathname: string): Promise<Response | null> {
      if (!pathname.startsWith(PAGES_PREFIX)) return null;
      const name = pathname.slice(PAGES_PREFIX.length);
      const built = await ensure();
      if (pathname.endsWith(".js")) {
        const code = built.files.get(name);
        return code === undefined
          ? new Response("// not found", {
            status: 404,
            headers: headers("text/javascript; charset=utf-8", opts.dev),
          })
          : new Response(code, {
            headers: headers("text/javascript; charset=utf-8", opts.dev),
          });
      }
      if (pathname.endsWith(".css")) {
        const code = built.cssFiles.get(name);
        return code === undefined
          ? new Response("/* not found */", {
            status: 404,
            headers: headers("text/css; charset=utf-8", opts.dev),
          })
          : new Response(code, {
            headers: headers("text/css; charset=utf-8", opts.dev),
          });
      }
      return null;
    },

    async prebuild(
      outDir: string,
    ): Promise<
      { entryByRoute: Map<string, string>; cssByRoute: Map<string, string> }
    > {
      const scan = await opts.getScan();
      const built = await bundle(
        scan,
        opts,
        await signature(scan, opts.dev),
        outDir,
      );
      const dir = join(outDir, "pages-client");
      await Deno.mkdir(dir, { recursive: true });
      for (const [name, code] of built.files) {
        await Deno.writeTextFile(join(dir, name), code);
      }
      for (const [name, code] of built.cssFiles) {
        await Deno.writeTextFile(join(dir, name), code);
      }
      const entries: Record<string, string> = {};
      for (const [routePath, base] of built.entryByRoute) {
        entries[routePath] = base;
      }
      const css: Record<string, string> = {};
      for (const [routePath, base] of built.cssByRoute) css[routePath] = base;
      const manifest: DiskManifest = { entries, css };
      await Deno.writeTextFile(
        join(dir, "manifest.json"),
        JSON.stringify(manifest),
      );
      return { entryByRoute: built.entryByRoute, cssByRoute: built.cssByRoute };
    },
  };
}
