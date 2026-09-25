// denext desktop runtime: serve a denext SPA export (`out/`) inside a native
// `deno desktop` window, optionally reverse-proxying a backend (`spa.proxy`). The
// app-level `desktop.ts` that `migrate --desktop` / `create --desktop` generates is
// a thin call to {@link runDesktop} — the serve + proxy + window plumbing lives here
// so a fix reaches every app.
//
// Serving reuses denext's {@link serveStatic} (content-types, gzip negotiation,
// path-traversal protection) over the export dir, with an SPA history fallback to
// `index.html` and `no-store` caching so a repackaged app never serves a stale
// bundle from the WebView cache. The proxy is the same mechanism as `denext start`
// in `mode:"spa"` (see {@link matchesProxyPrefix}/{@link proxyToBackend}).

import { fromFileUrl, join } from "@std/path";
import type { SpaProxyConfig } from "../server/config.ts";
import { serveStatic } from "../server/static.ts";
import { wantsShell } from "./spa/shared.ts";
import { handleDesktopAuthSession, timingSafeEqual } from "../desktop/auth-session-runtime.ts";
import { sha256Base64 } from "../server/csp.ts";
import type { DesktopUpdaterConfig } from "../desktop/updater.ts";

type ProxyModule = typeof import("./dev-proxy.ts");

/** The token-gated loopback OAuth endpoint the desktop client half POSTs to. */
const AUTH_SESSION_PATH = "/_denext/desktop/auth-session";
/** The token-gated boot-confirm endpoint the injected beacon POSTs to (updater watchdog). */
const BOOTED_PATH = "/_denext/desktop/booted";

export interface RunDesktopOptions {
  /**
   * Absolute path (or a path relative to {@link importMetaUrl}) of the static export
   * to serve. Default: `out/` resolved relative to `importMetaUrl`, else `<cwd>/out`.
   */
  outDir?: string;
  /**
   * Pass `import.meta.url` from the app's `desktop.ts` so `out/` resolves relative to
   * the entry module — which is how it works both under `deno desktop desktop.ts` and
   * from inside the packaged `.app` (where the CWD is not the project).
   */
  importMetaUrl?: string;
  /** Local server port. Default: env `PORT`, else `8000`. */
  port?: number;
  /**
   * Backend reverse-proxy config. Generated `desktop.ts` passes
   * `config.spa?.proxy` from the app's `denext.config.ts` (compiled into the entry,
   * since the packaged app has no config file at runtime). Omit for no proxy.
   */
  proxy?: SpaProxyConfig;
  /**
   * Escape hatch: intercept a request before the default proxy/serve. Return a
   * `Response` to handle it; return `null`/`undefined` to fall through.
   */
  onRequest?: (
    req: Request,
    url: URL,
  ) => Response | null | undefined | Promise<Response | null | undefined>;
  /**
   * Enable the SIGNED UI self-updater. When present, the served directory is resolved through
   * {@link resolveDesktopUiDir} — the verified overlay in the app-support dir if one is active
   * and healthy, else the bundled export — and {@link desktopBooted} confirms the launch after
   * the server is up (the boot watchdog rolls back a UI that fails to boot). Omit it to keep the
   * existing behavior (serve the bundled export only).
   */
  updater?: DesktopUpdaterConfig;
}

