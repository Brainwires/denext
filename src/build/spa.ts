// SPA mode ("React but not Next"): build/dev/export/serve a single client entry
// as a pure client-side-rendered app — no `app/` directory, no SSR, no Flight.
//
// denext bundles the configured `spa.entry` module (which mounts the app itself,
// e.g. a Vite-style `main.tsx` calling `createRoot(...).render(...)`), wraps it in
// a generated HTML shell, and serves that shell for every navigation (history-API
// fallback). This lets an existing client-only React SPA run on denext's toolchain
// (`deno bundle`, Tailwind, the CSS pipeline) and packaging (`deno desktop`),
// without restructuring it into the App Router. The whole path reuses the existing
// bundle/CSS primitives — it only differs in that it has one hand-written entry and
// no route manifest.

import { copy, ensureDir } from "@std/fs";
import { join, resolve, toFileUrl } from "@std/path";
import { bundleSourceFiles, writeBundleOutput } from "./bundle.ts";
import { type AppCss, buildAppCss, extractRouteCss } from "./css.ts";
import { tailwindPaths } from "./tailwind.ts";
import { type ProjectPaths, resolveProject } from "./paths.ts";
import { detectNextCompat } from "./next-compat-detect.ts";
import { buildNextCompatClientEntries } from "./next-compat-build.ts";
import { stopNextCompat } from "./next-compat.ts";
import type { SpaConfig } from "../server/config.ts";
import { computeCsp } from "../server/csp.ts";
import { serveStatic } from "../server/static.ts";
import { applyDefaultSecurityHeaders } from "../server/app.ts";
import { displayHost, serveWithPortFallback } from "../server/serve-utils.ts";

/** The client-asset URL prefix (matches the App Router prod server). */
const CLIENT_PREFIX = "/_denext/client/";
/** Live-reload SSE endpoint (dev). */
const RELOAD_PATH = "/_denext/reload";
/** The external dev-reload module URL (kept out of the CSP inline-script path). */
const DEV_RELOAD_JS_PATH = "/_denext/dev-reload.js";
/** The SPA entry bundle basename. */
const ENTRY_FILE = "index.js";
/** The SPA extracted-stylesheet basename. */
const STYLE_FILE = "index.css";
/** The generated shell basename. */
const SHELL_FILE = "index.html";

/**
 * A minimal dev live-reload client for SPA mode. Unlike the App Router's Fast
 * Refresh (which re-imports a route entry to preserve state), a foreign SPA's
 * mount is not re-entrant, so every change triggers a full reload — correct and
 * simple. Served as an external same-origin module so the strict CSP allows it.
 */
const SPA_DEV_RELOAD = `(function(){try{` +
  `var es=new EventSource(${JSON.stringify(RELOAD_PATH)});` +
  `es.onmessage=function(e){if(e.data==="reload"||e.data==="refresh")location.reload();};` +
  `}catch(_){}})();`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The bundle entry source: import the user's entry module for its side effects
 * (it mounts the app itself). Kept as a generated wrapper — rather than bundling
 * the entry file directly — so the same seam can later inject dev/refresh hooks.
 */
export function generateSpaEntry(entryUrl: string): string {
  return `// denext generated SPA entry — do not edit.\nimport ${JSON.stringify(entryUrl)};\n`;
}

/**
 * Package names whose version in the project's `package.json` is a pnpm
 * `catalog:` / `workspace:*` reference. The esbuild deno-loader's resolver can't
 * parse those version strings (the real version lives in `pnpm-workspace.yaml`),
 * so denext front-runs the loader and resolves these packages straight from
 * `node_modules`. Empty for a non-pnpm-catalog app.
 */
async function pnpmCatalogPackages(projectDir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    const pkg = JSON.parse(await Deno.readTextFile(join(projectDir, "package.json"))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (
      const group of [
        pkg.dependencies,
        pkg.devDependencies,
        pkg.peerDependencies,
        pkg.optionalDependencies,
      ]
    ) {
      for (const [name, v] of Object.entries(group ?? {})) {
        if (typeof v === "string" && (v.startsWith("catalog:") || v.startsWith("workspace:"))) {
          names.push(name);
        }
      }
    }
  } catch {
    // no/invalid package.json → not a pnpm-catalog app
  }
  return names;
}

