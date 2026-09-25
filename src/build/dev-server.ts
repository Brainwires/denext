// Development server: SSR + on-demand client bundling + live reload.
//
// `startDevServer` wires the stages under `./dev-server/` around one shared `DevState`:
// assets (CSS + transform maps), the next-compat build, the route manifest + Flight
// boundary, the client bundles, the live-reload channel, the dev-only endpoints, the file
// watcher, and the request handler over the `createApp` handler.

import { join } from "@std/path";
import { runPluginTeardown } from "../plugin/mod.ts";
import { setImageRuntimeConfig } from "../runtime/image.ts";
import { displayHost, serveWithPortFallback } from "../server/serve-utils.ts";
import { captureConsole } from "./dev-events.ts";
import { startSpaDevServer } from "./spa.ts";
import { isCompat } from "./dev-server/compat.ts";
import { createDevApp } from "./dev-server/dev-app.ts";
import { createDevHandler } from "./dev-server/handler.ts";
import { createDevLoader } from "./dev-server/loaders.ts";
import { getManifest } from "./dev-server/manifest.ts";
import { createDevState, type DevServerOptions, type DevState } from "./dev-server/state.ts";
import { watch } from "./dev-server/watch.ts";
import { effectiveDevOrigins } from "./dev-server/lan.ts";

export type { DevServerOptions } from "./dev-server/state.ts";
export { DEV_RELOAD_SCRIPT } from "./dev-server/reload-script.ts";
export { devOriginAllowed, editorCommand } from "./dev-server/dev-endpoints.ts";

/**
 * Publish the running dev server's address to `.denext/dev.json` so the MCP live tools
 * (and any localhost reader) can discover it and read /_denext/dev-state. Removed on drain.
 *
 * `origin` is the address a reader on THIS machine uses: a wildcard bind (`0.0.0.0`, `::`)
 * listens on loopback too, so it is published as `127.0.0.1` — the MCP tools and `denext ui`
 * accept only a loopback origin from this file. `hostname` is the bind exactly as given, so a
 * deliberate `--host 0.0.0.0` is not reported as a loopback-only server, and `devOrigins`
 * lists the other hosts the origin gate lets in (what a device on the LAN can use).
 */
function writeDevInfo(st: DevState, info: { hostname: string; port: number }): void {
  const wildcard = info.hostname === "0.0.0.0" || info.hostname === "::";
  const host = wildcard ? "127.0.0.1" : info.hostname;
  try {
    Deno.mkdirSync(st.paths.outDir, { recursive: true });
    Deno.writeTextFileSync(
      join(st.paths.outDir, "dev.json"),
      JSON.stringify({
        origin: `http://${host}:${info.port}`,
        port: info.port,
        hostname: info.hostname,
        devOrigins: st.allowedDevOrigins,
        pid: Deno.pid,
        startedAt: Date.now(),
      }),
    );
  } catch { /* best-effort — a read-only FS just means no MCP discovery */ }
}

/** Serve the dev app, publishing the address on listen and cleaning up on stop. */
function serveDev(st: DevState, handler: (request: Request) => Promise<Response>): Deno.HttpServer {
  const { options, paths } = st;
  // Capture the dev process's own console into the black box — only when asked (the real
  // `denext dev` CLI), never for an embedded/parallel server (globalThis.console is global).
  const restoreConsole = options.captureServerConsole
    ? captureConsole(globalThis.console, (e) => st.devEvents.record(e))
    : null;
  const server = serveWithPortFallback({
    port: options.port ?? 3000,
    hostname: options.hostname ?? "localhost",
    signal: options.signal,
    strict: options.strictPort,
    onListen: (info) => {
      writeDevInfo(st, info);
      if (options.onListen) options.onListen(info);
      else {
        console.log(
          `\n  denext dev  ▸  http://${displayHost(info.hostname)}:${info.port}\n` +
            `  watching ${paths.appDir}\n`,
        );
      }
    },
  }, handler);
  // Restore console and drop the stale dev-info file. Runs on drain AND on an
  // `options.signal` abort (the usual Ctrl-C stop under a controller), so `.denext/dev.json`
  // doesn't linger pointing at a dead server. Idempotent — safe to run on both paths.
  const cleanup = () => {
    restoreConsole?.();
    try {
      Deno.removeSync(join(paths.outDir, "dev.json"));
    } catch { /* already gone */ }
  };
  options.signal?.addEventListener("abort", cleanup, { once: true });
  server.finished.then(() => {
    runPluginTeardown();
    cleanup();
  });
  return server;
}

/** Start the development server for the project described by `options.paths`. */
export function startDevServer(given: DevServerOptions): Deno.HttpServer {
  const { paths } = given;
  // The config's `allowedDevOrigins`, the programmatic / `--allowed-dev-origin` ones, and the
  // host an explicit `--host` / `--lan` bind names: one list both dev servers gate on.
  const options: DevServerOptions = {
    ...given,
    allowedDevOrigins: effectiveDevOrigins(
      [paths.config?.allowedDevOrigins, given.allowedDevOrigins],
      given.hostname,
    ),
  };
  // Configure the `<Image>` runtime from `images` config (see prod-server for details).
  setImageRuntimeConfig({
    unoptimized: paths.config?.images?.unoptimized ?? false,
    deviceSizes: paths.config?.images?.deviceSizes,
    imageSizes: paths.config?.images?.imageSizes,
  });
  // SPA mode ("React but not Next"): no `app/` routes — bundle a single client entry,
  // serve the HTML shell for every navigation, live-reload over SSE.
  if (paths.config?.mode === "spa") {
    return startSpaDevServer({
      paths,
      port: options.port,
      hostname: options.hostname,
      signal: options.signal,
      onListen: options.onListen,
      strictPort: options.strictPort,
      allowedDevOrigins: options.allowedDevOrigins,
    });
  }
  // Mark this (dev) process as a dev build so server-side render passes emit the same
  // developer warnings the browser bundle does (dangerouslySetInnerHTML, dangerous URL
  // schemes). Production `start` never runs this module, so it stays off there. Mirrors
  // the `window.__denextDev = true` set in the client script.
  (globalThis as { __denextDev?: boolean }).__denextDev = true;

  const st = createDevState(options);
  st.load = createDevLoader(st, () => getManifest(st), () => isCompat(st));
  // A query-less twin used only to tag `"use client"` boundaries, so the tagged module
  // instance matches the (query-less) one a page transitively imports at render.
  st.tagLoad = createDevLoader(st, () => getManifest(st), () => isCompat(st), { bust: false });
  const appHandler = createDevApp(st);
  // Watch app + public dirs and invalidate on change (closes cleanly on shutdown).
  void watch(st);
  return serveDev(st, createDevHandler(st, appHandler));
}
