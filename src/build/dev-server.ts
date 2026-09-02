// Development server: SSR + on-demand client bundling + live reload.

import { basename, fromFileUrl, join, relative, resolve, toFileUrl } from "@std/path";
import { ensureDir } from "@std/fs";
import { createApp } from "../server/app.ts";
import { type RouteManifest, scanRoutes } from "../router/manifest.ts";
import { applyPlugins, getPluginRequestHandler, runPluginTeardown } from "../plugin/mod.ts";
import type { PageRoute } from "../router/manifest.ts";
import type { ModuleLoader } from "../server/types.ts";
import {
  bundleFlightEntry,
  type BundleOutput,
  bundleRoute,
  denoExecutable,
  entryCode,
  generateRouteEntry,
  routeServerModules,
  routeSourceFiles,
} from "./bundle.ts";
import { codeframe, parseStackFrame } from "./dev-codeframe.ts";
import {
  buildNextCompatClientEntries,
  buildNextCompatFlightEntry,
  buildNextCompatModules,
} from "./next-compat-build.ts";
import { createNextCompatServerLoader, redirectBoundaryToCompat } from "./next-compat-loader.ts";
import { detectNextCompat } from "./next-compat-detect.ts";
import { routeNeedsHydration } from "./hydration.ts";
import { type AppCss, buildAppCss, extractRouteCss } from "./css.ts";
import { tailwindPaths } from "./tailwind.ts";
import { collectComponentSources, compileModules } from "./compiler.ts";
import { compileQrlModules } from "./qrl-transform.ts";
import { createUseCacheLoader } from "./use-cache-loader.ts";
import { resolveDefaultCacheStore } from "../server/cache.ts";
import { emitTypedModules } from "./emit-typed-modules.ts";
import { imageOptionsFromConfig, optimizeImage } from "../server/image-optimizer.ts";
import { IMAGE_ENDPOINT, setImageRuntimeConfig } from "../runtime/image.ts";
import { LIVE_ENDPOINT } from "../runtime/live-protocol.ts";
import { handleLiveUpgrade, installLiveHub } from "../server/live.ts";
import { tagServerModules } from "../runtime/server-action.ts";
import {
  type HeaderRule,
  nodeResolveEnabled,
  type RedirectRule,
  resolveConfigRules,
  resolveLive,
  resolveStreaming,
  type RewriteRule,
} from "../server/config.ts";
import {
  type BoundaryManifest,
  buildBoundaryManifest,
  computeBoundaryRoutes,
  importFunctionExports,
  routeEntryFiles,
} from "./module-graph.ts";
import { type ProjectPaths, routeId } from "./paths.ts";
import { createUnbundledDev, type UnbundledDev } from "./dev-unbundled.ts";
import { startSpaDevServer } from "./spa.ts";
import { createMiddlewareRunner, type MiddlewareRunner } from "../server/middleware.ts";
import { displayHost, serveWithPortFallback } from "../server/serve-utils.ts";
import {
  type Instrumentation,
  loadInstrumentation,
  runRegister,
  setNextRuntimeEnv,
} from "../server/instrumentation.ts";

const RELOAD_PATH = "/_denext/reload";
const ROUTE_BUNDLE_PATH = "/_denext/route.js";
const FLIGHT_BUNDLE_PATH = "/_denext/flight.js";
const ROUTE_CSS_PATH = "/_denext/route.css";
// The live-reload/Fast-Refresh script, served as an EXTERNAL same-origin module so
// it is covered by `script-src 'self'` instead of tripping the strict CSP as an
// inline `<script>` would.
const DEV_RELOAD_JS_PATH = "/_denext/dev-reload.js";
// Dev-only endpoint the error overlay calls to open a source file in the editor.
const OPEN_IN_EDITOR_PATH = "/_denext/open-in-editor";

/**
 * Inline script injected into every dev page. It enables live reload and marks
 * the page as a dev build (`__denextDev`) so the client reconciler can emit
 * hydration-mismatch warnings — production pages never carry this script. It is
 * a plain (non-module) script placed before `</body>`, so it runs during parse,
 * ahead of the deferred hydration module.
 */
/**
 * Inline dev script injected into every dev page: live reload / Fast Refresh over
 * SSE, the `__denextDev` marker, and the dev error overlay (runtime errors,
 * unhandled rejections, and server-pushed build errors). Exported for tests;
 * never emitted into a production build.
 */
