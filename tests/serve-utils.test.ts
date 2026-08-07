import { assertEquals, assertNotEquals } from "@std/assert";
import { serveWithPortFallback } from "../src/server/serve-utils.ts";

const ok = () => new Response("ok");

Deno.test("binds the requested port when it is free", async () => {
  let bound = -1;
  const server = serveWithPortFallback(
    { port: 0, onListen: ({ port }) => (bound = port) },
    ok,
  );
  // port 0 asks the OS for any free port.
  assertNotEquals(bound, -1);
  await server.shutdown();
});

Deno.test("falls back to the next port when the first is in use", async () => {
  // Occupy a fixed port first.
  let first = -1;
  const a = serveWithPortFallback(
    { port: 4599, onListen: ({ port }) => (first = port) },
    ok,
  );
  assertEquals(first, 4599);

  // A second server on the same port should fall back to 4600.
  let second = -1;
  const b = serveWithPortFallback(
    { port: 4599, onListen: ({ port }) => (second = port) },
    ok,
  );
  assertEquals(second, 4600);

  await a.shutdown();
  await b.shutdown();
});

Deno.test("throws AddrInUse when no port is free within the range", async () => {
  const servers: Deno.HttpServer[] = [];
  // Fill ports 4610 and 4611.
  servers.push(serveWithPortFallback({ port: 4610, maxAttempts: 1 }, ok));
  servers.push(serveWithPortFallback({ port: 4611, maxAttempts: 1 }, ok));

  let threw = false;
  try {
    serveWithPortFallback({ port: 4610, maxAttempts: 2 }, ok);
  } catch (e) {
    threw = e instanceof Deno.errors.AddrInUse;
  }
  assertEquals(threw, true);

  for (const s of servers) await s.shutdown();
});
