import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { displayHost, isContentHashed, serveWithPortFallback } from "../src/server/serve-utils.ts";

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

/**
 * A server on a port the OS picked (never a fixed one: the parallel pass runs other servers),
 * and that port.
 */
function onAnyPort(): { server: Deno.HttpServer; port: number } {
  let port = -1;
  const server = serveWithPortFallback({ port: 0, onListen: (addr) => (port = addr.port) }, ok);
  assert(port > 0);
  return { server, port };
}

Deno.test("falls back to the next port when the first is in use", async () => {
  // Occupy a port first.
  const { server: a, port: first } = onAnyPort();

  // A second server on the same port falls back to a later one (the next free one: the port right
  // after may be another process's).
  let second = -1;
  const b = serveWithPortFallback(
    { port: first, onListen: ({ port }) => (second = port) },
    ok,
  );
  assert(second > first, `fell back to ${second} from ${first}`);

  await a.shutdown();
  await b.shutdown();
});

Deno.test("strict mode fails immediately on an in-use port (no fallback)", async () => {
  const { server: a, port: first } = onAnyPort();

  let threw = false;
  let boundElsewhere = false;
  try {
    const b = serveWithPortFallback({ port: first, strict: true }, ok);
    boundElsewhere = true;
    await b.shutdown();
  } catch (e) {
    threw = e instanceof Deno.errors.AddrInUse;
  }
  assertEquals(threw, true);
  assertEquals(boundElsewhere, false); // never fell back to the next port

  await a.shutdown();
});

Deno.test("throws AddrInUse when no port is free within the range", async () => {
  // Fill two adjacent ports: one the OS picked, and the one after it (another pick when that one
  // is someone else's).
  const servers: Deno.HttpServer[] = [];
  let base = -1;
  for (let attempt = 0; attempt < 20 && base < 0; attempt++) {
    const { server, port } = onAnyPort();
    try {
      servers.push(server, serveWithPortFallback({ port: port + 1, maxAttempts: 1 }, ok));
      base = port;
    } catch (e) {
      if (!(e instanceof Deno.errors.AddrInUse)) throw e;
      servers.length = 0;
      await server.shutdown();
    }
  }
  assert(base > 0, "no two adjacent free ports in 20 tries");

  let threw = false;
  try {
    serveWithPortFallback({ port: base, maxAttempts: 2 }, ok);
  } catch (e) {
    threw = e instanceof Deno.errors.AddrInUse;
  }
  assertEquals(threw, true);

  for (const s of servers) await s.shutdown();
});

// ---- graceful-shutdown drain deadline --------------------------------------
// `installDrainDeadline` itself is tests/serve-drain-deadline.vitest.ts (fake clock).

Deno.test("serveWithPortFallback: a signal wires the drain deadline (no hang on clean shutdown)", async () => {
  // With no in-flight requests, aborting the signal drains immediately and the deadline is
  // cancelled, never tripping — proving the wiring doesn't force-exit a clean shutdown. The
  // deadline is far longer than the test, and the timer calls are watched to see it armed and
  // then cleared: waiting out a short one instead failed whenever a loaded machine stalled the
  // process for longer than it between the abort and the drain.
  const DRAIN_MS = 60_000;
  const armed: unknown[] = [];
  const cleared = new Set<unknown>();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) => {
    const id = realSetTimeout(fn, ms, ...args);
    if (ms === DRAIN_MS) armed.push(id);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id?: number) => {
    cleared.add(id);
    realClearTimeout(id);
  }) as typeof clearTimeout;
  const controller = new AbortController();
  let bound = -1;
  let timedOut = false;
  try {
    const server = serveWithPortFallback(
      {
        port: 0,
        signal: controller.signal,
        onListen: ({ port }) => (bound = port),
        shutdownDrainMs: DRAIN_MS,
        onDrainTimeout: () => (timedOut = true), // inject instead of Deno.exit
      },
      ok,
    );
    assertNotEquals(bound, -1);
    controller.abort(); // no in-flight requests → shutdown drains at once
    await server.finished; // resolves once drained
    assertEquals(armed.length, 1, "the abort armed the drain deadline");
    // The deadline is cancelled once the drain settles (a promise turn after it, at most).
    for (let i = 0; i < 100 && !cleared.has(armed[0]); i++) await delay(1);
    assert(cleared.has(armed[0]), "a clean drain cancels the deadline (no forced exit)");
    assert(!timedOut);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

Deno.test("isContentHashed: esbuild / deno bundle `name-HASH` names, never an unhashed name", () => {
  for (
    const hashed of [
      "chunk-AB12CD34.js", // esbuild's shared chunk
      "chunk-ab12cd34.js",
      "lazy-VXRX55NY.js", // `deno bundle`'s split module: base32, not hex
      "assets/lazy-VXRX55NY.js",
      "logo-QWERTY23.svg", // a `?url` / file-loader asset
      "assets/inter-latin-WX2Y4Z6A.woff2",
      "route-ABCDEFGH.css", // an all-letter base32 hash
      "app-0123abcd.js", // hex
      "inter-0123456789ab.woff2",
      "k3j4h5g6.woff2", // a self-hosted font
    ]
  ) assert(isContentHashed(hashed), hashed);
  for (
    const plain of [
      "index.js",
      "index.css",
      "app_home.js",
      "my-component.js",
      "vendor-react.js",
      "page-about.js",
      "blog__catchall_slug.js",
      "logo.svg",
      "lazy-vxrx55ny.js", // lowercase: not a base32 hash
      "lazy-VXRX55N.js", // 7 characters
      "lazy-VXRX55NYZ.js", // 9 characters
      "lazy-VXRX55N1.js", // 1 is not base32
      "-VXRX55NY.js", // no name
      "unbundled.css",
    ]
  ) assert(!isContentHashed(plain), plain);
});
