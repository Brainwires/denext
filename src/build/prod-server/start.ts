// The App Router production server: the stages under this directory (`manifest`, `assets`,
// `app`, `handler`) run in order. `denext start` reaches it through ../prod-server.ts, which sends
// a SPA to its own server; a compiled app (src/standalone/mod.ts) imports it directly, so the
// binary's module graph holds the server and none of the SPA server's build tooling.

import { liveViewStoreSettled, uninstallLiveHub } from "../../server/live.ts";
import { envGet } from "../../runtime/env-safe.ts";
import { join } from "@std/path";
import { applyPlugins, runPluginTeardown } from "../../plugin/mod.ts";
import { releaseDefaultCacheStore } from "../../server/cache.ts";
import { stopServices } from "../../server/service-loader.ts";
import { checkSessionSecretAtBoot } from "../../server/session.ts";
import { scanRoutes } from "../../router/manifest.ts";
import { setImageRuntimeConfig } from "../../runtime/image.ts";
import { loadPartytownBuild, PARTYTOWN_BUILD_DIR } from "../partytown.ts";
import type { ModuleLoader } from "../../server/types.ts";
import {
  displayHost,
  installExitDeadline,
  serveWithPortFallback,
} from "../../server/serve-utils.ts";
import { type Instrumentation, runShutdownHook } from "../../server/instrumentation.ts";
import { dirExists, type ProjectPaths, resolveProject } from "../paths.ts";
import { createProdApp, prodLoader } from "./app.ts";
import { assetResolvers } from "./assets.ts";
import { createProdHandler } from "./handler.ts";
import {
  assertBuildComplete,
  type BuildInfo,
  readBuildInfo,
  resolveFlightBoundary,
  type StartupCompile,
} from "./manifest.ts";

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
  compile: StartupCompile | undefined,
) {
  const manifest = await scanRoutes(paths.appDir);
  const flight = await resolveFlightBoundary(paths, manifest, info, load, compile);
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

/**
 * Configure the `<Image>` runtime from the `images` config, so SSR renders optimizer URLs with
 * allowlist-correct widths (or a plain `<img>` when `images.unoptimized`).
 *
 * @param paths The resolved project.
 */
export function configureImageRuntime(paths: ProjectPaths): void {
  setImageRuntimeConfig({
    unoptimized: paths.config?.images?.unoptimized ?? false,
    deviceSizes: paths.config?.images?.deviceSizes,
    imageSizes: paths.config?.images?.imageSizes,
  });
}

/**
 * Start the production server for the App Router (or plugin-routed) project at
 * `options.projectDir`: the server `denext start` runs for every app but a SPA, and the one a
 * compiled app runs. It never loads the SPA server or the build tooling.
 *
 * @param options Where the project is and how to serve it.
 * @param resolved The project's resolved paths, when the caller has them.
 * @param compile What compiles at startup what an older build did not record (`denext start`
 *   passes ./startup-compile.ts; a compiled app passes none, and refuses such a build).
 * @returns The running server.
 */
export async function startAppProdServer(
  options: ProdServerOptions,
  resolved?: ProjectPaths,
  compile?: StartupCompile,
): Promise<Deno.HttpServer> {
  const paths = resolved ?? await resolveProject(options.projectDir);
  configureImageRuntime(paths);
  if (paths.config?.mode === "spa") {
    throw new Error(
      "A SPA has no App Router server: `denext start` serves it with the SPA server.",
    );
  }
  const clientDir = join(paths.outDir, "client");
  await assertBuilt(paths, clientDir);
  // A short SESSION_SECRET takes the instance out of rotation before the first request.
  checkSessionSecretAtBoot();
  // `<Script strategy="worker">`: the Partytown files the build wrote, when the app turned it on.
  await loadPartytownBuild(paths.config, join(clientDir, PARTYTOWN_BUILD_DIR));
  // The server render's loader (the build's platform files and copies), which plugins render
  // through too: a Pages Router page then loads the files its client bundle was built with.
  const info = await readBuildInfo(paths);
  const load = await prodLoader(paths, info, compile);
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
    // A view parked as its socket closed may still be writing its snapshot to the view store
    // (a plugin's shared store among them): let it land before anything is torn down.
    await liveViewStoreSettled();
    await stopServices();
    await runPluginTeardown();
    releaseDefaultCacheStore();
    if (loaded.instrumentation) await runShutdownHook(loaded.instrumentation);
  };
  try {
    const handler = await buildHandler(paths, clientDir, info, load, loaded, compile);
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
