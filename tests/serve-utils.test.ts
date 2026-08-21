import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  displayHost,
  installDrainDeadline,
  serveWithPortFallback,
} from "../src/server/serve-utils.ts";

Deno.test("displayHost renders a clickable URL host", () => {
  // Loopback / any-interface → localhost (the bare forms aren't clickable URLs).
  assertEquals(displayHost("::1"), "localhost"); // the reported IPv6 loopback
  assertEquals(displayHost("127.0.0.1"), "localhost");
  assertEquals(displayHost("0.0.0.0"), "localhost");
  assertEquals(displayHost("::"), "localhost");
  // A real IPv6 literal is bracketed so http://[…]:port is valid.
  assertEquals(displayHost("fe80::1"), "[fe80::1]");
  assertEquals(displayHost("[fe80::1]"), "[fe80::1]"); // already bracketed
  // Ordinary hosts pass through.
  assertEquals(displayHost("localhost"), "localhost");
  assertEquals(displayHost("example.com"), "example.com");
  assertEquals(displayHost("192.168.1.5"), "192.168.1.5");
});

const ok = () => new Response("ok");

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

Deno.test("strict mode fails immediately on an in-use port (no fallback)", async () => {
  let first = -1;
  const a = serveWithPortFallback(
    { port: 4620, onListen: ({ port }) => (first = port) },
    ok,
  );
  assertEquals(first, 4620);

  let threw = false;
  let boundElsewhere = false;
  try {
    const b = serveWithPortFallback({ port: 4620, strict: true }, ok);
    boundElsewhere = true;
    await b.shutdown();
  } catch (e) {
    threw = e instanceof Deno.errors.AddrInUse;
  }
  assertEquals(threw, true);
  assertEquals(boundElsewhere, false); // never fell back to 4621

  await a.shutdown();
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

// ---- graceful-shutdown drain deadline --------------------------------------

Deno.test("installDrainDeadline: fires onTimeout when the drain outlasts the deadline", async () => {
  let fired = 0;
  // A drain that never settles on its own → the deadline must trip.
  installDrainDeadline(new Promise<void>(() => {}), 20, () => fired++);
  await delay(60);
  assertEquals(fired, 1, "the deadline fired exactly once");
});

Deno.test("installDrainDeadline: does NOT fire when the drain settles first", async () => {
  let fired = 0;
  installDrainDeadline(delay(10), 50, () => fired++);
  await delay(80);
  assertEquals(fired, 0, "a completed drain cancels the deadline");
});

Deno.test("installDrainDeadline: drainMs <= 0 waits indefinitely (never fires)", async () => {
  let fired = 0;
  const cancel = installDrainDeadline(new Promise<void>(() => {}), 0, () => fired++);
  await delay(30);
  assertEquals(fired, 0);
  cancel(); // no-op, but must be callable
});

Deno.test("serveWithPortFallback: a signal wires the drain deadline (no hang on clean shutdown)", async () => {
  // With no in-flight requests, aborting the signal drains immediately and the
  // deadline never trips — proving the wiring doesn't force-exit a clean shutdown.
  const controller = new AbortController();
  let bound = -1;
  let timedOut = false;
  const server = serveWithPortFallback(
    {
      port: 0,
      signal: controller.signal,
      onListen: ({ port }) => (bound = port),
      shutdownDrainMs: 30,
      onDrainTimeout: () => (timedOut = true), // inject instead of Deno.exit
    },
    ok,
  );
  assertNotEquals(bound, -1);
  controller.abort(); // no in-flight requests → shutdown drains at once
  await server.finished; // resolves once drained
  await delay(60); // well past the 30ms deadline
  assert(!timedOut, "a clean drain cancels the deadline (no forced exit)");
});
