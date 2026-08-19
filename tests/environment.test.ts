// Runtime client/server boundary guards (the server-only / client-only packages'
// equivalent). These throw when a module is loaded in the wrong environment; the
// wrong-side throw is the whole point, so it gets direct coverage.

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
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
