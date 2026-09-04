// SPA mode dev server: bundle the entry on demand (rebundled on file change), serve the
// HTML shell for every navigation, and live-reload over SSE. No SSR, no route manifest —
// one bundle (or the unbundled module graph) + a shell + a file watcher.

import { displayHost, serveWithPortFallback } from "../../server/serve-utils.ts";
import { createSpaDevHandler } from "./dev-handler.ts";
import { createSpaDevState, type SpaDevServerOptions } from "./dev-state.ts";
import { watch } from "./dev-watch.ts";

/** Start the SPA dev server for `options.paths`. */
export function startSpaDevServer(options: SpaDevServerOptions): Deno.HttpServer {
  (globalThis as { __denextDev?: boolean }).__denextDev = true;
  const st = createSpaDevState(options);
  watch(st);
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
              `  entry ${st.spa.entry}\n`,
          )),
    },
    createSpaDevHandler(st),
  );
}