/**
 * The esbuild `define` map for a SPA's compile-time `import.meta.env` values
 * (`spa.env`) — the Vite-`define` analogue. Only meaningful on the next-compat
 * (esbuild) path; `undefined` when the app declares no env.
 */
function spaDefines(spa: SpaConfig, dev: boolean): Record<string, string> {
  // Vite's built-in `import.meta.env` values, with correct types (DEV/PROD/SSR are
  // booleans, not strings) so `if (import.meta.env.DEV)` etc. behave as in Vite.
  const out: Record<string, string> = {
    "import.meta.env.MODE": JSON.stringify(dev ? "development" : "production"),
    "import.meta.env.DEV": String(dev),
    "import.meta.env.PROD": String(!dev),
    "import.meta.env.SSR": "false",
    "import.meta.env.BASE_URL": JSON.stringify("/"),
  };
  // App-provided values (`spa.env`) — strings — override / extend the built-ins.
  for (const [key, value] of Object.entries(spa.env ?? {})) {
    out[`import.meta.env.${key}`] = JSON.stringify(value);
  }
  return out;
}

/** Generate the HTML shell that boots the SPA bundle. */
let warnedSpaHead = false;
/**
 * Dev-only, once-per-process warning that `spa.head` is injected into `<head>` as raw
 * HTML (mirrors `metadata.head`'s warning) — a reminder to sanitize any untrusted
 * input the app splices into it, since the SPA shell is the config most likely to be
 * fed dynamic values.
 */
function warnRawSpaHeadOnce(): void {
  if (warnedSpaHead) return;
  if ((globalThis as { __denextDev?: boolean }).__denextDev !== true) return;
  warnedSpaHead = true;
  console.warn(
    "denext: spa.head is injected into <head> as raw HTML — sanitize any untrusted " +
      "input to avoid injection. (dev-only warning)",
  );
}

export async function spaShellHtml(opts: {
  spa: SpaConfig;
  /** URL of the client entry bundle (e.g. `/_denext/client/index.js`). */
  scriptSrc: string;
  /** URL of the extracted stylesheet, when the app has CSS. */
  styleHref?: string;
  /** URL of the dev-reload module (dev only). */
  devScriptSrc?: string;
}): Promise<string> {
  const { spa } = opts;
  const lang = spa.lang ?? "en";
  const title = spa.title ?? "denext app";
  const rootId = spa.rootId ?? "root";
  const style = opts.styleHref
    ? `\n    <link rel="stylesheet" href="${escapeHtml(opts.styleHref)}" />`
    : "";
  if (spa.head) warnRawSpaHeadOnce();
  const head = spa.head ? `\n    ${spa.head}` : "";
  const devScript = opts.devScriptSrc
    ? `\n    <script src="${escapeHtml(opts.devScriptSrc)}"></script>`
    : "";
  // Opt-in CSP for the shell (client-only React ships none by default; this is parity
  // with Vite/CRA, not a limitation). Emitted as a <meta> so it applies for `export`
  // (any static host), `start`, and `dev`. `frame-ancestors` is header-only — ignored
  // in <meta> — so it is dropped here; the always-on `X-Frame-Options: SAMEORIGIN`
  // (applyDefaultSecurityHeaders) covers clickjacking. The shell ships no inline
  // script, so `script-src 'self'` needs no hashes; inline <style> in `spa.head` is
  // hashed by computeCsp so it stays allowed.
  let cspMeta = "";
  if (spa.csp && spa.csp !== "off") {
    const route = spa.csp === "strict" ? undefined : spa.csp;
    const policy = (await computeCsp(head, route))
      .split("; ")
      .filter((d) => !/^frame-ancestors\b/.test(d))
      .join("; ");
    cspMeta = `\n    <meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}" />`;
  }
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
  <head>
    <meta charset="utf-8" />${cspMeta}
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>${style}${head}
  </head>
  <body>
    <div id="${escapeHtml(rootId)}"></div>
    <script type="module" src="${escapeHtml(opts.scriptSrc)}"></script>${devScript}
  </body>
</html>
`;
}

/** Resolve the SPA config + absolute entry path, throwing a clear error if absent. */
function spaEntryPath(paths: ProjectPaths): { spa: SpaConfig; entryPath: string } {
  const spa = paths.config?.spa;
  if (!spa) {
    throw new Error(
      'denext: mode "spa" requires a `spa` config (e.g. `spa: { entry: "./src/main.tsx" }`)',
    );
  }
  return { spa, entryPath: resolve(paths.projectDir, spa.entry) };
}

/** Assert the entry module exists on disk (a clear error beats a cryptic bundle failure). */
async function assertEntryExists(entryPath: string): Promise<void> {
  try {
    const info = await Deno.stat(entryPath);
    if (!info.isFile) throw new Error();
  } catch {
    throw new Error(`denext: SPA entry not found at ${entryPath} (check \`spa.entry\`).`);
  }
}