export const DEV_RELOAD_SCRIPT = `
(function () {
  window.__denextDev = true;
  // --- Dev error overlay -----------------------------------------------------
  var overlay = null;
  function hideOverlay() { if (overlay) { overlay.remove(); overlay = null; } }
  function el(tag, style, text) {
    var e = document.createElement(tag);
    if (style) e.setAttribute("style", style);
    if (text != null) e.textContent = text;
    return e;
  }
  function openInEditor(frame) {
    // Ask the dev server to open the file (it validates the path is in-project and
    // launches $EDITOR). Best-effort — a failure is silently ignored.
    var q = "?file=" + encodeURIComponent(frame.file) +
      "&line=" + (frame.line || 1) + "&column=" + (frame.column || 1);
    try { fetch(${JSON.stringify(OPEN_IN_EDITOR_PATH)} + q).catch(function () {}); } catch (_) {}
  }
  // extra (optional): { frame: {file, display, line, column}, codeframe } — enriches a
  // server/build error with a clickable in-project frame + a source snippet.
  function showOverlay(title, message, stack, extra) {
    hideOverlay();
    overlay = el("div",
      "position:fixed;inset:0;z-index:2147483647;background:rgba(20,10,10,.96);" +
      "color:#e6e6e6;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;" +
      "padding:24px 28px;overflow:auto;");
    var close = el("button",
      "position:absolute;top:14px;right:18px;background:none;border:none;color:#999;" +
      "font-size:26px;cursor:pointer;line-height:1;", "×");
    close.onclick = hideOverlay;
    overlay.appendChild(close);
    overlay.appendChild(el("div",
      "color:#ff6b6b;font-weight:700;font-size:15px;margin-bottom:6px;", "denext — " + title));
    if (extra && extra.frame) {
      var f = extra.frame;
      var loc = el("button",
        "display:block;background:none;border:none;padding:0;margin:0 0 10px;color:#8ab4f8;" +
        "font:inherit;text-decoration:underline;cursor:pointer;",
        (f.display || f.file) + ":" + (f.line || 1) + " — open in editor");
      loc.onclick = function () { openInEditor(f); };
      overlay.appendChild(loc);
    }
    overlay.appendChild(el("div",
      "color:#ffd7d7;white-space:pre-wrap;margin-bottom:14px;font-size:14px;", message || ""));
    if (extra && extra.codeframe) {
      overlay.appendChild(el("pre",
        "white-space:pre;overflow:auto;color:#e6e6e6;background:rgba(0,0,0,.35);" +
        "padding:12px 14px;border-radius:6px;margin:0 0 14px;", extra.codeframe));
    }
    overlay.appendChild(el("pre", "white-space:pre-wrap;color:#b9b9b9;margin:0;", stack || ""));
    (document.body || document.documentElement).appendChild(overlay);
  }
  window.__denextOverlay = showOverlay;
  window.addEventListener("error", function (e) {
    if (e && e.error) showOverlay("Runtime error", e.error.message, e.error.stack);
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    if (r) showOverlay("Unhandled rejection", r.message || String(r), r.stack);
  });

  function swapCss() {
    // CSS hot-swap: re-fetch every same-origin stylesheet with a fresh cache-buster
    // (the dev CSS endpoint is no-store and rebuilt per generation), swapping each
    // <link> for a clone so styles update with no page reload and no flash. The old
    // link is removed only once the new one has loaded.
    var links = document.querySelectorAll('link[rel="stylesheet"]');
    for (var i = 0; i < links.length; i++) {
      (function (l) {
        var href = l.getAttribute("href");
        if (!href) return;
        var u;
        try { u = new URL(href, location.href); } catch (_) { return; }
        if (u.origin !== location.origin) return;
        u.searchParams.set("hmr", String((window.__denextCssHmr = (window.__denextCssHmr || 0) + 1)));
        var n = l.cloneNode(false);
        n.setAttribute("href", u.href);
        n.onload = function () { try { l.remove(); } catch (_) {} };
        n.onerror = function () { try { n.remove(); } catch (_) {} location.reload(); };
        l.parentNode.insertBefore(n, l.nextSibling);
      })(links[i]);
    }
  }
  function refresh() {
    // Fast Refresh: re-import the route entry (cache-busted) so it re-runs
    // startClient -> retainedRoot.render(), reconciling edits in place and
    // preserving hook state. The entry falls back to a full reload if the
    // refresh is unsafe (hook-shape change) or hydration throws.
    try {
      var s = document.querySelector('script[type=module][src*="/_denext/"]');
      if (!s) { location.reload(); return; }
      var u = new URL(s.getAttribute("src"), location.href);
      // Defense-in-depth: the [src*="/_denext/"] selector matches on a substring,
      // so a cross-origin script (e.g. https://evil.example/_denext/x.js) could be
      // picked up. Only ever re-import from our own origin; otherwise hard-reload.
      if (u.origin !== location.origin) { location.reload(); return; }
      u.searchParams.set("hmr", String((window.__denextHmr = (window.__denextHmr || 0) + 1)));
      window.__denextRefreshing = true;
      var n = document.createElement("script");
      n.type = "module";
      n.src = u.href;
      n.onload = function () { n.remove(); };
      n.onerror = function () { n.remove(); location.reload(); };
      document.body.appendChild(n);
    } catch (_) { location.reload(); }
  }
  function update(json) {
    // Per-module HMR (unbundled dev server): re-import ONLY the changed accept-boundary
    // module(s), cache-busted, then trigger the reconciler's in-place re-render — the
    // family-current substitution swaps the new code onto the live fibers, hook state
    // intact. Any failure (or a cross-origin URL, defense-in-depth) falls back to a full
    // reload, so an edit is never silently half-applied.
    var urls;
    try { urls = JSON.parse(json); } catch (_) { location.reload(); return; }
    if (!urls || !urls.length) { location.reload(); return; }
    Promise.all(urls.map(function (u) {
      var abs = new URL(u, location.href);
      if (abs.origin !== location.origin) throw new Error("cross-origin module");
      return import(abs.href);
    })).then(function () {
      var r = window.__denextRefresh;
      if (typeof r === "function") r();
      else location.reload();
    }).catch(function () { location.reload(); });
  }
  try {
    var es = new EventSource(${JSON.stringify(RELOAD_PATH)});
    es.onmessage = function (e) {
      if (e.data === "refresh") { hideOverlay(); refresh(); }
      else if (e.data === "css") { hideOverlay(); swapCss(); }
      else if (e.data === "reload") location.reload();
      else if (e.data.indexOf("update:") === 0) { hideOverlay(); update(e.data.slice(7)); }
      else if (e.data.indexOf("error:") === 0) {
        try {
          var p = JSON.parse(e.data.slice(6));
          showOverlay(p.title || "Build error", p.message, p.stack,
            { frame: p.frame, codeframe: p.codeframe });
        } catch (_) {}
      }
    };
    es.onerror = function () { /* reconnect handled by browser */ };
  } catch (_) {}
})();
`;

export interface DevServerOptions {
  paths: ProjectPaths;
  port?: number;
  hostname?: string;
  signal?: AbortSignal;
  onListen?: (info: { hostname: string; port: number }) => void;
  /** Fail instead of falling back if the port is taken (explicit --port). */
  strictPort?: boolean;
  /**
   * Extra origins (or bare hostnames) permitted to open the dev live-reload
   * stream, beyond the dev server's own origin. Mirrors Next.js's
   * `allowedDevOrigins` — needed when reaching the dev server from another host
   * (a LAN device, a proxy). A cross-origin page not listed here is refused, so a
   * malicious site a developer visits cannot subscribe to the reload channel.
   */
  allowedDevOrigins?: string[];
  /**
   * Force the unbundled per-module dev loop on (`true`) or off (`false`), overriding the
   * `DENEXT_DEV_UNBUNDLED` env default. An explicit option keeps mode selection per-server
   * — a process-global env var can't distinguish two servers running concurrently (e.g. in
   * a parallel test run).
   */
  unbundled?: boolean;
}

/**
 * Is `request` allowed to reach a dev-only endpoint? Defeats a cross-origin page a
 * developer visits from reaching the dev reload/HMR channel — or the editor-launch
 * endpoint — while `deno task dev` runs (cf. CVE-2025-48068).
 *
 * A cross-site request is rejected via `Sec-Fetch-Site` FIRST: a browser stamps every
 * request with it, and crucially a cross-origin **subresource** load (`<img>`, `<script>`,
 * `<link>`) sends `Sec-Fetch-Site: cross-site` but **no `Origin` header** — so the old
 * "missing Origin ⇒ allow" path was bypassable by such a load. Only after that (header
 * absent — curl/tests, or a browser too old to send it) do we fall back to the `Origin`
 * allowlist, still allowing a missing Origin for non-browser clients.
 */
export function devOriginAllowed(
  request: Request,
  url: URL,
  allowed: string[],
): boolean {
  // A present Sec-Fetch-Site is authoritative: same-origin allowed, anything else
  // (cross-site/same-site/none) refused — this is what closes the Origin-less
  // cross-site subresource GET that could otherwise reach a state-changing endpoint.
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite) return secFetchSite === "same-origin";
  const origin = request.headers.get("origin");
  if (!origin) return true; // curl / tests / pre-Sec-Fetch browser — no cross-origin risk
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false; // malformed Origin
  }
  if (host === url.host) return true; // same-origin
  const hostname = host.split(":")[0];
  return allowed.some((a) => a === origin || a === host || a === hostname);
}

