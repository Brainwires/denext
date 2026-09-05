// Production server: serve SSR pages plus the pre-built client bundles.
//
// The stages live under `./prod-server/`: `manifest` (the build manifest, the Flight
// boundary, the complete-build check), `assets` (client entry + stylesheet URLs), `app`
// (loader, middleware, instrumentation, cache store, `createApp`, the Live hub) and
// `handler` (the framework endpoints in front of the app). This module runs them in order.

import { uninstallLiveHub } from "../server/live.ts";
import { envGet } from "../runtime/env-safe.ts";
import { join } from "@std/path";
import { applyPlugins, runPluginTeardown } from "../plugin/mod.ts";
import { scanRoutes } from "../router/manifest.ts";
import { setImageRuntimeConfig } from "../runtime/image.ts";
import { defaultLoader } from "../server/mod.ts";
import { displayHost, serveWithPortFallback } from "../server/serve-utils.ts";
import { type ProjectPaths, resolveProject } from "./paths.ts";
import { dirExists } from "./pipeline-shared.ts";
import { createProdApp } from "./prod-server/app.ts";
import { assetResolvers } from "./prod-server/assets.ts";
import { createProdHandler } from "./prod-server/handler.ts";
import {
  assertBuildComplete,
  readBuildInfo,
  resolveFlightBoundary,
} from "./prod-server/manifest.ts";
import { startSpaProdServer } from "./spa.ts";

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
  const env = envGet("DENEXT_SHUTDOWN_DRAIN_MS");
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_SHUTDOWN_DRAIN_MS;
}

/**
 * Fail fast if an App Router build hasn't run. A Pages Router app (no `app/` tree) has
 * no App Router client dir — its plugin owns the build output (`.denext/pages-*`) and
 * serves via `matchExternal` — so the check is skipped for it.
 */
async function assertBuilt(paths: ProjectPaths, clientDir: string): Promise<void> {
  if (!(await dirExists(paths.appDir))) return;
  try {
    await Deno.stat(clientDir);
  } catch {
    throw new Error(`No build output at ${clientDir}. Run \`denext build\` first.`);
  }
}

/** Build the prod request handler for an App Router project (plugins already applied). */
async function buildHandler(paths: ProjectPaths, clientDir: string) {
  const manifest = await scanRoutes(paths.appDir);
  const info = await readBuildInfo(paths);
  const flight = await resolveFlightBoundary(paths, manifest, info);
  await assertBuildComplete(clientDir, manifest, flight.flightRoutes, info.staticRoutes);
  const assets = await assetResolvers(
    paths,
    clientDir,
    manifest,
    flight.flightRoutes,
    info.staticRoutes,
  );
  const appHandler = await createProdApp(paths, manifest, info, flight, assets);
  return createProdHandler(
    paths,
    clientDir,
    assets.basePath,
    flight.flightRoutes.size > 0,
    appHandler,
  );
}

/** Start the production server for the built project at `options.projectDir`. */
export async function startProdServer(options: ProdServerOptions): Promise<Deno.HttpServer> {
  const paths = await resolveProject(options.projectDir);
  // Configure the `<Image>` runtime from `images` config so SSR renders optimizer URLs
  // with allowlist-correct widths (or plain `<img>` when `images.unoptimized`).
  setImageRuntimeConfig({
    unoptimized: paths.config?.images?.unoptimized ?? false,
    deviceSizes: paths.config?.images?.deviceSizes,
    imageSizes: paths.config?.images?.imageSizes,
  });
  // SPA mode ("React but not Next"): serve the built client bundle + HTML shell
  // (history-API fallback) — no route manifest, no SSR.
  if (paths.config?.mode === "spa") return await startSpaProdServer(options);

  const clientDir = join(paths.outDir, "client");
  await assertBuilt(paths, clientDir);
  // Set up plugins before scanning so route-synthesizer plugins register in time.
  await applyPlugins({
    projectRoot: paths.projectDir,
    appDir: paths.appDir,
    config: paths.config ?? {},
    mode: "prod",
    load: defaultLoader,
  });
  // If startup fails AFTER plugins were applied (missing build, port in use, …), run
  // their teardown hooks before rethrowing — otherwise an embedded caller that starts
  // denext in-process leaks plugin-held resources on a failed boot. On the success path
  // teardown runs via `server.finished`.
  try {
    const handler = await buildHandler(paths, clientDir);
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
    // Live WebSockets never close on their own, so a drain would always run to its deadline
    // (and force-exit) with a single viewer connected: close them the moment shutdown begins.
    options.signal?.addEventListener("abort", uninstallLiveHub, { once: true });
    // Run plugin teardowns once the server has drained (signal aborted → closed).
    server.finished.then(() => runPluginTeardown());
    return server;
  } catch (err) {
    await runPluginTeardown();
    throw err;
  }
}