/**
 * Bundle the SPA entry and extract its stylesheet. Shared by build + export.
 * Writes the entry bundle (+ split chunks) into `clientDir` as `index.js`, and —
 * when the app has CSS reachable from the entry graph — `index.css`.
 *
 * @returns Whether a stylesheet was emitted (so the caller can `<link>` it).
 */
async function bundleSpaInto(
  paths: ProjectPaths,
  entryPath: string,
  clientDir: string,
  minify: boolean,
  dev = false,
): Promise<{ hasStyles: boolean }> {
  const spa = paths.config!.spa!;
  const css = await buildAppCss({
    projectDir: paths.projectDir,
    configPath: paths.configPath,
    outDir: paths.outDir,
    minify,
    tailwind: tailwindPaths(paths.projectDir, paths.config?.tailwind),
  });
  const entrySource = generateSpaEntry(toFileUrl(entryPath).href);
  const compat = await detectNextCompat(paths);
  // `spa.env` and Vite-style asset imports (`?url`/`?worker`) only apply on the
  // compat (esbuild) path; a denext-native SPA bundles with plain `deno bundle`.
  // Warn rather than silently ignore, so the footgun surfaces.
  if (!compat && spa.env && Object.keys(spa.env).length > 0) {
    console.warn(
      "  denext: `spa.env` is ignored — it applies only when the app uses npm React " +
        "(node_modules/react, or set `compatibilityMode: true`).",
    );
  }

  // next-compat path: when the app uses npm React (node_modules/react present, or
  // `compatibilityMode` forced), bundle through the esbuild react→denext rewrite so the
  // npm libraries' own `import "react"` also resolve to denext's single React —
  // the "two Reacts" fix a plain `deno bundle` can't do. This is also where the
  // `import.meta.env` (`spa.env`) define applies. Emits `index.js` + shared chunks.
  if (compat) {
    await buildNextCompatClientEntries({
      projectDir: paths.projectDir,
      configPath: paths.configPath,
      outDir: paths.outDir,
      clientDir,
      entries: [{ id: "index", source: entrySource }],
      minify,
      classComponents: paths.config?.classComponents ?? true,
      define: spaDefines(spa, dev),
      // Vite-style asset imports (?url/?worker/.wasm/…) → files under clientDir,
      // URLs prefixed with the path the SPA servers already serve them at.
      assets: { publicPath: CLIENT_PREFIX },
      // pnpm catalog:/workspace: deps the esbuild deno-loader can't resolve —
      // denext resolves these straight from node_modules (front-runs the loader).
      catalogPackages: await pnpmCatalogPackages(paths.projectDir),
    });
    // Tear the esbuild service down only for a one-shot build/export. In dev this
    // runs on every rebuild, so stopping it would force a cold re-init each keystroke
    // (and could kill the process-shared service mid-flight); the dev server stops it
    // once on shutdown instead.
    if (!dev) await stopNextCompat();
  } else {
    // denext-native path: plain `deno bundle` (fast, no esbuild). The app already
    // imports denext directly, so there is no react alias to rewrite.
    const bundle = await bundleSourceFiles(entrySource, {
      configPath: paths.configPath,
      minify,
      importMap: css?.importMap,
      dev,
    });
    await writeBundleOutput(clientDir, bundle, ENTRY_FILE);
  }

  let hasStyles = false;
  if (css) {
    const text = await extractRouteCss([entryPath], css as AppCss);
    if (text.trim().length > 0) {
      await Deno.writeTextFile(join(clientDir, STYLE_FILE), text);
      hasStyles = true;
    }
  }
  return { hasStyles };
}

/**
 * Production build for SPA mode: bundle the entry into `.denext/client/` and write
 * the HTML shell. Mirrors the App Router build's staging + atomic-swap so a failed
 * build never destroys the previous working output.
 */
