// TST-H1: graceful shutdown drains in-flight requests. denext passes the shutdown
// AbortSignal to Deno.serve (via serveWithPortFallback); aborting it must let an
// in-flight request finish while refusing new connections.

import { assert, assertEquals } from "@std/assert";
import { serveWithPortFallback } from "../../src/server/serve-utils.ts";

Deno.test("graceful shutdown drains an in-flight request and stops accepting new ones", async () => {
  const controller = new AbortController();

  let boundPort = 0;
  let onListenResolve!: () => void;
  const listening = new Promise<void>((r) => (onListenResolve = r));

  let slowStartedResolve!: () => void;
  const slowStarted = new Promise<void>((r) => (slowStartedResolve = r));

  const server = serveWithPortFallback(
    {
      port: 0, // ephemeral — the OS picks a free port, reported via onListen
      hostname: "127.0.0.1",
      signal: controller.signal,
      onListen: ({ port }) => {
        boundPort = port;
        onListenResolve();
      },
    },
    async (req) => {
      if (new URL(req.url).pathname === "/slow") {
        slowStartedResolve();
        await new Promise((r) => setTimeout(r, 100)); // still in flight when we abort
        return new Response("drained");
      }
      return new Response("fast");
    },
  );

  await listening;

  // Fire a slow request and wait until the handler is actually running.
  const slow = fetch(`http://127.0.0.1:${boundPort}/slow`);
  await slowStarted;

  // Shut down mid-request.
  controller.abort();

  // The in-flight request must complete (drained), not be cut off.
  const res = await slow;
  assertEquals(await res.text(), "drained");

  // A new connection after shutdown must be refused.
  let refused = false;
  try {
    const late = await fetch(`http://127.0.0.1:${boundPort}/fast`);
    await late.body?.cancel();
  } catch {
    refused = true;
  }
  assert(refused, "new connections must be refused after shutdown");

  await server.finished;
});
