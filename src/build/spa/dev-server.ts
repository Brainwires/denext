// SPA mode dev server: bundle the entry on demand (rebundled on file change), serve the
// HTML shell for every navigation, and live-reload over SSE. No SSR, no route manifest —
// one bundle (or the unbundled module graph) + a shell + a file watcher.

import { compressEncodings, compressOrPassThrough } from "../../server/compress.ts";
import { displayHost, serveWithPortFallback } from "../../server/serve-utils.ts";
import { createSpaDevHandler } from "./dev-handler.ts";
import { createSpaDevState, type SpaDevServerOptions } from "./dev-state.ts";
import { watch } from "./dev-watch.ts";
import { startSpaDevPlugins } from "./dev-plugins.ts";
import { removeDevInfo, writeDevInfo } from "../dev-server/dev-info.ts";
import { withDevTokenGate, withDevTokenParam } from "../dev-server/dev-token.ts";

/** Start the SPA dev server for `options.paths`. */
export function startSpaDevServer(options: SpaDevServerOptions): Deno.HttpServer {
  (globalThis as { __denextDev?: boolean }).__denextDev = true;
  const st = createSpaDevState(options);
  startSpaDevPlugins(st);
  watch(st);
  const handler = createSpaDevHandler(st);
  // Response compression (config `compress`, default on), as in `denext dev` for the App
  // Router: the reload SSE stream (`text/event-stream`) is never encoded.
  const encodings = compressEncodings(options.paths.config?.compress);
  const serve = encodings.length === 0
    ? handler
    : async (request: Request) => compressOrPassThrough(request, await handler(request), encodings);
  const outDir = options.paths.outDir;
  const server = serveWithPortFallback(
    {
      port: options.port ?? 3000,
      hostname: options.hostname ?? "localhost",
      signal: options.signal,
      strict: options.strictPort,
      onListen: (info) => {
        // `.denext/dev.json`, as `denext dev` writes for the App Router: what lets
        // `denext_dev_logs` find this server and read the page's console back.
        writeDevInfo(outDir, options.allowedDevOrigins ?? [], info, options.devToken);
        if (options.onListen) options.onListen(info);
        else {
          const url = withDevTokenParam(
            `http://${displayHost(info.hostname)}:${info.port}`,
            options.devToken,
          );
          console.log(`\n  denext dev (SPA)  ▸  ${url}\n  entry ${st.spa.entry}\n`);
        }
      },
    },
    withDevTokenGate(serve, options.devToken),
  );
  const cleanup = () => removeDevInfo(outDir);
  options.signal?.addEventListener("abort", cleanup, { once: true });
  server.finished.then(cleanup);
  return server;
}
