// `src/ui/jsr.ts`'s per-request deadline is time the request has to reach the network, not time
// the process spent before it could dial. A real `fetch` dials only when the event loop next
// polls it; a loop that is busy (or a process starved of CPU) past the deadline used to abort the
// request before it ever left, so a search on a loaded machine failed as "timed out" with no
// connection made. Served from a LOOPBACK server; no network.

import { assertEquals } from "@std/assert";
import { searchJsr } from "../src/ui/jsr.ts";

/** Keep the event loop busy for `ms` without yielding. */
function busy(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* no turn of the event loop */ }
}

Deno.test("a search whose loop is busy past the deadline still dials, then gets its full deadline", async () => {
  let connections = 0;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => {
      connections++;
      return Response.json({ items: [], total: 0 });
    },
  );
  const base = `http://127.0.0.1:${server.addr.port}`;
  // Every request goes to the loopback server through the global fetch (a real dial).
  const loopback = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return fetch(base + url.pathname + url.search, init);
  }) as typeof fetch;
  try {
    const pending = searchJsr("denext", { fetch: loopback, timeoutMs: 200 });
    busy(400); // the process gets no turn until well past the 200 ms deadline
    const result = await pending;
    assertEquals(connections, 1, "the request reached the server");
    assertEquals(result.ok, true, JSON.stringify(result));
  } finally {
    await server.shutdown();
  }
});