export async function buildSpa(paths: ProjectPaths): Promise<{ outDir: string }> {
  const { spa, entryPath } = spaEntryPath(paths);
  await assertEntryExists(entryPath);

  const finalClientDir = join(paths.outDir, "client");
  const staging = join(paths.outDir, ".client.staging");
  await Deno.remove(staging, { recursive: true }).catch(() => {});
  await ensureDir(staging);

  try {
    console.log(`  SPA mode: bundling ${spa.entry} -> client/${ENTRY_FILE}`);
    const { hasStyles } = await bundleSpaInto(paths, entryPath, staging, true);

    const html = await spaShellHtml({
      spa,
      scriptSrc: `${CLIENT_PREFIX}${ENTRY_FILE}`,
      styleHref: hasStyles ? `${CLIENT_PREFIX}${STYLE_FILE}` : undefined,
    });
    await Deno.writeTextFile(join(staging, SHELL_FILE), html);

    await Deno.remove(finalClientDir, { recursive: true }).catch(() => {});
    await Deno.rename(staging, finalClientDir);
  } catch (err) {
    // A failed build must not leave a half-written staging dir behind (the atomic
    // swap above never ran, so the previous working output is still intact).
    await Deno.remove(staging, { recursive: true }).catch(() => {});
    throw err;
  }
  console.log(`\n  Built SPA into ${paths.outDir}`);
  return { outDir: paths.outDir };
}

/** Static export for SPA mode: `out/index.html` + `out/_denext/client/*` + public/. */
export async function exportSpa(
  paths: ProjectPaths,
  options: { outDir?: string } = {},
): Promise<{ outDir: string; pages: number; skipped: string[] }> {
  const { spa, entryPath } = spaEntryPath(paths);
  await assertEntryExists(entryPath);

  const outDir = join(paths.projectDir, options.outDir ?? "out");
  const clientOut = join(outDir, "_denext", "client");
  await ensureDir(clientOut);

  console.log(`  SPA mode: bundling ${spa.entry} -> _denext/client/${ENTRY_FILE}`);
  const { hasStyles } = await bundleSpaInto(paths, entryPath, clientOut, true);

  const html = await spaShellHtml({
    spa,
    scriptSrc: `${CLIENT_PREFIX}${ENTRY_FILE}`,
    styleHref: hasStyles ? `${CLIENT_PREFIX}${STYLE_FILE}` : undefined,
  });
  await Deno.writeTextFile(join(outDir, SHELL_FILE), html);

  await copyPublic(paths.publicDir, outDir);
  return { outDir, pages: 1, skipped: [] };
}

/** Copy the public directory's contents into the output directory. */
async function copyPublic(publicDir: string, outDir: string): Promise<void> {
  try {
    await Deno.stat(publicDir);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return; // no public/ directory — nothing to copy
    throw err;
  }
  // A real per-file copy failure must NOT be swallowed — otherwise `export` would
  // silently ship missing public assets. Only the "no public/ dir" case is benign.
  for await (const entry of Deno.readDir(publicDir)) {
    await copy(join(publicDir, entry.name), join(outDir, entry.name), { overwrite: true });
  }
}

/** True for a request that should receive the SPA shell (a navigation), not a 404. */
function wantsShell(request: Request, pathname: string): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("text/html")) return true;
  // Extensionless paths are navigations (client-router routes); a path with a file
  // extension that wasn't served as an asset above is a genuine 404.
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !last.includes(".");
}

export interface SpaProdServerOptions {
  projectDir: string;
  port?: number;
  hostname?: string;
  signal?: AbortSignal;
  onListen?: (info: { hostname: string; port: number }) => void;
  strictPort?: boolean;
}

/**
 * Serve a built SPA (`denext build` output): client assets under `/_denext/client/`,
 * `public/` assets, and the HTML shell for every navigation (history-API fallback).
 */