/**
 * The editor launch command + args for `file:line:column`, or `null` when no editor
 * can be resolved. Honors `DENEXT_EDITOR` / `VISUAL` / `EDITOR` (default: VS Code's
 * `code`), and shapes the args per editor family so the cursor lands on the line.
 * Pure (no spawn) so it's unit-testable.
 */
export function editorCommand(
  file: string,
  line: number,
  column: number,
  env: (k: string) => string | undefined = Deno.env.get,
): { cmd: string; args: string[] } | null {
  const cmd = env("DENEXT_EDITOR") || env("VISUAL") || env("EDITOR") || "code";
  const base = basename(cmd).toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
  if (/^(code|code-insiders|codium|vscodium|cursor|windsurf|positron)$/.test(base)) {
    return { cmd, args: ["--goto", `${file}:${line}:${column}`] };
  }
  if (/^(subl|sublime_text|sublime|atom)$/.test(base)) {
    return { cmd, args: [`${file}:${line}:${column}`] };
  }
  if (/^(webstorm|idea|pycharm|goland|rider|phpstorm|clion|rubymine|fleet)$/.test(base)) {
    return { cmd, args: ["--line", String(line), "--column", String(column), file] };
  }
  if (/^(vim|nvim|nano|hx|helix|kak|micro|emacs|emacsclient)$/.test(base)) {
    return { cmd, args: [`+${line}`, file] }; // terminal editors — best-effort
  }
  return { cmd, args: [file] };
}

/** Whether `p` is `dir` itself or a path under it (both already normalized/absolute). */
function withinDir(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir + "/");
}

/** Launch the editor for `file:line:column`; returns whether the spawn started. */
function spawnEditor(file: string, line: number, column: number): boolean {
  const resolved = editorCommand(file, line, column);
  if (!resolved) return false;
  try {
    new Deno.Command(resolved.cmd, { args: resolved.args, stdout: "null", stderr: "null" }).spawn();
    return true;
  } catch {
    return false;
  }
}

