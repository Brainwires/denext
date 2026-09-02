// In-process integration for the DEV server's BUNDLED client path (DENEXT_DEV_UNBUNDLED=0):
// the on-demand per-route `deno bundle` (src/build/dev-server.ts getRouteBundle +
// src/build/bundle.ts bundleRoute/entryCode), the app-wide flight entry, and the split-chunk
// endpoint. This complements dev-server-integration.test.ts, which exercises the default-on
// unbundled path — here we cover the other branch of clientEntryFor / the route.js handler.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { startDevOnDir } from "./e2e/harness.ts";

const HELLO = new URL("../examples/hello", import.meta.url).pathname;

Deno.test({
  name: "dev server (bundled path) builds per-route client bundles on demand",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  // Bundled mode is selected per-server (not via the process-global DENEXT_DEV_UNBUNDLED),
  // so this stays correct when it runs in parallel with the unbundled-default dev-server test.
  const server = await startDevOnDir(HELLO, { DENEXT_DEV_TYPECHECK: "0" }, {
    unbundled: false,
  });

  try {
    await t.step("the shell hydrates from the bundled /_denext/route.js entry", async () => {
      const html = await (await fetch(server.origin + "/")).text();
      assertStringIncludes(html, "/_denext/route.js?p=");
      // The unbundled @entry module must NOT be used when the loop is opted out.
      assert(!html.includes("/_denext/@entry"), "bundled path must not emit @entry");
    });

    let routeJs = "";
    await t.step("GET /_denext/route.js?p=/ bundles + serves the route entry", async () => {
      const res = await fetch(server.origin + "/_denext/route.js?p=" + encodeURIComponent("/"));
      assertEquals(res.status, 200);
      assertStringIncludes(res.headers.get("content-type") ?? "", "javascript");
      routeJs = await res.text();
      assert(routeJs.length > 0, "bundle is non-empty");
      // A second hit is served from the in-memory bundle cache (same bytes).
      const again = await fetch(server.origin + "/_denext/route.js?p=" + encodeURIComponent("/"));
      assertEquals(await again.text(), routeJs);
    });

    await t.step(
      "a split chunk referenced by the entry is served from the chunk cache",
      async () => {
        const m = routeJs.match(/chunk-[A-Za-z0-9_]+\.js/);
        if (!m) return; // no dynamic-import chunk in this route — nothing to assert
        const res = await fetch(server.origin + "/_denext/" + m[0]);
        assertEquals(res.status, 200);
        assertStringIncludes(res.headers.get("content-type") ?? "", "javascript");
        assert((await res.text()).length > 0);
      },
    );

    await t.step("GET /_denext/flight.js serves the bundled flight entry", async () => {
      const res = await fetch(server.origin + "/_denext/flight.js");
      assertEquals(res.status, 200);
      assertStringIncludes(res.headers.get("content-type") ?? "", "javascript");
      await res.text();
    });

    await t.step("GET /_denext/route.js for an unknown route is a 404", async () => {
      const res = await fetch(server.origin + "/_denext/route.js?p=" + encodeURIComponent("/nope"));
      assertEquals(res.status, 404);
      assertStringIncludes(await res.text(), "route not found");
    });

    await t.step("the bundled route still renders + hydrates its app routes", async () => {
      const about = await fetch(server.origin + "/about");
      assertEquals(about.status, 200);
      assertStringIncludes(await about.text(), "/_denext/route.js?p=");
    });
  } finally {
    await server.close();
  }
});