// The SPA entry is stably named (`/_denext/client/index.js`), so the WebView would
// otherwise serve a cached copy after a repackage — force revalidation every load.
function noStore(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("cache-control", "no-store, must-revalidate");
  headers.delete("etag");
  headers.delete("last-modified");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * denext's CSP is HASH-based (never nonce-based) and, on the SPA/desktop shell, travels as a
 * `<meta http-equiv="Content-Security-Policy">` inside the document (see `cspMetaTag` in
 * `spa/shared.ts`). If the served shell carries such a meta with a `script-src` directive, add
 * `hash` to it so the injected desktop `<script>` is allowed — an unpatched strict CSP would
 * silently block the script and break desktop detection (and the whole auth flow). When the
 * shell carries no CSP meta (the SPA default), there is nothing to patch.
 */
function addScriptHashToCspMeta(html: string, hash: string): string {
  const metaRe = /<meta\b[^>]*http-equiv=["']content-security-policy["'][^>]*>/i;
  const tag = html.match(metaRe)?.[0];
  if (!tag) return html;
  const contentRe = /content=(["'])([\s\S]*?)\1/i;
  const cm = tag.match(contentRe);
  if (!cm) return html;
  const policy = cm[2];
  // No explicit script-src ⇒ default-src governs scripts; leave the policy untouched.
  if (!/script-src\b/i.test(policy) || policy.includes(hash)) return html;
  const newPolicy = policy.replace(/(script-src\b[^;]*)/i, (d) => `${d} ${hash}`);
  const newTag = tag.replace(contentRe, (_full, q: string) => `content=${q}${newPolicy}${q}`);
  return html.replace(tag, newTag);
}

/**
 * The boot-confirm beacon appended to the injected script when the updater is on: once the page
 * has actually loaded (proof the UI rendered, not just that the server started), it POSTs the
 * per-launch token to `/_denext/desktop/booted`, which confirms the pending overlay so the boot
 * watchdog does not roll a healthy update back. Token-gated so a cross-origin drive-by cannot
 * confirm a broken update. Failures are swallowed (a missed beacon just leaves the trial pending,
 * i.e. it rolls back — fail-safe).
 */
const BOOT_BEACON_JS = ';(function(){function b(){try{fetch("/_denext/desktop/booted",' +
  '{method:"POST",headers:{"x-denext-desktop-token":globalThis.__denext.token}})' +
  '["catch"](function(){})}catch(e){}}' +
  'if(document.readyState==="complete")b();else addEventListener("load",b)})()';

/**
 * Inject `globalThis.__denext = { desktop: true, token }` as an inline `<script>` immediately
 * after the opening `<head>` (falling back to after `<body>`, then to a prepend). The value is
 * `JSON.stringify`-escaped. When `beacon` is set, the boot-confirm beacon ({@linkcode
 * BOOT_BEACON_JS}) is appended to the SAME script so one CSP hash covers both. When the shell
 * carries a hash-based CSP meta, its `script-src` is extended with this script's `'sha256-…'` so
 * the script survives a strict policy.
 */
export async function injectDesktopGlobal(
  html: string,
  token: string,
  beacon = false,
): Promise<string> {
  const body = `globalThis.__denext=${JSON.stringify({ desktop: true, token })}` +
    (beacon ? BOOT_BEACON_JS : "");
  const scriptTag = `<script>${body}</script>`;
  const headMatch = html.match(/<head\b[^>]*>/i);
  const bodyMatch = headMatch ? null : html.match(/<body\b[^>]*>/i);
  let out: string;
  if (headMatch) {
    const at = headMatch.index! + headMatch[0].length;
    out = html.slice(0, at) + scriptTag + html.slice(at);
  } else if (bodyMatch) {
    const at = bodyMatch.index! + bodyMatch[0].length;
    out = html.slice(0, at) + scriptTag + html.slice(at);
  } else {
    out = scriptTag + html;
  }
  return addScriptHashToCspMeta(out, `'sha256-${await sha256Base64(body)}'`);
}

/** The export dir: `outDir` (relative to the entry module when given), else `out/`. */
/** The static-export dir to serve: `outDir` (relative to `importMetaUrl` when given), else `out/`. */
export function resolveOutDir(options: RunDesktopOptions): string {
  const base = options.importMetaUrl ? new URL(".", options.importMetaUrl) : undefined;
  if (options.outDir) return base ? fromFileUrl(new URL(options.outDir, base)) : options.outDir;
  return base ? fromFileUrl(new URL("out", base)) : join(Deno.cwd(), "out");
}

/**
 * Closing the window (macOS red light / Cmd-W) quits the app. `Deno.serve` is a
 * permanently-live task, so deno desktop won't auto-exit on close; adopt the initial
 * window and exit on its `close`. Guarded so a non-desktop run is a no-op.
 */
function installWindowCloseHandler(): void {
  try {
    // deno-lint-ignore no-explicit-any
    const BrowserWindow = (Deno as any).BrowserWindow;
    if (typeof BrowserWindow === "function") {
      const appWindow = new BrowserWindow();
      appWindow.addEventListener("close", () => Deno.exit(0));
    }
  } catch (err) {
    console.error("desktop: window-close handler not installed", err);
  }
}

/**
 * The token-gated local endpoints: the loopback OAuth sheet ({@link AUTH_SESSION_PATH}) and, with
 * the updater on, the boot-confirm beacon ({@link BOOTED_PATH}) — a real "the UI rendered" signal
 * that replaces a timer. The beacon requires POST + a constant-time token match, so a cross-origin
 * page cannot confirm a broken update. Returns the endpoint's `Response`, or `null` to fall through.
 */
async function handleLocalEndpoint(
  request: Request,
  url: URL,
  token: string,
  onBooted?: () => void | Promise<void>,
): Promise<Response | null> {
  if (url.pathname === AUTH_SESSION_PATH) return await handleDesktopAuthSession(request, token);
  if (onBooted && url.pathname === BOOTED_PATH) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const presented = request.headers.get("x-denext-desktop-token") ?? "";
    if (!timingSafeEqual(presented, token)) return new Response(null, { status: 403 });
    await onBooted();
    return new Response(null, { status: 204 });
  }
  return null;
}

/**
 * The desktop request handler: the `onRequest` escape hatch, the backend proxy, the export's
 * static assets (`no-store`), the `index.html` shell for navigations, else 404. Exported
 * for tests; {@linkcode runDesktop} wires it to `Deno.serve`.
 */
export function createDesktopHandler(
  options: RunDesktopOptions,
  outDir: string,
  proxy: ProxyModule | undefined,
  token: string = crypto.randomUUID(),
  onBooted?: () => void | Promise<void>,
): (request: Request, url: URL) => Promise<Response> {
  const proxyCfg = options.proxy;
  const indexHtmlPath = join(outDir, "index.html");

  /** Serve the export's `index.html` shell with the desktop global (and, with the updater on, the
   * boot-confirm beacon) injected. */
  const serveShell = async (isHead: boolean): Promise<Response | null> => {
    const html = await Deno.readTextFile(indexHtmlPath).catch(() => null);
    if (html === null) return null;
    const injected = await injectDesktopGlobal(html, token, onBooted !== undefined);
    return noStore(
      new Response(isHead ? null : injected, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
  };

  return async (request, url) => {
    if (options.onRequest) {
      const r = await options.onRequest(request, url);
      if (r) return r;
    }
    // The token-gated local endpoints (loopback OAuth + boot-confirm beacon) — before proxy/static.
    const endpoint = await handleLocalEndpoint(request, url, token, onBooted);
    if (endpoint) return endpoint;
    if (proxyCfg && proxy && proxy.matchesProxyPrefix(url.pathname, proxyCfg.prefixes)) {
      return await proxy.proxyToBackend(request, url, proxyCfg);
    }
    // The served-asset index.html path: inject the desktop global (re-read from disk so the
    // injection is not fighting content-encoding on the static response).
    if (url.pathname === "/index.html") {
      const shell = await serveShell(request.method === "HEAD");
      if (shell) return shell;
    }
    const accEnc = request.headers.get("accept-encoding") ?? undefined;
    const asset = await serveStatic(outDir, url.pathname, accEnc, request);
    if (asset) return noStore(asset);
    if (wantsShell(request, url.pathname)) {
      const shell = await serveShell(request.method === "HEAD");
      if (shell) return shell;
    }
    return new Response("not found", { status: 404 });
  };
}

/**
 * Serve a denext SPA export in a `deno desktop` window. Adopts the initial
 * `Deno.BrowserWindow` and quits the process on window close; under a plain
 * `deno run` (no desktop runtime) it just starts the server.
 */
// fallow-ignore-next-line complexity -- server bootstrap (starts Deno.serve); not unit-tested, CRAP is coverage-estimated
export async function runDesktop(options: RunDesktopOptions = {}): Promise<void> {
  const bundledOut = resolveOutDir(options);
  // With the updater on, prefer the verified overlay in the app-support dir (the boot watchdog
  // rolls back a version that failed to boot last launch); without it, serve the bundle as before.
  // Imported lazily so apps that don't use the updater never pull the module in.
  const updaterMod = options.updater ? await import("../desktop/updater.ts") : undefined;
  const outDir = updaterMod
    ? await updaterMod.resolveDesktopUiDir(bundledOut, options.updater!)
    : bundledOut;
  const port = options.port ?? Number(Deno.env.get("PORT") ?? 8000);
  // Imported lazily so proxy-less apps never pull in the proxy module (and its `npm:ws`).
  const proxy = options.proxy ? await import("./dev-proxy.ts") : undefined;
  installWindowCloseHandler();
  // A stray WebSocket/proxy rejection must never take down the server process.
  globalThis.addEventListener("unhandledrejection", (e) => {
    e.preventDefault();
    console.error("desktop: unhandledrejection", (e as PromiseRejectionEvent).reason);
  });
  // A per-launch token gates the loopback OAuth endpoint and is injected into every served
  // shell so only this app's own pages can drive `startDesktopAuthSession`.
  const token = crypto.randomUUID();
  // The updater's boot watchdog is confirmed by the injected beacon hitting BOOTED_PATH once the
  // page has actually LOADED (proof the UI rendered) — not a timer. A crash before render never
  // beacons, so the trial version stays PENDING and the next launch rolls it back.
  const onBooted = updaterMod && options.updater
    ? () => updaterMod.desktopBooted(options.updater!)
    : undefined;
  const handle = createDesktopHandler(options, outDir, proxy, token, onBooted);
  Deno.serve({
    port,
    hostname: "127.0.0.1",
    onError: (e) => {
      console.error("desktop: handler error", e);
      return new Response("desktop error", { status: 502 });
    },
  }, (req) => handle(req, new URL(req.url)));
}
