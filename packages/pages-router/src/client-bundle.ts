// The Pages Router client bundler: turn the scanned page tree into browser
// hydration bundles and serve them under `/_denext/pages/`.
//
// denext bundles with `deno bundle` (the Deno CLI's own bundler — no npm), via
// the public `@denext/denext/bundle` primitive. Every route's generated entry
// imports the same shared runtime and `_app`, so a single code-split pass hoists
// those into one shared chunk downloaded once and reused across soft navigations.
//
// Two serving modes:
//   • dev   — bundle lazily in-process, cache in memory, re-bundle when the set
//             of page files changes (new/removed routes picked up without restart);
//   • prod  — read the bundles a `denext build` step pre-wrote to disk; if none
//             are present (e.g. running from source without a build), fall back to
//             an in-process bundle so the app still works.

import { join } from "@std/path";
import { bundleRoutes } from "@denext/denext/bundle";
import { generateClientEntry } from "./client-entry.ts";
import type { PagesScan } from "./scan.ts";

/** URL prefix every Pages Router client bundle is served under. */
export const PAGES_PREFIX = "/_denext/pages/";

/** The manifest a build step writes alongside the bundles for prod to read. */
interface DiskManifest {
  /** routePath → emitted entry basename. */
  entries: Record<string, string>;
}

/** A completed bundle pass: emitted files + the per-route entry basenames. */
interface Built {
  /** Signature of the scan this was built from (`"disk"` when read pre-built). */
  sig: string;
  /** Every emitted JS file (entries + shared chunks) keyed by basename. */
  files: Map<string, string>;
  /** routePath → its entry basename in {@linkcode files}. */
  entryByRoute: Map<string, string>;
}

/** Options for {@linkcode createClientBundler}. */
export interface ClientBundlerOptions {
  /** Resolve the current scanned page tree (re-scanned per call in dev). */
  getScan: () => PagesScan | Promise<PagesScan>;
  /** deno config path used for import resolution when bundling. */
  configPath: string;
  /** Dev mode: emit sourcemaps, skip minify, re-bundle on route-set changes. */
  dev: boolean;
  /** Prod: directory holding pre-built bundles (from the build step), if any. */
  readDir?: string;
}

/** The bundler handed to the request handler and (optionally) the build step. */
export interface ClientBundler {
  /** The client bundle URL for a route (`/_denext/pages/<id>.js`), or null. */
  urlFor(routePath: string): Promise<string | null>;
  /** Serve a `/_denext/pages/*.js` request, or null if it isn't one of ours. */
  serve(pathname: string): Promise<Response | null>;
  /** Pre-bundle every route into `outDir/pages-client/` (a build step). */
  prebuild(outDir: string): Promise<void>;
}

/** A stable signature of the page set — changes when routes are added/removed. */
function signature(scan: PagesScan): string {
  const pages = scan.pages.map((p) => `${p.routePath}\0${p.filePath}`).sort();
  return `${scan.app ?? ""}::${pages.join("|")}`;
}

/** Generate the entry sources for a scan (one per page route). */
function entriesFor(scan: PagesScan): Array<{ key: string; source: string }> {
  return scan.pages.map((p) => ({
    key: p.routePath,
    source: generateClientEntry({
      routePath: p.routePath,
      pageFile: p.filePath,
      appFile: scan.app,
    }),
  }));
}

/** Run one code-split bundle pass over the scan's page entries. */
async function bundle(
  scan: PagesScan,
  configPath: string,
  dev: boolean,
  sig: string,
): Promise<Built> {
  const entries = entriesFor(scan);
  if (entries.length === 0) return { sig, files: new Map(), entryByRoute: new Map() };
  const out = await bundleRoutes(entries, { configPath, minify: !dev, dev });
  return { sig, files: out.files, entryByRoute: out.entries };
}

/** Read pre-built bundles + manifest from `dir`; null if absent/unreadable. */
async function readFromDisk(dir: string): Promise<Built | null> {
  try {
    const manifest = JSON.parse(
      await Deno.readTextFile(join(dir, "manifest.json")),
    ) as DiskManifest;
    const files = new Map<string, string>();
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && e.name.endsWith(".js")) {
        files.set(e.name, await Deno.readTextFile(join(dir, e.name)));
      }
    }
    return { sig: "disk", files, entryByRoute: new Map(Object.entries(manifest.entries)) };
  } catch {
    return null;
  }
}

const JS_HEADERS = (dev: boolean): HeadersInit => ({
  "content-type": "text/javascript; charset=utf-8",
  "cache-control": dev ? "no-cache" : "public, max-age=31536000, immutable",
});

/**
 * Create the client bundler for a Pages Router instance. Its {@linkcode
 * ClientBundler.urlFor} feeds the SSR `<script>` tag; {@linkcode
 * ClientBundler.serve} answers `/_denext/pages/*.js` requests from the plugin's
 * claim-hook; {@linkcode ClientBundler.prebuild} is the build step.
 */
export function createClientBundler(opts: ClientBundlerOptions): ClientBundler {
  let cache: Built | null = null;
  let inflight: { sig: string; promise: Promise<Built> } | null = null;

  async function ensure(): Promise<Built> {
    // Prod: the page set is fixed, so build (or read pre-built) exactly once and
    // reuse it — never re-bundle on later requests.
    if (opts.readDir) {
      if (cache) return cache;
      const disk = await readFromDisk(opts.readDir);
      if (disk) return (cache = disk);
      // No pre-built bundles on disk — fall through and bundle in-process once.
    }
    const scan = await opts.getScan();
    const sig = signature(scan);
    if (cache && cache.sig === sig) return cache;
    if (!inflight || inflight.sig !== sig) {
      inflight = { sig, promise: bundle(scan, opts.configPath, opts.dev, sig) };
    }
    const built = await inflight.promise;
    cache = built;
    inflight = null;
    return built;
  }

  return {
    async urlFor(routePath: string): Promise<string | null> {
      const built = await ensure();
      const base = built.entryByRoute.get(routePath);
      return base ? PAGES_PREFIX + base : null;
    },

    async serve(pathname: string): Promise<Response | null> {
      if (!pathname.startsWith(PAGES_PREFIX) || !pathname.endsWith(".js")) return null;
      const built = await ensure();
      const code = built.files.get(pathname.slice(PAGES_PREFIX.length));
      if (code === undefined) {
        return new Response("// not found", { status: 404, headers: JS_HEADERS(opts.dev) });
      }
      return new Response(code, { headers: JS_HEADERS(opts.dev) });
    },

    async prebuild(outDir: string): Promise<void> {
      const scan = await opts.getScan();
      const built = await bundle(scan, opts.configPath, false, signature(scan));
      const dir = join(outDir, "pages-client");
      await Deno.mkdir(dir, { recursive: true });
      for (const [name, code] of built.files) await Deno.writeTextFile(join(dir, name), code);
      const entries: Record<string, string> = {};
      for (const [routePath, base] of built.entryByRoute) entries[routePath] = base;
      await Deno.writeTextFile(
        join(dir, "manifest.json"),
        JSON.stringify({ entries } as DiskManifest),
      );
    },
  };
}