export async function startSpaProdServer(
  options: SpaProdServerOptions,
): Promise<Deno.HttpServer> {
  const paths = await resolveProject(options.projectDir);
  const clientDir = join(paths.outDir, "client");
  const shellPath = join(clientDir, SHELL_FILE);
  let shell: string;
  try {
    shell = await Deno.readTextFile(shellPath);
  } catch {
    throw new Error(`No SPA build at ${shellPath}. Run \`denext build\` first.`);
  }
  const hstsCfg = paths.config?.hsts;
  // Optional backend reverse proxy (spa.proxy). Imported lazily so proxy-less SPAs
  // never pull in the proxy module (and its `npm:ws` dependency) at all.
  const proxyCfg = paths.config?.spa?.proxy;
  const proxy = proxyCfg ? await import("./dev-proxy.ts") : undefined;

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const secure = url.protocol === "https:";
    const accEnc = request.headers.get("accept-encoding") ?? undefined;

    // Proxied prefixes go to the backend before any local serving (an /api or /ws
    // request must reach the backend even if a same-named asset happens to exist).
    if (proxyCfg && proxy && proxy.matchesProxyPrefix(url.pathname, proxyCfg.prefixes)) {
      return await proxy.proxyToBackend(request, url, proxyCfg);
    }

    if (url.pathname.startsWith(CLIENT_PREFIX)) {
      const asset = await serveStatic(
        clientDir,
        "/" + url.pathname.slice(CLIENT_PREFIX.length),
        accEnc,
      );
      if (asset) {
        asset.headers.set("cache-control", "public, max-age=31536000, immutable");
        return applyDefaultSecurityHeaders(asset, secure, hstsCfg);
      }
      return applyDefaultSecurityHeaders(
        new Response("not found", { status: 404 }),
        secure,
        hstsCfg,
      );
    }

    const pub = await serveStatic(paths.publicDir, url.pathname, accEnc);
    if (pub) return applyDefaultSecurityHeaders(pub, secure, hstsCfg);

    if (wantsShell(request, url.pathname)) {
      return applyDefaultSecurityHeaders(
        new Response(request.method === "HEAD" ? null : shell, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
        }),
        secure,
        hstsCfg,
      );
    }
    return applyDefaultSecurityHeaders(new Response("not found", { status: 404 }), secure, hstsCfg);
  };

  return serveWithPortFallback(
    {
      port: options.port ?? 3000,
      hostname: options.hostname ?? "0.0.0.0",
      signal: options.signal,
      strict: options.strictPort,
      onListen: options.onListen ??
        (({ hostname, port }) =>
          console.log(`denext start ▸ http://${displayHost(hostname)}:${port}`)),
    },
    handler,
  );
}

export interface SpaDevServerOptions {
  paths: ProjectPaths;
  port?: number;
  hostname?: string;
  signal?: AbortSignal;
  onListen?: (info: { hostname: string; port: number }) => void;
  strictPort?: boolean;
}

/**
 * Dev server for SPA mode: bundle the entry on demand (rebundled on file change),
 * serve the HTML shell for every navigation, and live-reload over SSE. No SSR, no
 * route manifest — just one bundle + a shell + a file watcher.
 */