export function startDevServer(options: DevServerOptions): Deno.HttpServer {
  const { paths, allowedDevOrigins = [] } = options;

  // Configure the `<Image>` runtime from `images` config (see prod-server for details).
  setImageRuntimeConfig({
    unoptimized: paths.config?.images?.unoptimized ?? false,
    deviceSizes: paths.config?.images?.deviceSizes,
    imageSizes: paths.config?.images?.imageSizes,
  });

  // SPA mode ("React but not Next"): no `app/` routes — bundle a single client
  // entry, serve the HTML shell for every navigation, live-reload over SSE.
  if (paths.config?.mode === "spa") {
    return startSpaDevServer({
      paths,
      port: options.port,
      hostname: options.hostname,
      signal: options.signal,
      onListen: options.onListen,
      strictPort: options.strictPort,
    });
  }

  // Mark this (dev) process as a dev build so server-side render passes emit the
  // same developer warnings the browser bundle does (dangerouslySetInnerHTML,
  // dangerous URL schemes). Production `start` never runs this module, so it stays
  // off there. Mirrors the `window.__denextDev = true` set in the client script.
  (globalThis as { __denextDev?: boolean }).__denextDev = true;

  // Generation counter: bumped on any file change to bust module + bundle caches.
  let generation = 0;
  let manifest: RouteManifest | null = null;

  // Unbundled dev loop (Vite-class per-module HMR): serves each source module
  // transformed-but-unbundled at its own URL and hot-swaps a single edited module in
  // place (~5ms) instead of re-bundling the whole route (~hundreds of ms) through
  // `deno bundle`. DEFAULT-ON for the native App Router; opt out with
  // DENEXT_DEV_UNBUNDLED=0 to force the bundled whole-route refresh. next-compat keeps
  // the react→denext esbuild path (unbundledActive stays false there); within a native
  // app, per-route eligibility (getUnbundled().supportsRoute) keeps MDX routes bundled
  // and flight routes route through the flight entry, with an in-place fallback to the
  // bundled Fast Refresh for any edit the unbundled graph does not own.
  // `unbundledActive` is resolved once compat detection settles (in getManifest),
  // before any render reads clientEntryFor.
  const unbundledOptIn = options.unbundled ?? (Deno.env.get("DENEXT_DEV_UNBUNDLED") !== "0");
  let unbundled: UnbundledDev | null = null;
  let unbundledActive = false;
  // Resolved in getManifest before getUnbundled's first use (native App Router vs the
  // react→denext compat runtime): `createUnbundledDev` captures it once.
  let unbundledCompat = false;
  function getUnbundled(): UnbundledDev {
    return unbundled ??= createUnbundledDev({
      projectDir: paths.projectDir,
      appDir: paths.appDir,
      configPath: paths.configPath,
      outDir: paths.outDir,
      compat: unbundledCompat,
      classComponents: paths.config?.classComponents ?? true,
    });
  }

  // Flight boundary state, refreshed per generation. Mutable references shared
  // with createApp so gating/tagging stay live across edits.
  const flightRoutes = new Set<string>();
  const flightClients = new Map<string, { url: string }>();
  const flightServers = new Map<string, { url: string }>();
  let boundaryGen = -1;
  let flightBundle: string | null = null;

  // next-compat (drop-in) mode: rewrite react→denext so npm React libraries render
  // on denext's single React. Detected once. The Flight boundary is preserved in
  // compat too (Stage 4b): boundary routes render server components server-side and
  // hydrate only their islands via the compat flight bundle. Per generation we
  // rebuild the server bundles (incl. islands/actions) + client entries.
  let compatP: Promise<boolean> | undefined;
  const isCompat = (): Promise<
    boolean
  > => (compatP ??= detectNextCompat(paths));
  let compatLoad: ModuleLoader | null = null;
  let compatBuiltGen = -1;
  let compatBuilding: Promise<void> | null = null;
  // Source module path → react→denext compat server bundle path (this generation),
  // used to redirect boundary refs so the SSR renderer tags the shared-chunk
  // island/action instances the page bundle references.
  let compatModuleMap = new Map<string, string>();
  // The boundary islands to bundle as compat entries this generation (set by
  // refreshBoundary before the compat build runs).
  let compatBoundary: BoundaryManifest | null = null;

  // CSS assets, rebuilt per generation. `import()` of `.css` on the server is
  // handled by the CLI's `--config` re-exec; here we supply the client-bundle
  // import map and the per-route extracted stylesheet.
  let cssAssets: AppCss | null = null;
  let cssGen = -1;
  let cssHadEntries = false;
  async function getCss(): Promise<AppCss | null> {
    // Route entry sources feed the cross-package style crawl (sibling workspace
    // packages outside `projectDir`). `getCss` can run before the manifest is scanned
    // (walk-only, entryFiles empty); once the manifest exists, rebuild once this
    // generation so those out-of-tree stylesheets are picked up.
    const entryFiles = manifest ? [...new Set(manifest.pages.flatMap(routeEntryFiles))] : [];
    const wantEntries = entryFiles.length > 0;
    if (cssGen !== generation || (wantEntries && !cssHadEntries)) {
      cssAssets = await buildAppCss({
        projectDir: paths.projectDir,
        configPath: paths.configPath,
        outDir: paths.outDir,
        minify: false,
        entryFiles,
        tailwind: tailwindPaths(paths.projectDir, paths.config?.tailwind),
      });
      cssGen = generation;
      cssHadEntries = wantEntries;
    }
    return cssAssets;
  }

  // Auto-memo compiler (experimental, opt-in) + qrl handler extraction (rides on the
  // `resumable` route export, self-filtering): maps of original → transformed module
  // URLs, merged into the client bundle's import-map redirects. Rebuilt per
  // generation so edits are picked up on reload.
  let compilerMap: Record<string, string> = {};
  let qrlMap: Record<string, string> = {};
  let compilerGen = -1;
  async function getTransformMaps(): Promise<Record<string, string>> {
    if (compilerGen !== generation) {
      const sources = await collectComponentSources(paths.projectDir);
      compilerMap = paths.config?.experimental?.compiler
        ? await compileModules(sources, { outDir: paths.outDir })
        : {};
      qrlMap = await compileQrlModules(sources, { outDir: paths.outDir });
      compilerGen = generation;
    }
    // qrl takes precedence on a module both touch (handler extraction on resumable).
    return { ...compilerMap, ...qrlMap };
  }

  /** The merged client-bundle import map (CSS + compiler + qrl redirects). */
  async function bundleImportMap(): Promise<
    Record<string, string> | undefined
  > {
    const css = await getCss();
    const merged = { ...css?.importMap, ...await getTransformMaps() };
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  async function getManifest(): Promise<RouteManifest> {
    if (!manifest) {
      // Register plugins (idempotent) before scanning so route-synthesizer
      // plugins are in place; a re-scan after an edit re-applies as a no-op.
      await applyPlugins({
        projectRoot: paths.projectDir,
        appDir: paths.appDir,
        config: paths.config ?? {},
        mode: "dev",
        load,
      });
      manifest = await scanRoutes(paths.appDir);
      // Typed modules: (re)emit .denext/routes.ts + .denext/api.ts on each route-tree
      // (re)scan so editor types track the current routes and handler signatures. Only on a
      // structural rescan (not every keystroke); best-effort — never breaks the dev loop.
      await emitTypedModules(manifest, { outDir: paths.outDir, configPath: paths.configPath });
    }
    await refreshBoundary(manifest);
    await getCss(); // ensure cssAssets is current before styleHrefsFor is read
    // Resolve whether the unbundled dev loop applies now that compat detection has
    // settled. Works for BOTH native App Router and next-compat (the latter serves
    // react/npm from a pre-bundled runtime + on-demand npm bundle — see createUnbundledDev
    // `compat`). Gated only when a build-time module rewrite is active: the auto-memo
    // compiler (experimental.compiler) and the resumability qrl-handler extraction
    // redirect specific module URLs to transformed builds via the bundled client import
    // map, which the unbundled per-module serve does not apply — so those keep the
    // bundled path (correctness over speed).
    unbundledCompat = await isCompat();
    const transformMaps = await getTransformMaps();
    unbundledActive = unbundledOptIn && Object.keys(transformMaps).length === 0;
    return manifest;
  }

  async function refreshBoundary(m: RouteManifest): Promise<void> {
    if (boundaryGen === generation) return;
    const routes = await computeBoundaryRoutes(paths.appDir, m.pages);
    flightRoutes.clear();
    for (const r of routes) flightRoutes.add(r);
    flightClients.clear();
    flightServers.clear();
    // Build the boundary manifest unconditionally (not only when a client island
    // exists) so "use server" modules are discovered — and register them up front
    // — even for pure progressive-enhancement pages: a `<form action={fn}>` with no
    // client island is never a "flight" route yet must still render a working
    // action URL and dispatch.
    const boundary: BoundaryManifest = await buildBoundaryManifest(
      paths.appDir,
      [
        ...new Set(m.pages.flatMap(routeEntryFiles)),
      ],
      {
        exportsOf: importFunctionExports,
      },
    );
    for (const [id, ref] of boundary.client) flightClients.set(id, ref);
    for (const [id, ref] of boundary.server) flightServers.set(id, ref);
    await tagServerModules(boundary.server);
    flightBundle = null;
    compatBoundary = boundary;
    if (await isCompat()) {
      // Build the react→denext compat bundles (routes + islands + actions) and the
      // compat flight client bundle NOW, then redirect the boundary refs to the
      // shared-chunk instances — so the render that follows tags the SAME islands
      // the page bundle references. Done inside refreshBoundary (before any render's
      // tagging) so identity holds. ensureCompatBuilt takes the manifest (no
      // getManifest re-entry).
      await ensureCompatBuilt(m);
      if (boundary) redirectBoundaryToCompat(boundary, compatModuleMap);
    }
    boundaryGen = generation;
  }

  // Dev module loader: cache-bust via the generation query so edits reload.
  const baseLoad: ModuleLoader = (filePath) => {
    const href = filePath.startsWith("file:") ? filePath : toFileUrl(filePath).href;
    return import(`${href}?g=${generation}`);
  };
  // Cache Components (experimental): wrap the loader so `"use cache"` directives
  // compile into server-side caching. The wrapper — and the transformed copies it
  // writes — is rebuilt per generation so edits are picked up on reload.
  const useCacheEnabled = paths.config?.experimental?.cacheComponents ?? false;
  let ucLoad: ModuleLoader | null = null;
  let ucLoadGen = -1;
  // Per-generation next-compat build: react→denext SSR bundles (for the loader) +
  // client entries (into bundleCache/chunkCache), rebuilt on each edit. Coalesced
  // so a burst of requests in one generation builds once.
  function ensureCompatBuilt(m: RouteManifest): Promise<void> {
    if (compatBuiltGen === generation && compatLoad) return Promise.resolve();
    if (compatBuilding) return compatBuilding;
    compatBuilding = (async () => {
      const outDir = join(paths.outDir, "dev-compat", String(generation));
      const clientOut = join(outDir, "client");
      await ensureDir(clientOut);
      const cc = paths.config?.classComponents ?? true;
      const resolveAllNodeModules = nodeResolveEnabled(paths.config);
      const mdxOptions = paths.config?.mdx;
      // CSS shim map so stylesheet imports (incl. sibling-package `.scss`) redirect to
      // their shims in the esbuild compat bundle. getCss() is current for this generation.
      const cssShimMap = (await getCss())?.importMap;
      // Bundle route server modules + boundary islands + action modules as separate
      // entries in one code-split pass (islands become chunks, never inlined → the
      // page bundle and the tagged island resolve to one shared instance).
      const islandModules = compatBoundary
        ? [...compatBoundary.client.values()].map((r) => fromFileUrl(r.url))
        : [];
      const serverModules = compatBoundary
        ? [...compatBoundary.server.values()].map((r) => fromFileUrl(r.url))
        : [];
      const modules = [
        ...new Set([
          ...m.pages.flatMap(routeServerModules),
          ...islandModules,
          ...serverModules,
        ]),
      ];
      const moduleMap = await buildNextCompatModules({
        projectDir: paths.projectDir,
        configPath: paths.configPath,
        outDir,
        modules,
        classComponents: cc,
        resolveAllNodeModules,
        mdxOptions,
        cssImportMap: cssShimMap,
      });
      compatModuleMap = moduleMap;
      // Non-flight routes that still need interactivity → full-tree hydration
      // entries. Boundary (Flight) routes hydrate only their islands via flight.js.
      const clientRoutes: PageRoute[] = [];
      for (const r of m.pages) {
        if (flightRoutes.has(r.routePath)) continue;
        if (await routeNeedsHydration(r)) clientRoutes.push(r);
      }
      await buildNextCompatClientEntries({
        projectDir: paths.projectDir,
        configPath: paths.configPath,
        outDir,
        clientDir: clientOut,
        entries: clientRoutes.map((r) => ({
          id: routeId(r.routePath),
          source: generateRouteEntry(r, true),
        })),
        classComponents: cc,
        resolveAllNodeModules,
        mdxOptions,
        cssImportMap: cssShimMap,
      });
      // Compat Flight client bundle (react→denext islands, keyed by client id).
      if (compatBoundary) {
        await buildNextCompatFlightEntry({
          projectDir: paths.projectDir,
          configPath: paths.configPath,
          outDir,
          clientDir: clientOut,
          boundary: compatBoundary,
          flightFile: "flight.js",
          classComponents: cc,
          resolveAllNodeModules,
          mdxOptions,
          cssImportMap: cssShimMap,
          dev: true,
        });
      }
      // Load client outputs into the dev caches: `flight.js` → the flight bundle,
      // route entries → their route, everything else → shared chunks.
      const idToRoute = new Map(
        clientRoutes.map((r) => [routeId(r.routePath), r.routePath]),
      );
      for await (const e of Deno.readDir(clientOut)) {
        if (!e.isFile || !e.name.endsWith(".js")) continue;
        const code = await Deno.readTextFile(join(clientOut, e.name));
        const base = e.name.slice(0, -3);
        if (base === "flight") {
          flightBundle = code;
          continue;
        }
        const rp = idToRoute.get(base);
        if (rp) bundleCache.set(rp, code);
        else chunkCache.set(e.name, code);
      }
      compatLoad = createNextCompatServerLoader(baseLoad, { moduleMap });
      compatBuiltGen = generation;
    })().finally(() => {
      compatBuilding = null;
    });
    return compatBuilding;
  }

  const load: ModuleLoader = async (filePath) => {
    if (await isCompat()) {
      // getManifest → refreshBoundary builds the compat bundles + redirects the
      // boundary refs (once per generation) before this returns.
      await getManifest();
      return compatLoad!(filePath);
    }
    if (!useCacheEnabled) return baseLoad(filePath);
    if (ucLoadGen !== generation) {
      ucLoad = createUseCacheLoader(baseLoad, {
        projectDir: paths.projectDir,
        cacheDir: join(paths.outDir, "server-cache", String(generation)),
      });
      ucLoadGen = generation;
    }
    return ucLoad!(filePath);
  };

  // Client bundle cache keyed by route path (cleared on change). Entry code
  // only; split chunks (from dynamic imports) live in `chunkCache`, served next
  // to the entry so its relative `./chunk-*.js` imports resolve.
  const bundleCache = new Map<string, string>();
  const chunkCache = new Map<string, string>();

  // Stash a bundle's split chunks (everything but the entry) for serving.
  function cacheChunks(bundle: BundleOutput): void {
    for (const [name, code] of bundle.files) {
      if (name !== bundle.entry) chunkCache.set(name, code);
    }
  }

  // Coalesce concurrent first-hits for the same route so a burst of requests
  // doesn't spawn duplicate `deno bundle` subprocesses.
  //
  // BLD-M3 — dev/prod bundling divergence (documented, intentional): the dev
  // server bundles each route INDEPENDENTLY and lazily (for fast incremental
  // rebuilds), so the client runtime is inlined per route rather than hoisted into
  // one shared chunk the way the production build's single code-split pass does
  // (see `bundleRoutes` in build.ts). A production page therefore shares exactly
  // one runtime module instance across route entries; in dev, two route entries
  // loaded into the same document would each carry their own copy. denext only
  // ever loads one route entry per page, so this is latent — but the PRODUCTION
  // build is the source of truth for runtime-singleton behavior. Always verify a
  // release against `denext build` output, not just the dev server.
  const routeInFlight = new Map<string, Promise<string>>();
  async function getRouteBundle(route: PageRoute): Promise<string> {
    const cached = bundleCache.get(route.routePath);
    if (cached) return cached;
    if (await isCompat()) {
      // Compat client entries are built (into bundleCache) per generation.
      await getManifest();
      return bundleCache.get(route.routePath) ?? "";
    }
    const pending = routeInFlight.get(route.routePath);
    if (pending) return pending;
    const build = (async () => {
      const bundle = await bundleRoute(route, {
        configPath: paths.configPath,
        importMap: await bundleImportMap(),
        dev: true, // emit Fast Refresh registration into the entry
      });
      cacheChunks(bundle);
      const js = entryCode(bundle);
      bundleCache.set(route.routePath, js);
      return js;
    })();
    routeInFlight.set(route.routePath, build);
    try {
      return await build;
    } finally {
      routeInFlight.delete(route.routePath);
    }
  }

  // Flight (RSC): bundle one app-wide entry containing only the `"use client"`
  // modules; boundary routes hydrate from it instead of the whole-tree bundle.
  async function getFlightBundle(): Promise<string> {
    const m = await getManifest();
    // Compat: the SSR bundles are built by refreshBoundary via ensureCompatBuilt, but the
    // CLIENT flight entry serves unbundled when active (islands on their own @fs URLs,
    // react/npm from the runtime + npm bundle). `compatBoundary` is the compat boundary.
    if (await isCompat()) {
      if (unbundledActive && compatBoundary) {
        return await getUnbundled().serveFlightEntry(compatBoundary);
      }
      return flightBundle ?? "";
    }
    if (flightBundle) return flightBundle;
    const boundary = await buildBoundaryManifest(paths.appDir, [
      ...new Set(m.pages.flatMap(routeEntryFiles)),
    ], {
      exportsOf: importFunctionExports,
    });
    // Unbundled dev loop: serve the flight entry with each island on its own @fs URL,
    // so editing an island hot-swaps that single module in place — the same per-module
    // HMR as native routes.
    if (unbundledActive) {
      flightBundle = await getUnbundled().serveFlightEntry(boundary);
      return flightBundle;
    }
    const bundle = await bundleFlightEntry(boundary, {
      configPath: paths.configPath,
      importMap: await bundleImportMap(),
      dev: true, // emit Fast Refresh registration for client islands
    });
    cacheChunks(bundle);
    flightBundle = entryCode(bundle);
    return flightBundle;
  }

  const clientEntryFor = (route: PageRoute): string =>
    flightRoutes.has(route.routePath)
      ? FLIGHT_BUNDLE_PATH
      // Unbundled dev loop: a plain (non-flight) route hydrates from its unbundled
      // entry module (native App Router only; flight routes keep the bundled flight
      // entry, and an MDX/unsupported route falls back to the bundled whole-route path).
      : unbundledActive && getUnbundled().supportsRoute(route)
      ? getUnbundled().entryUrlFor(route)
      : `${ROUTE_BUNDLE_PATH}?p=${encodeURIComponent(route.routePath)}`;

  // Link a per-route stylesheet only when the project has CSS at all; the CSS
  // handler serves the route's extracted subset (possibly empty).
  const styleHrefsFor = (route: PageRoute): string[] | undefined =>
    cssAssets ? [`${ROUTE_CSS_PATH}?p=${encodeURIComponent(route.routePath)}`] : undefined;

  // Middleware runner, rebuilt whenever the generation changes.
  let middlewareRunner: MiddlewareRunner = null;
  let middlewareGen = -1;
  async function getMiddleware(): Promise<MiddlewareRunner> {
    if (!paths.middlewarePath) return null;
    if (middlewareGen !== generation) {
      const mod = await load(paths.middlewarePath);
      middlewareRunner = createMiddlewareRunner(mod as never);
      middlewareGen = generation;
    }
    return middlewareRunner;
  }

  // Instrumentation: load + run register() once at boot (async; requests arrive
  // after). onRequestError forwards through the holder so it's live once loaded.
  let instrumentation: Instrumentation = {};
  setNextRuntimeEnv();
  (async () => {
    instrumentation = await loadInstrumentation(paths.instrumentationPath);
    await runRegister(instrumentation);
  })();

  // Config redirect/rewrite/header rules, resolved once (async; createApp compiles
  // them lazily on first request, by which time these arrays are populated).
  const configRedirects: RedirectRule[] = [];
  const configRewrites: RewriteRule[] = [];
  const configHeaders: HeaderRule[] = [];
  (async () => {
    const r = await resolveConfigRules(paths.config);
    configRedirects.push(...r.redirects);
    configRewrites.push(...r.rewrites);
    configHeaders.push(...r.headers);
  })();

  // Install the durable default cache store (node:sqlite) unless the app set one
  // itself; the db lives in THIS project's .denext (not the launcher's cwd). Fails safe
  // to in-memory.
  void resolveDefaultCacheStore(
    paths.config?.cache?.path
      ? paths.config.cache
      : { ...paths.config?.cache, path: join(paths.outDir, "cache.db") },
  );

  const appHandler = createApp({
    getManifest,
    load,
    publicDir: paths.publicDir,
    clientEntryFor,
    styleHrefsFor,
    getMiddleware,
    // Plugins register lazily on the first getManifest (after createApp), so
    // resolve the combined handler per request. Only wired when plugins exist.
    matchExternal: paths.config?.plugins?.length
      ? async (request: Request) => {
        const handler = getPluginRequestHandler();
        return handler ? await handler(request) : null;
      }
      : undefined,
    onRequestError: (error, request, context) => {
      // Surface server-side render errors in the browser overlay (dev), not only
      // the terminal — the persistent SSE connection shows it on the loaded page.
      // Skip client-aborted requests (nav-away / cancelled fetch): not a code bug,
      // and broadcasting them would spam the overlay.
      const aborted = error instanceof Error &&
        (error.name === "AbortError" || /aborted/i.test(error.message));
      if (!aborted) broadcastError("Server render error", error);
      return instrumentation.onRequestError?.(error, request, context);
    },
    devScriptSrc: DEV_RELOAD_JS_PATH,
    i18n: paths.i18n ?? undefined,
    basePath: paths.config?.basePath,
    trailingSlash: paths.config?.trailingSlash,
    redirects: configRedirects,
    rewrites: configRewrites,
    headerRules: configHeaders,
    flight: true,
    appDir: paths.appDir,
    flightRoutes,
    flightClients,
    flightServers,
    cacheComponents: paths.config?.experimental?.cacheComponents,
    csp: paths.config?.csp,
    streaming: resolveStreaming(paths.config),
    hsts: paths.config?.hsts,
  });

  // Live Server Components hub (dev): push `<Live>` boundary updates over a
  // WebSocket. Same-origin gate reuses the dev-origin allowlist used for SSE.
  installLiveHub({
    appHandler,
    originAllowed: (req) => devOriginAllowed(req, new URL(req.url), allowedDevOrigins),
    config: resolveLive(paths.config),
  });

  // Live-reload subscribers.
  const reloadClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();

  /**
   * Notify subscribers of a change. `kind` is "refresh" for a Fast Refresh
   * attempt (source-only edits — the client re-imports the route entry, keeping
   * state) or "reload" for a full reload (CSS/assets/config, or anything the
   * refresh can't handle). The client falls back to a full reload on its own if a
   * refresh turns out to be unsafe.
   */
  function broadcast(kind: "refresh" | "reload" | "css"): void {
    for (const controller of reloadClients) {
      try {
        controller.enqueue(encoder.encode(`data: ${kind}\n\n`));
      } catch {
        reloadClients.delete(controller);
      }
    }
  }

  /**
   * Push a per-module HMR update to subscribers: an `update:<json>` frame whose payload
   * is the JSON list of changed accept-boundary module URLs (each cache-busted). The
   * client re-imports only those and re-renders in place (unbundled dev loop).
   */
  function broadcastUpdate(urls: string[]): void {
    const payload = JSON.stringify(urls);
    for (const controller of reloadClients) {
      try {
        controller.enqueue(encoder.encode(`data: update:${payload}\n\n`));
      } catch {
        reloadClients.delete(controller);
      }
    }
  }

  /** The `error:` frame payload the overlay renders. */
  interface ErrorPayload {
    title: string;
    message: string;
    stack: string;
    /** The first in-project stack frame (clickable → open-in-editor), if any. */
    frame?: { file: string; display: string; line: number; column: number };
    /** A source snippet around the frame, with a caret at the error column. */
    codeframe?: string;
  }

  /**
   * Enrich a stack/diagnostic string with the first in-project frame and a codeframe
   * (read from disk). Returns `{}` when no app frame is found, so a framework-only
   * trace just shows message + stack.
   */
  function enrichFrame(stack: string): Pick<ErrorPayload, "frame" | "codeframe"> {
    const f = parseStackFrame(stack, paths.projectDir);
    if (!f) return {};
    const frame = {
      file: f.file,
      display: relative(paths.projectDir, f.file),
      line: f.line,
      column: f.column,
    };
    try {
      return { frame, codeframe: codeframe(Deno.readTextFileSync(f.file), f.line, f.column) };
    } catch {
      return { frame }; // file vanished / unreadable — still link the frame
    }
  }

  /** Push an `error:<json>` frame to subscribers (single SSE `data:` line). */
  function pushError(payload: ErrorPayload): void {
    const json = JSON.stringify(payload);
    for (const controller of reloadClients) {
      try {
        controller.enqueue(encoder.encode(`data: error:${json}\n\n`));
      } catch {
        reloadClients.delete(controller);
      }
    }
  }

  /**
   * Push a build/bundle/SSR error to the dev error overlay, enriched with the first
   * in-project stack frame + a codeframe so the developer can jump straight to the line.
   */
  function broadcastError(title: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : "";
    pushError({ title, message, stack, ...enrichFrame(stack) });
  }

  // Dev-loop type-checking: `deno check` runs async + debounced off the render path on a
  // source edit; a failure surfaces in the overlay (with a codeframe) instead of reaching
  // the browser silently. A monotonic token drops a stale run when a newer edit lands.
  let typeCheckToken = 0;
  function typeCheck(changedPaths: string[]): void {
    if (Deno.env.get("DENEXT_DEV_TYPECHECK") === "0") return;
    const files = changedPaths.filter((p) => /\.(ts|tsx)$/.test(p) && !p.includes("/.denext/"));
    if (files.length === 0) return;
    const token = ++typeCheckToken;
    void (async () => {
      // Skip compat/drop-in apps: `deno check` on the raw npm-React source doesn't
      // match the next-compat build's rewritten module graph, so it would false-positive.
      if (await isCompat()) return;
      try {
        const args = ["check", "--quiet"];
        if (paths.configPath.startsWith(paths.projectDir)) args.push("--config", paths.configPath);
        // `--` before the file list so a source path beginning with `-` can't be
        // misparsed as a flag (paths are watcher-sourced, not attacker-controlled, but
        // this keeps the spawn robust regardless).
        args.push("--", ...files);
        const { code, stderr } = await new Deno.Command(denoExecutable(), {
          args,
          cwd: paths.projectDir,
          stdout: "null",
          stderr: "piped",
        }).output();
        if (token !== typeCheckToken) return; // superseded by a newer edit
        if (code === 0) return; // clean — this edit's refresh/reload already cleared any overlay
        const text = new TextDecoder().decode(stderr).trim();
        if (text) {
          pushError({
            title: "Type error",
            message: text.split("\n").slice(0, 24).join("\n"),
            stack: "",
            ...enrichFrame(text),
          });
        }
      } catch { /* couldn't spawn `deno check` — skip silently, never block the loop */ }
    })();
  }

  /**
   * Resolve a request's `file` param to an absolute path that is a real file **inside
   * the project**, or `null` when it isn't — never open an arbitrary path on the host.
   */
  function resolveInProjectFile(file: string): string | null {
    let abs: string;
    try {
      abs = file.startsWith("file://") ? fromFileUrl(file) : resolve(file);
    } catch {
      return null;
    }
    if (!withinDir(abs, paths.projectDir)) return null;
    // Resolve symlinks and RE-verify containment against the real project root: an
    // in-project symlink pointing outside (project/x -> /etc/passwd) passes the lexical
    // prefix check above but must not be opened. realPathSync also confirms existence.
    let real: string, realRoot: string;
    try {
      real = Deno.realPathSync(abs);
      realRoot = Deno.realPathSync(paths.projectDir);
    } catch {
      return null; // not found / unreadable
    }
    if (!withinDir(real, realRoot)) return null;
    try {
      return Deno.statSync(real).isFile ? real : null;
    } catch {
      return null;
    }
  }

  /** Open a source file in the developer's editor (dev-only, in-project paths only). */
  function openInEditorResponse(params: URLSearchParams): Response {
    const abs = resolveInProjectFile(params.get("file") ?? "");
    if (!abs) return new Response("bad or out-of-project file", { status: 400 });
    const line = Number(params.get("line") ?? "1") || 1;
    const column = Number(params.get("column") ?? "1") || 1;
    const launched = spawnEditor(abs, line, column);
    return new Response(launched ? "ok" : "no editor", { status: launched ? 200 : 501 });
  }

  /**
   * Whether a change set can be handled by Fast Refresh (re-import the route
   * entry, preserving state) rather than a full reload. Only JSX component
   * modules qualify: `.css`/assets need a stylesheet refetch, and `.ts`
   * server/config/middleware edits need the server to re-render. Empty → reload.
   */
  function refreshable(changedPaths: string[]): boolean {
    if (changedPaths.length === 0) return false;
    return changedPaths.every((p) => {
      if (!/\.(tsx|jsx)$/.test(p)) return false;
      if (paths.middlewarePath && p === paths.middlewarePath) return false;
      if (paths.publicDir && p.startsWith(paths.publicDir)) return false;
      return true;
    });
  }

  /**
   * True when every change is a stylesheet — a CSS hot-swap (re-fetch the `<link>`)
   * instead of a full reload. The route CSS endpoint is rebuilt per generation, so a
   * cache-busted refetch picks up the edit with no reload.
   */
  function cssOnly(changedPaths: string[]): boolean {
    return changedPaths.length > 0 && changedPaths.every((p) => p.endsWith(".css"));
  }

  // Watch app + public dirs and invalidate on change. Close cleanly on shutdown
  // so the watcher and live-reload streams don't outlive the server.
  watch();
  async function watch(): Promise<void> {
    // Config files: the project's own deno.json (not the framework's) plus
    // denext.config.{ts,js}. A change here can't be hot-applied in-process — most
    // config is captured at startup — so we watch them to print an honest
    // "restart to apply" note rather than silently ignoring the edit.
    const configFiles = new Set<string>();
    if (paths.configPath.startsWith(paths.projectDir)) configFiles.add(paths.configPath);
    for (const name of ["denext.config.ts", "denext.config.js"]) {
      configFiles.add(join(paths.projectDir, name));
    }
    // Classify config edits by BASENAME: Deno.watchFs may report realpath-resolved
    // event paths (e.g. `/private/var/…` on macOS) that won't string-equal the
    // logical `configFiles` paths, so an exact-path match would misclassify.
    const configBasenames = new Set([...configFiles].map((p) => basename(p)));
    const candidates = [paths.appDir, paths.publicDir, ...configFiles];
    if (paths.middlewarePath) candidates.push(paths.middlewarePath);
    // Deno.watchFs throws NotFound if any path is missing; an app need not have a
    // `public/` dir (or middleware/config), so only watch what actually exists.
    const watched = candidates.filter((p) => {
      try {
        Deno.statSync(p);
        return true;
      } catch {
        return false;
      }
    });
    const watcher = Deno.watchFs(watched, { recursive: true });
    options.signal?.addEventListener("abort", () => {
      try {
        watcher.close();
      } catch { /* already closed */ }
      for (const controller of reloadClients) {
        try {
          controller.close();
        } catch { /* already closed */ }
      }
      reloadClients.clear();
      // Release the unbundled dev loop's esbuild service (no-op if it never started).
      void unbundled?.stop();
    });
    let debounce: ReturnType<typeof setTimeout> | undefined;
    // Accumulate the paths changed during a debounce window so we can choose Fast
    // Refresh (source-only) vs a full reload (CSS/assets/config/middleware).
    let changed: string[] = [];
    try {
      for await (const event of watcher) {
        for (const p of event.paths) changed.push(p);
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          const changedPaths = changed;
          changed = [];
          // A config-file edit can't be hot-applied — tell the developer to restart
          // (and don't count it toward the reload/refresh decision below).
          const configChanged = changedPaths.filter((p) => configBasenames.has(basename(p)));
          const rest = changedPaths.filter((p) => !configBasenames.has(basename(p)));
          if (configChanged.length > 0) {
            const names = configChanged.map((p) => p.split("/").pop()).join(", ");
            console.log(
              `\n  ⚠  ${names} changed — restart the dev server to apply config changes.\n`,
            );
          }
          if (rest.length === 0) return; // config-only edit: nothing to rebuild
          generation++;
          manifest = null;
          bundleCache.clear();
          chunkCache.clear();
          // Type-check the edited source off the render path; a failure surfaces in the
          // overlay (async — never blocks the reload/refresh decision below).
          typeCheck(rest);
          // CSS-only edits hot-swap the stylesheet regardless of bundling mode.
          if (cssOnly(rest)) {
            broadcast("css");
          } else if (unbundledActive && refreshable(rest)) {
            // Unbundled dev loop: hot-swap only the changed accept-boundary module(s).
            const { updates, reload, unknownOnly } = getUnbundled().onChange(rest);
            if (updates.length > 0 && !reload) {
              broadcastUpdate(updates);
            } else if (unknownOnly) {
              // Not part of the unbundled client graph (a flight-route island, a
              // bundled/MDX route's component). The bundled whole-entry Fast Refresh
              // still applies it in place — don't downgrade to a full reload.
              broadcast("refresh");
            } else {
              // A module ON an unbundled route changed structurally (propagated to the
              // route entry) — the page must fully reload.
              broadcast("reload");
            }
          } else {
            // Bundled path: source-only edits Fast-Refresh (whole route entry);
            // everything else (assets/middleware/server) needs a full reload.
            broadcast(refreshable(rest) ? "refresh" : "reload");
          }
        }, 60);
      }
    } catch { /* watcher closed on shutdown */ }
  }

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Live Server Components WebSocket upgrade (handled before appHandler so the
    // long-lived socket dodges the per-request timeout + concurrency ceiling).
    if (url.pathname === LIVE_ENDPOINT) {
      return handleLiveUpgrade(request);
    }

    // Live-reload SSE stream. Refuse a cross-origin subscriber (defense-in-depth
    // against a malicious page reading dev signals — cf. CVE-2025-48068).
    if (url.pathname === RELOAD_PATH) {
      if (!devOriginAllowed(request, url, allowedDevOrigins)) {
        return new Response("forbidden", { status: 403 });
      }
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

    // Open-in-editor (dev overlay "open in editor"). Same cross-origin gate as the
    // reload stream — a page a developer visits must not be able to launch their editor.
    if (url.pathname === OPEN_IN_EDITOR_PATH) {
      if (!devOriginAllowed(request, url, allowedDevOrigins)) {
        return new Response("forbidden", { status: 403 });
      }
      return openInEditorResponse(url.searchParams);
    }

    // Live-reload/Fast-Refresh runtime, served as an external same-origin module
    // (so the strict CSP's `script-src 'self'` allows it — no inline script).
    if (url.pathname === DEV_RELOAD_JS_PATH) {
      return new Response(DEV_RELOAD_SCRIPT, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    // Unbundled dev loop: serve @dep / @fs / @entry / @empty modules (native App
    // Router). Returns null for any non-unbundled URL, so the bundled handlers below
    // stay the path for flight routes and the compat build.
    if (unbundledActive && url.pathname.startsWith("/_denext/@")) {
      // getManifest FIRST: it resolves `unbundledCompat`, which getUnbundled captures at
      // creation (native denext deps vs the compat react→denext runtime).
      const m = await getManifest();
      const res = await getUnbundled().handle(request, url, m);
      if (res) return res;
    }

    // App-wide Flight bundle (client islands + registry).
    if (url.pathname === FLIGHT_BUNDLE_PATH) {
      try {
        const js = await getFlightBundle();
        return new Response(js, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      } catch (err) {
        console.error("denext: flight bundle error", err);
        broadcastError("Flight bundle error", err);
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(
          `console.error(${JSON.stringify("denext flight bundle error:\n" + msg)});`,
          { status: 500, headers: { "content-type": "text/javascript" } },
        );
      }
    }

    // Liveness/readiness probe endpoint (for load balancers / k8s).
    if (url.pathname === "/_denext/health") {
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    // Built-in image optimization endpoint.
    if (url.pathname === IMAGE_ENDPOINT) {
      return optimizeImage(
        request,
        imageOptionsFromConfig(paths.config?.images, paths.publicDir),
      );
    }

    // Per-route extracted stylesheet (transformed CSS the route's graph reaches).
    if (url.pathname === ROUTE_CSS_PATH) {
      const routePath = url.searchParams.get("p");
      const m = await getManifest();
      const route = m.pages.find((p) => p.routePath === routePath);
      const css = await getCss();
      const text = route && css ? await extractRouteCss(routeSourceFiles(route), css) : "";
      return new Response(text, {
        headers: {
          "content-type": "text/css; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    // Split chunk from a dynamic import, emitted next to a route/flight entry.
    // The entry's relative `./chunk-*.js` import resolves here; the entry request
    // populated `chunkCache` before returning, so the chunk is present by now.
    if (url.pathname.startsWith("/_denext/") && url.pathname.endsWith(".js")) {
      const chunk = chunkCache.get(url.pathname.slice("/_denext/".length));
      if (chunk !== undefined) {
        return new Response(chunk, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }
    }

    // On-demand client route bundle.
    if (url.pathname === ROUTE_BUNDLE_PATH) {
      const routePath = url.searchParams.get("p");
      const m = await getManifest();
      const route = m.pages.find((p) => p.routePath === routePath);
      if (!route) return new Response("// route not found", { status: 404 });
      try {
        const js = await getRouteBundle(route);
        return new Response(js, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      } catch (err) {
        console.error("denext: bundle error", err);
        broadcastError("Bundle error", err);
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(
          `console.error(${JSON.stringify("denext bundle error:\n" + msg)});`,
          { status: 500, headers: { "content-type": "text/javascript" } },
        );
      }
    }

    return appHandler(request);
  }

  const server = serveWithPortFallback(
    {
      port: options.port ?? 3000,
      hostname: options.hostname ?? "localhost",
      signal: options.signal,
      strict: options.strictPort,
      onListen: options.onListen ??
        (({ hostname, port }) =>
          console.log(
            `\n  denext dev  ▸  http://${displayHost(hostname)}:${port}\n` +
              `  watching ${paths.appDir}\n`,
          )),
    },
    handler,
  );
  // Run plugin teardowns once the dev server has drained.
  server.finished.then(() => runPluginTeardown());
  return server;
}
