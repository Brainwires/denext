// Production server: serve SSR pages plus the pre-built client bundles.

import { join } from "@std/path";
import { applyDefaultSecurityHeaders, createApp } from "../server/app.ts";
import { scanRoutes } from "../router/manifest.ts";
import type { PageRoute } from "../router/manifest.ts";
import { defaultLoader } from "../server/mod.ts";
import { applyPlugins, getPluginRequestHandler, runPluginTeardown } from "../plugin/mod.ts";
import {
  buildBoundaryManifest,
  computeBoundaryRoutes,
  importFunctionExports,
  routeEntryFiles,
} from "./module-graph.ts";
import { tagServerModules } from "../runtime/server-action.ts";
import { FLIGHT_BUNDLE_FILE } from "./build.ts";
import { createUseCacheLoader } from "./use-cache-loader.ts";
import { createNextCompatServerLoader, redirectBoundaryToCompat } from "./next-compat-loader.ts";
import { type ProjectPaths, resolveProject, routeId } from "./paths.ts";
import { startSpaProdServer } from "./spa.ts";
import { displayHost, serveImmutableAsset, serveWithPortFallback } from "../server/serve-utils.ts";
import { createMiddlewareRunner, type MiddlewareRunner } from "../server/middleware.ts";
import { cacheStoreHealthy, PageCache, resolveDefaultCacheStore } from "../server/cache.ts";
import { loadInstrumentation, runRegister, setNextRuntimeEnv } from "../server/instrumentation.ts";
import { resolveConfigRules, resolveLive, resolveStreaming } from "../server/config.ts";
import { imageOptionsFromConfig, optimizeImage } from "../server/image-optimizer.ts";
import { IMAGE_ENDPOINT, setImageRuntimeConfig } from "../runtime/image.ts";
import { LIVE_ENDPOINT } from "../runtime/live-protocol.ts";
import { handleLiveUpgrade, installLiveHub } from "../server/live.ts";
import { setSelfHostedFonts } from "../compat/next/font/registry.ts";
import { FONTS_PUBLIC_PREFIX } from "./self-host-fonts.ts";

const CLIENT_PREFIX = "/_denext/client/";

export interface ProdServerOptions {
  projectDir: string;
  port?: number;
  hostname?: string;
  signal?: AbortSignal;
  onListen?: (info: { hostname: string; port: number }) => void;
  /** Fail instead of falling back if the port is taken (explicit --port). */
  strictPort?: boolean;
  /**
   * Max milliseconds to wait for in-flight requests to drain on shutdown before
   * forcing exit. Defaults to the `DENEXT_SHUTDOWN_DRAIN_MS` env var, else
   * {@linkcode DEFAULT_SHUTDOWN_DRAIN_MS}. Set `0` to wait indefinitely.
   */
  shutdownDrainMs?: number;
}

/** Default graceful-shutdown drain deadline (ms) when nothing else is configured. */
const DEFAULT_SHUTDOWN_DRAIN_MS = 10_000;

/** Resolve the shutdown drain deadline from an explicit option, then env, then default. */
function resolveShutdownDrainMs(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  const env = Deno.env.get("DENEXT_SHUTDOWN_DRAIN_MS");
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_SHUTDOWN_DRAIN_MS;
}

