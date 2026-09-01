// Runtime client/server boundary guards (the server-only / client-only packages'
// equivalent). These throw when a module is loaded in the wrong environment; the
// wrong-side throw is the whole point, so it gets direct coverage.

import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { clientOnly, isServer, serverOnly } from "../src/runtime/environment.ts";

// The test runner has no `document`, so this environment is "the server".

Deno.test("isServer() is true when there is no DOM document", () => {
  assertEquals(typeof document, "undefined");
  assertEquals(isServer(), true);
});

Deno.test("serverOnly() is a no-op on the server", () => {
  serverOnly(); // must not throw
  serverOnly("SecretsModule"); // labeled form also fine on the server
});

Deno.test("clientOnly() throws on the server, naming the module in the message", () => {
  const err = assertThrows(() => clientOnly("BrowserWidget"), Error);
  assertStringIncludes((err as Error).message, "client-only");
  assertStringIncludes((err as Error).message, "BrowserWidget");
});

Deno.test("serverOnly() throws in a browser-like environment", () => {
  // Simulate the client by defining a global `document`, then assert serverOnly
  // fails fast (as it would when a server-only module is bundled into the client).
  const g = globalThis as { document?: unknown };
  const had = "document" in g;
  g.document = {};
  try {
    const err = assertThrows(() => serverOnly("DbModule"), Error);
    assertStringIncludes((err as Error).message, "server-only");
    assertStringIncludes((err as Error).message, "DbModule");
    // ...and clientOnly is the no-op in this environment.
    clientOnly();
  } finally {
    if (!had) delete g.document;
  }
});

// ---- the compat `server-only` / `client-only` MODULES (import side effects) --

Deno.test("compat `server-only` module throws when evaluated in a client runtime", async () => {
  const g = globalThis as { document?: unknown };
  const had = "document" in g;
  g.document = {};
  try {
    // Cache-bust the URL so the module re-evaluates its import-time guard.
    await assertRejects(
      () => import(`../src/compat/server-only.ts?client=${Math.random()}`),
      Error,
      "server-only",
    );
  } finally {
    if (!had) delete g.document;
  }
});

Deno.test("compat `client-only` module is inert on the server (SSR renders client components)", async () => {
  // No `document` here (server). client-only must NOT throw — denext SSRs client
  // components, so their `import "client-only"` runs server-side legitimately.
  await import(`../src/compat/client-only.ts?server=${Math.random()}`);
});
