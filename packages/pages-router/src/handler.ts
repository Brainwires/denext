// The Pages Router request handler: match a request against the scanned routes and
// serve it. Registered as the plugin's claim-hook, so it runs only after the App
// Router failed to match — returning `null` for anything it doesn't own.
//
// Besides HTML pages and `pages/api/*`, the handler answers two client-hydration
// concerns: it serves the browser bundles under `/_denext/pages/` (via the
// bundler) and responds to soft-navigation **data** requests (marked with the
// `x-denext-pages-data` header) with JSON — the page's props + the URL of its
// code-split entry — instead of HTML. The stages live under `handler/`: `shared`
// (types + response helpers), `data` (gSSP/gSP/getInitialProps), `render` (HTML,
// data, prefetch and error responses), `prerendered` (SSG files + ISR) and `handle`
// (the request dispatcher).

import { createHandle } from "./handler/handle.ts";
import { createHandlerState, type HandlerOptions } from "./handler/shared.ts";

export type { HandlerOptions };

/**
 * Create the Pages Router request handler. Returns a function suitable for a
 * plugin's `addRequestHandler`: it resolves a page route to an HTML {@link Response},
 * serves client bundles + soft-nav data, or `null` when nothing matches.
 */
export function createPagesHandler(
  opts: HandlerOptions,
): (request: Request) => Promise<Response | null> {
  return createHandle(createHandlerState(opts));
}