export async function startProdServer(
  options: ProdServerOptions,
): Promise<Deno.HttpServer> {
  const paths: ProjectPaths = await resolveProject(options.projectDir);

  // Configure the `<Image>` runtime from `images` config so SSR renders optimizer URLs
  // with allowlist-correct widths (or plain `<img>` when `images.unoptimized`).
  setImageRuntimeConfig({
    unoptimized: paths.config?.images?.unoptimized ?? false,
    deviceSizes: paths.config?.images?.deviceSizes,
    imageSizes: paths.config?.images?.imageSizes,
  });

  // SPA mode ("React but not Next"): serve the built client bundle + HTML shell
  // (history-API fallback) — no route manifest, no SSR.
  if (paths.config?.mode === "spa") {
    return await startSpaProdServer(options);
  }

  const clientDir = join(paths.outDir, "client");

  // A Pages Router app (no `app/` tree) has no App Router client dir — its plugin
  // owns the build output (`.denext/pages-*`) and serves via `matchExternal`. Skip
  // the App Router fail-fast; the empty route manifest below lets the plugin serve.
  let hasApp = true;
  try {
    hasApp = (await Deno.stat(paths.appDir)).isDirectory;
  } catch {
    hasApp = false;
  }
  // Fail fast if an App Router build hasn't run.
  if (hasApp) {
    try {
      await Deno.stat(clientDir);
    } catch {
      throw new Error(
        `No build output at ${clientDir}. Run \`denext build\` first.`,
      );
    }
  }

  // Set up plugins before scanning so route-synthesizer plugins register in time.
  await applyPlugins({
    projectRoot: paths.projectDir,
    appDir: paths.appDir,
    config: paths.config ?? {},
    mode: "prod",
    load: defaultLoader,
  });

  // If startup fails AFTER plugins were applied (missing build, port in use, …),
  // run their teardown hooks before rethrowing — otherwise an embedded caller that
  // starts denext in-process leaks plugin-held resources on a failed boot. On the
  // success path teardown runs via `server.finished` below.
  try {
    const manifest = await scanRoutes(paths.appDir);

    // Routes the build determined are static (no client JS): they have no bundle on
    // disk by design, get no hydration <script>, and are skipped by the missing-
    // bundle check below. Absent field (older build) → treat none as static.
    let staticRoutes = new Set<string>();
    // next-compat: the build rewrote route modules to denext's single React. Read
    // the source→server-bundle map to redirect the SSR loader. The Flight boundary
    // is preserved in compat too (Stage 4b): boundary routes render server components
    // server-side and hydrate only their islands via the compat flight bundle.
    let nextCompat = false;
    // Public-env vars to embed: the build-detected referenced set ∪ the config
    // allowlist. Undefined ⇒ ship all (e.g. a pre-scan build manifest).
    let publicEnvKeys: string[] | undefined;
    const compatModuleMap = new Map<string, string>();
    try {
      const bm = JSON.parse(await Deno.readTextFile(join(paths.outDir, "manifest.json")));
      if (Array.isArray(bm.staticRoutes)) staticRoutes = new Set<string>(bm.staticRoutes);
      if (Array.isArray(bm.publicEnvKeys)) {
        publicEnvKeys = [...new Set([...bm.publicEnvKeys, ...(paths.config?.publicEnv ?? [])])];
      }
      // Install build-self-hosted Google fonts so renderFontStyles emits local CSS.
      if (bm.fonts && typeof bm.fonts === "object") setSelfHostedFonts(bm.fonts);
      nextCompat = bm.nextCompat === true;
      if (bm.compatServerModules && typeof bm.compatServerModules === "object") {
        for (const [relSrc, relBundle] of Object.entries(bm.compatServerModules)) {
          compatModuleMap.set(
            join(paths.projectDir, relSrc),
            join(paths.outDir, relBundle as string),
          );
        }
      }
    } catch { /* no/invalid build manifest → treat none as static */ }

    // Flight boundary: which routes reach a client island, and the client modules
    // to tag. Computed once at startup via the import-graph crawl. The boundary
    // manifest is built unconditionally (not only when a client island exists) so
    // its "use server" modules are discovered even for pure progressive-enhancement
    // pages — routes with a `<form action={serverActionFn}>` but no client island,
    // which are never "flight" routes yet still must render a working action URL.
    const flightRoutes = await computeBoundaryRoutes(paths.appDir, manifest.pages);
    const boundary = await buildBoundaryManifest(paths.appDir, [
      ...new Set(manifest.pages.flatMap(routeEntryFiles)),
    ], {
      exportsOf: importFunctionExports,
    });
    // Register every discovered "use server" module up front so its exports
    // serialize as action references and dispatch on ANY route — not just routes
    // that also reach a client island (the flight-only tagging path below).
    await tagServerModules(boundary.server);

    // next-compat: the SSR renderer must tag (and render for first paint) the SAME
    // island/action instances the page's react→denext server bundle references — the
    // ones in the shared runtime chunk, NOT the raw npm-React source. Redirect each
    // boundary ref's URL to its compat server bundle so `tagClientModules` /
    // `tagServerModules` import the rewritten module. Identity holds because the
    // island is a separate build entry → its bundle re-exports the shared-chunk
    // instance the page bundle also imports.
    if (nextCompat && boundary) {
      redirectBoundaryToCompat(boundary, compatModuleMap);
    }

    // Fail fast on a partial/incomplete build: every non-Flight page route must
    // have its client entry on disk. Otherwise the page would SSR but silently
    // never hydrate (the browser 404s the missing entry, and the loader swallows
    // it). Flight routes share the app-wide flight.js, checked once.
    const missing: string[] = [];
    for (const page of manifest.pages) {
      if (flightRoutes.has(page.routePath)) continue;
      if (staticRoutes.has(page.routePath)) continue; // no bundle by design
      const entry = join(clientDir, `${routeId(page.routePath)}.js`);
      try {
        await Deno.stat(entry);
      } catch {
        missing.push(`${page.routePath} -> ${entry}`);
      }
    }
    if (flightRoutes.size > 0) {
      try {
        await Deno.stat(join(clientDir, FLIGHT_BUNDLE_FILE));
      } catch {
        missing.push(`(flight) -> ${join(clientDir, FLIGHT_BUNDLE_FILE)}`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Incomplete build: ${missing.length} client entry file(s) missing. Re-run ` +
          `\`denext build\`.\n  ${missing.join("\n  ")}`,
      );
    }

    // Asset URLs carry the assetPrefix (CDN origin) or basePath so the browser
    // requests them at the right place; `assetPrefix` wins when both are set.
    const basePath = paths.config?.basePath?.replace(/\/$/, "") || "";
    const assetPrefix = paths.config?.assetPrefix?.replace(/\/$/, "") || basePath;
    const asset = (path: string): string => `${assetPrefix}${path}`;

    const clientEntryFor = (route: PageRoute): string | undefined =>
      staticRoutes.has(route.routePath) ? undefined : asset(
        flightRoutes.has(route.routePath)
          ? `${CLIENT_PREFIX}${FLIGHT_BUNDLE_FILE}`
          : `${CLIENT_PREFIX}${routeId(route.routePath)}.js`,
      );

    // Routes with an extracted stylesheet on disk (written by `denext build`).
    const cssRoutes = new Set<string>();
    for (const route of manifest.pages) {
      try {
        await Deno.stat(join(clientDir, `${routeId(route.routePath)}.css`));
        cssRoutes.add(route.routePath);
      } catch { /* no stylesheet for this route */ }
    }
    const styleHrefsFor = (route: PageRoute): string[] | undefined =>
      cssRoutes.has(route.routePath)
        ? [asset(`${CLIENT_PREFIX}${routeId(route.routePath)}.css`)]
        : undefined;

    // Cache Components (experimental): wrap the module loader so `"use cache"`
    // directives compile into server-side caching. Clear any transformed copies from
    // a previous run first (copy names key on source URL, not content, so a stale
    // copy could otherwise shadow edited source when restarted without a rebuild).
    let load = defaultLoader;
    // next-compat: redirect route source modules to their react→denext server
    // bundles (innermost, above defaultLoader) so use-cache/native both operate on
    // real files while SSR renders on the single denext React.
    if (nextCompat && compatModuleMap.size > 0) {
      load = createNextCompatServerLoader(load, { moduleMap: compatModuleMap });
    }
    if (paths.config?.experimental?.cacheComponents) {
      const cacheDir = join(paths.outDir, "server-cache");
      await Deno.remove(cacheDir, { recursive: true }).catch(() => {});
      load = createUseCacheLoader(load, { projectDir: paths.projectDir, cacheDir });
    }

    // Load middleware once at startup.
    let middlewareRunner: MiddlewareRunner = null;
    if (paths.middlewarePath) {
      const mod = await load(paths.middlewarePath);
      middlewareRunner = createMiddlewareRunner(mod as never);
    }

    // Instrumentation: expose NEXT_RUNTIME, run register() once at boot; wire onRequestError.
    setNextRuntimeEnv();
    const instrumentation = await loadInstrumentation(paths.instrumentationPath);
    await runRegister(instrumentation);

    // Resolve denext.config redirect/rewrite/header rules once at startup.
    const rules = await resolveConfigRules(paths.config);

    // Install the durable default cache store (node:sqlite) before serving, unless the
    // app called setCacheStore itself. The default db lives in THIS project's .denext
    // (not the launcher's cwd), so separate apps never share/poison one cache. Fails safe
    // to the in-memory store.
    await resolveDefaultCacheStore(
      paths.config?.cache?.path
        ? paths.config.cache
        : { ...paths.config?.cache, path: join(paths.outDir, "cache.db") },
    );

    const appHandler = createApp({
      getManifest: () => manifest,
      load,
      publicDir: paths.publicDir,
      clientEntryFor,
      styleHrefsFor,
      matchExternal: getPluginRequestHandler(),
      getMiddleware: () => middlewareRunner,
      onRequestError: instrumentation.onRequestError,
      i18n: paths.i18n ?? undefined,
      basePath: paths.config?.basePath,
      trailingSlash: paths.config?.trailingSlash,
      redirects: rules.redirects,
      rewrites: rules.rewrites,
      headerRules: rules.headers,
      pageCache: new PageCache(), // ISR for routes opting in via revalidate/dynamic
      flight: flightRoutes.size > 0,
      appDir: paths.appDir,
      flightRoutes,
      flightClients: boundary?.client,
      flightServers: boundary?.server,
      cacheComponents: paths.config?.experimental?.cacheComponents,
      csp: paths.config?.csp,
      streaming: resolveStreaming(paths.config),
      hsts: paths.config?.hsts,
      publicEnvKeys,
    });

    // Live Server Components: mount the WebSocket hub for `<Live>` pushes. Only
    // Flight routes can carry a `<Live>` boundary, so skip it otherwise. Strict
    // same-origin handshake — the socket's own cookies still gate every push.
    if (flightRoutes.size > 0) {
      installLiveHub({
        appHandler,
        originAllowed: (req) => {
          const origin = req.headers.get("origin");
          const host = req.headers.get("host");
          if (!origin || !host) return false;
          try {
            return new URL(origin).host === host;
          } catch {
            return false;
          }
        },
        config: resolveLive(paths.config),
      });
    }

    // L5: framework-served responses (health, self-hosted fonts, image optimizer,
    // client assets) bypass createApp's finalize(), so they'd otherwise ship without
    // the default hardening headers (notably X-Content-Type-Options: nosniff). Each
    // branch applies the same set here (directly, or via serveImmutableAsset). HSTS is
    // added only over HTTPS; these endpoints sit in front of any proxy-header trust
    // logic, so we key off the connection scheme alone. Returns null when the request
    // is not a framework endpoint, so the caller falls through to the app handler.
    // Liveness probe (for load balancers / k8s). Always 200 — the site serves even
    // when the cache backend is down (reads degrade to live renders) — but the body
    // reports cache reachability so operators aren't blind to an outage.
    const healthResponse = async (secure: boolean): Promise<Response> => {
      const cache = (await cacheStoreHealthy()) ? "ok" : "degraded";
      return applyDefaultSecurityHeaders(
        Response.json({ status: "ok", cache }, { status: 200 }),
        secure,
        paths.config?.hsts,
      );
    };

    const serveFrameworkEndpoint = async (
      request: Request,
      url: URL,
      secure: boolean,
    ): Promise<Response | null> => {
      const hstsCfg = paths.config?.hsts;
      if (url.pathname === "/_denext/health") return await healthResponse(secure);
      // Self-hosted Google fonts (build-emitted under client/_fonts), immutable.
      if (url.pathname.startsWith(FONTS_PUBLIC_PREFIX + "/")) {
        const rel = url.pathname.slice(FONTS_PUBLIC_PREFIX.length);
        return serveImmutableAsset(join(clientDir, "_fonts"), rel, request, secure, hstsCfg);
      }
      // Built-in image optimization endpoint.
      if (url.pathname === IMAGE_ENDPOINT) {
        const res = await optimizeImage(
          request,
          imageOptionsFromConfig(paths.config?.images, paths.publicDir),
        );
        return applyDefaultSecurityHeaders(res, secure, hstsCfg);
      }
      // Client assets may be requested under basePath; strip it before matching.
      let assetPath = url.pathname;
      if (basePath && assetPath.startsWith(basePath)) assetPath = assetPath.slice(basePath.length);
      if (assetPath.startsWith(CLIENT_PREFIX)) {
        const rel = assetPath.slice(CLIENT_PREFIX.length);
        return serveImmutableAsset(clientDir, "/" + rel, request, secure, hstsCfg, "// not found");
      }
      return null;
    };

    const handler = async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      // Live Server Components WebSocket upgrade (long-lived; handled outside
      // createApp to dodge the per-request timeout + concurrency ceiling).
      if (url.pathname === LIVE_ENDPOINT && flightRoutes.size > 0) {
        return handleLiveUpgrade(request);
      }
      const secure = url.protocol === "https:";
      return (await serveFrameworkEndpoint(request, url, secure)) ?? appHandler(request);
    };

    const server = serveWithPortFallback(
      {
        port: options.port ?? 3000,
        hostname: options.hostname ?? "0.0.0.0",
        signal: options.signal,
        strict: options.strictPort,
        shutdownDrainMs: resolveShutdownDrainMs(options.shutdownDrainMs),
        onListen: options.onListen ??
          (({ hostname, port }) =>
            console.log(`denext start ▸ http://${displayHost(hostname)}:${port}`)),
      },
      handler,
    );
    // Run plugin teardowns once the server has drained (signal aborted → closed).
    server.finished.then(() => runPluginTeardown());
    return server;
  } catch (err) {
    await runPluginTeardown();
    throw err;
  }
}
