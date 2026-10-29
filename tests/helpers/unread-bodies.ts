// Importing this module releases, after each test of the importing file, the response bodies the
// test left unread on the handlers it wrapped with `releasingBodies`. An in-process app handler
// (`createApp`) keeps the request deadline armed until a body ends (src/server/app.ts), as a server
// does until it has delivered the body or the client has gone; a test that reads only a status
// leaves the deadline's timer (and a file body's handle) behind, which the op / resource
// sanitizers report. The hook cancels those bodies when the test ends, as a client that went away.

import { responseBodies } from "./response-bodies.ts";

const bodies = responseBodies();

Deno.test.afterEach(() => bodies.release());

/**
 * `handler`, with every response it returns released after the current test (see the module
 * header).
 *
 * @param handler An in-process request handler.
 * @returns The same handler, tracked.
 */
export function releasingBodies<A extends unknown[]>(
  handler: (...args: A) => Response | Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args) => bodies.track(await handler(...args));
}

/**
 * Track every response `fetch` returns in the importing file, released after each test as
 * above: for a suite that drives a real server over HTTP and reads only statuses and headers
 * (a redirect, a refusal), as a browser whose page went away would.
 */
export function releaseFetchBodies(): void {
  const real = globalThis.fetch;
  globalThis.fetch =
    (async (...args: Parameters<typeof fetch>) =>
      bodies.track(await real(...args))) as typeof fetch;
}
