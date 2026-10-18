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
import { releaseDefaultCacheStore } from "../server/cache.ts";
import { stopServices } from "../server/service-loader.ts";
import { scanRoutes } from "../router/manifest.ts";
import { setImageRuntimeConfig } from "../runtime/image.ts";
import { loadPartytownBuild, PARTYTOWN_BUILD_DIR } from "./partytown.ts";
import type { ModuleLoader } from "../server/types.ts";
import { displayHost, installExitDeadline, serveWithPortFallback } from "../server/serve-utils.ts";
import { type Instrumentation, runShutdownHook } from "../server/instrumentation.ts";
import { type ProjectPaths, resolveProject } from "./paths.ts";
import { dirExists } from "./pipeline-shared.ts";
import { createProdApp, prodLoader } from "./prod-server/app.ts";
import { assetResolvers } from "./prod-server/assets.ts";
import { createProdHandler } from "./prod-server/handler.ts";
import {
  assertBuildComplete,
  type BuildInfo,
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
  /**
   * Exit the process once the drain deadline passes after a shutdown signal, even when an open
   * handle (an app's database pool, a timer, a socket) would keep it alive after the drain and
   * the teardowns. Set by `denext start` and a compiled app, which own their process; an embedded
   * caller leaves it off.
   */
  exitAfterShutdown?: boolean;
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
async function buildHandler(
  paths: ProjectPaths,
  clientDir: string,
  info: BuildInfo,
  load: ModuleLoader,
  loaded: { instrumentation?: Instrumentation },
) {
  const manifest = await scanRoutes(paths.appDir);
  const flight = await resolveFlightBoundary(paths, manifest, info, load);
  await assertBuildComplete(clientDir, manifest, flight.flightRoutes, info.staticRoutes);
  const assets = await assetResolvers(
    paths,
    clientDir,
    manifest,
    flight.flightRoutes,
    info.staticRoutes,
  );
  const appHandler = await createProdApp(paths, manifest, info, flight, assets, load, loaded);
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
  // `<Script strategy="worker">`: the Partytown files the build wrote, when the app turned it on.
  await loadPartytownBuild(paths.config, join(clientDir, PARTYTOWN_BUILD_DIR));
  // The server render's loader (the build's platform files and copies), which plugins render
  // through too: a Pages Router page then loads the files its client bundle was built with.
  const info = await readBuildInfo(paths);
  const load = await prodLoader(paths, info);
  // Set up plugins before scanning so route-synthesizer plugins register in time.
  await applyPlugins({
    projectRoot: paths.projectDir,
    appDir: paths.appDir,
    config: paths.config ?? {},
    mode: "prod",
    load,
  });
  // If startup fails AFTER plugins were applied (missing build, port in use, …), run
  // their teardown hooks before rethrowing — otherwise an embedded caller that starts
  // denext in-process leaks plugin-held resources on a failed boot. On the success path
  // teardown runs via `server.finished`.
  const loaded: { instrumentation?: Instrumentation } = {};
  // Once the server has drained: stop the supervised services in reverse start order (in-flight
  // requests may have used them), then the plugin teardowns (a service may still use what a
  // plugin holds open while it stops), then the app's own `onShutdown` (a pool a plugin was
  // given stays open until the plugin is done with it).
  const shutdown = async () => {
    await stopServices();
    await runPluginTeardown();
    releaseDefaultCacheStore();
    if (loaded.instrumentation) await runShutdownHook(loaded.instrumentation);
  };
  try {
    const handler = await buildHandler(paths, clientDir, info, load, loaded);
    const shutdownDrainMs = resolveShutdownDrainMs(options.shutdownDrainMs);
    const server = serveWithPortFallback(
      {
        port: options.port ?? 3000,
        hostname: options.hostname ?? "0.0.0.0",
        signal: options.signal,
        strict: options.strictPort,
        shutdownDrainMs,
        onListen: options.onListen ??
          (({ hostname, port }) =>
            console.log(`denext start ▸ http://${displayHost(hostname)}:${port}`)),
      },
      handler,
    );
    // Live WebSockets never close on their own, so a drain would always run to its deadline
    // (and force-exit) with a single viewer connected: close them the moment shutdown begins.
    options.signal?.addEventListener("abort", uninstallLiveHub, { once: true });
    const cleanedUp = server.finished.then(shutdown);
    // A handle nothing closes (an app's database pool, a timer, a socket) would keep the process
    // alive after the drain for good: at the deadline, exit anyway.
    if (options.exitAfterShutdown) {
      options.signal?.addEventListener(
        "abort",
        () => installExitDeadline(server.finished, cleanedUp, shutdownDrainMs),
        { once: true },
      );
    }
    return server;
  } catch (err) {
    await shutdown();
    throw err;
  }
}

/** A running server started on an ephemeral port. */
export interface EphemeralServer {
  /** The `http://host:port` origin it is listening on. */
  origin: string;
  /** Abort the server and wait for it to finish draining. */
  close: () => Promise<void>;
}

/**
 * Start the production server for `projectDir` on an ephemeral port (`port: 0`) bound to
 * loopback, resolving once it is listening on the real port (never assume 3000). The
 * shared engine behind the E2E harness's `buildAndServe` and the profiler's serve step.
 */
export async function serveEphemeral(projectDir: string): Promise<EphemeralServer> {
  const controller = new AbortController();
  const { promise, resolve } = Promise.withResolvers<{ hostname: string; port: number }>();
  const server = await startProdServer({
    projectDir,
    port: 0,
    hostname: "127.0.0.1",
    signal: controller.signal,
    onListen: (info) => resolve(info),
  });
  const { hostname, port } = await promise;
  return {
    origin: `http://${hostname}:${port}`,
    close: async () => {
      controller.abort();
      await server.finished;
    },
  };
}
