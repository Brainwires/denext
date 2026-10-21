// Production server: serve SSR pages plus the pre-built client bundles.
//
// {@linkcode startProdServer} is `denext start`'s entry: a SPA goes to its own server (./spa.ts),
// every other app to the App Router server in ./prod-server/start.ts, whose stages live under
// `./prod-server/`: `manifest` (the build manifest, the Flight boundary, the complete-build
// check), `assets` (client entry + stylesheet URLs), `app` (loader, middleware, instrumentation,
// cache store, `createApp`, the Live hub) and `handler` (the framework endpoints in front of the
// app).

import { resolveProject } from "./paths.ts";
import { startSpaProdServer } from "./spa.ts";
import {
  configureImageRuntime,
  type ProdServerOptions,
  startAppProdServer,
} from "./prod-server/start.ts";
import { startupCompile } from "./prod-server/startup-compile.ts";

export type { ProdServerOptions };

/** Start the production server for the built project at `options.projectDir`. */
export async function startProdServer(options: ProdServerOptions): Promise<Deno.HttpServer> {
  const paths = await resolveProject(options.projectDir);
  // SPA mode ("React but not Next"): serve the built client bundle + HTML shell
  // (history-API fallback) — no route manifest, no SSR.
  if (paths.config?.mode === "spa") {
    configureImageRuntime(paths);
    return await startSpaProdServer(options);
  }
  return await startAppProdServer(options, paths, startupCompile);
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