export function startSpaDevServer(options: SpaDevServerOptions): Deno.HttpServer {
  const { paths } = options;
  const { spa, entryPath } = spaEntryPath(paths);
  (globalThis as { __denextDev?: boolean }).__denextDev = true;

  let generation = 0;
  // The client assets for the current generation live in a per-generation dir and
  // are served via serveStatic — so the compat (esbuild, multi-file) and plain
  // (deno bundle) paths are served identically.
  let devDir: string | null = null;
  let hasStyles = false;
  let building: Promise<string> | null = null;

  // Returns the current generation's build dir. Callers MUST capture the return value
  // and pass it to `serveStatic` rather than reading `devDir` again after the await —
  // a concurrent watch event can null `devDir` (and bump the generation) between the
  // await resolving and the read, which would otherwise deref null.
  function ensureBuilt(): Promise<string> {
    if (devDir) return Promise.resolve(devDir);
    if (building) return building;
    const gen = generation;
    building = (async () => {
      const root = join(paths.outDir, "spa-dev");
      const dir = join(root, String(gen));
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      await ensureDir(dir);
      const res = await bundleSpaInto(paths, entryPath, dir, false, true);
      hasStyles = res.hasStyles;
      devDir = dir;
      // Prune prior generations — a long dev session (many edits) would otherwise
      // accumulate a full bundle copy per change. Builds are serialized and only the
      // current generation is served, so removing the others is safe.
      try {
        for await (const e of Deno.readDir(root)) {
          if (e.isDirectory && e.name !== String(gen)) {
            await Deno.remove(join(root, e.name), { recursive: true }).catch(() => {});
          }
        }
      } catch { /* root vanished — nothing to prune */ }
      return dir;
    })().finally(() => {
      building = null;
    });
    return building;
  }

  // Live-reload subscribers.
  const reloadClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  function broadcast(kind: "reload"): void {
    for (const controller of reloadClients) {
      try {
        controller.enqueue(encoder.encode(`data: ${kind}\n\n`));
      } catch {
        reloadClients.delete(controller);
      }
    }
  }

  // Watch the entry's source tree + public/, invalidating the cached bundle.
  watch();
  function watch(): void {
    const entryDir = resolve(entryPath, "..");
    const candidates = [entryDir, paths.publicDir];
    const watched = candidates.filter((p) => {
      try {
        Deno.statSync(p);
        return true;
      } catch {
        return false;
      }
    });
    if (watched.length === 0) return;
    const watcher = Deno.watchFs(watched, { recursive: true });
    options.signal?.addEventListener("abort", () => {
      try {
        watcher.close();
      } catch { /* already closed */ }
      for (const c of reloadClients) {
        try {
          c.close();
        } catch { /* already closed */ }
      }
      reloadClients.clear();
      // Dev rebuilds keep the esbuild service warm (see bundleSpaInto); stop it once
      // here on shutdown. A no-op if the plain `deno bundle` path was used.
      void stopNextCompat();
    });
    // Events under the build's own output (`.denext/…`), node_modules, or .git are
    // not source edits — ignoring them stops a self-triggered rebuild→reload→rebuild
    // loop when `spa.entry` sits at the project root (so `entryDir` contains outDir).
    const ignored = (p: string): boolean =>
      p.startsWith(paths.outDir) || p.includes("/node_modules/") || p.includes("/.git/");
    let debounce: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      try {
        for await (const event of watcher) {
          if (event.paths.length > 0 && event.paths.every(ignored)) continue;
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => {
            generation++;
            devDir = null;
            broadcast("reload");
          }, 60);
        }
      } catch { /* watcher closed on shutdown */ }
    })();
  }

  const jsHeaders = {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "no-store",
  };

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === RELOAD_PATH) {
      let ref: ReadableStreamDefaultController<Uint8Array> | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          ref = controller;
          reloadClients.add(controller);
          controller.enqueue(encoder.encode("retry: 1000\n\n"));
        },
        cancel(): void {
          if (ref) reloadClients.delete(ref);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    if (url.pathname === DEV_RELOAD_JS_PATH) {
      return new Response(SPA_DEV_RELOAD, { headers: jsHeaders });
    }

    // Client assets: the entry bundle, its split chunks, and the stylesheet —
    // served from the current generation's build dir.
    if (url.pathname.startsWith(CLIENT_PREFIX)) {
      let dir: string;
      try {
        dir = await ensureBuilt();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("denext: SPA bundle error", err);
        return new Response(
          `console.error(${JSON.stringify("denext SPA bundle error:\n" + msg)});`,
          {
            status: 500,
            headers: jsHeaders,
          },
        );
      }
      const asset = await serveStatic(dir, "/" + url.pathname.slice(CLIENT_PREFIX.length));
      if (asset) {
        asset.headers.set("cache-control", "no-store");
        return asset;
      }
      return new Response("// not found", { status: 404, headers: jsHeaders });
    }

    // public/ assets.
    const pub = await serveStatic(
      paths.publicDir,
      url.pathname,
      request.headers.get("accept-encoding") ?? undefined,
    );
    if (pub) return pub;

    // Navigation → the shell (history-API fallback).
    if (wantsShell(request, url.pathname)) {
      try {
        await ensureBuilt();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(`<pre>denext SPA build error:\n\n${escapeHtml(msg)}</pre>`, {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      const html = await spaShellHtml({
        spa,
        scriptSrc: `${CLIENT_PREFIX}${ENTRY_FILE}`,
        styleHref: hasStyles ? `${CLIENT_PREFIX}${STYLE_FILE}` : undefined,
        devScriptSrc: DEV_RELOAD_JS_PATH,
      });
      return new Response(request.method === "HEAD" ? null : html, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return new Response("not found", { status: 404 });
  }

  return serveWithPortFallback(
    {
      port: options.port ?? 3000,
      hostname: options.hostname ?? "localhost",
      signal: options.signal,
      strict: options.strictPort,
      onListen: options.onListen ??
        (({ hostname, port }) =>
          console.log(
            `\n  denext dev (SPA)  ▸  http://${displayHost(hostname)}:${port}\n` +
              `  entry ${spa.entry}\n`,
          )),
    },
    handler,
  );
}
