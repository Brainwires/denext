// e2e for examples/instrumentation: proves denext's Next-style instrumentation.ts is
// auto-discovered and wired by the production server — `register()` runs once at boot,
// and `onRequestError` fires for real server-side errors (a render throw AND a Server
// Action throw), with the recorded events observable over HTTP at /telemetry.
//
// Unlike the other example e2es this needs NO network (no npm deps) — it just builds
// and serves the example in-process via the harness. Opt-in via `deno task test:e2e`;
// the createApp-level wiring is also unit-tested in tests/instrumentation.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildAndServe } from "./harness.ts";

const EXAMPLE = new URL("../../examples/instrumentation", import.meta.url).pathname;

Deno.test({
  name: "e2e: examples/instrumentation wires register() + onRequestError",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(EXAMPLE);
  try {
    await t.step("register() ran at server boot", async () => {
      const html = await (await fetch(server.origin + "/telemetry")).text();
      assertStringIncludes(html, "server booted");
    });

    await t.step("a render error reaches onRequestError (routeType render)", async () => {
      const boom = await fetch(server.origin + "/boom");
      assertEquals(boom.status, 500);
      // The client sees a redacted message, never the raw error text.
      assertStringIncludes(await boom.text(), "Internal Server Error");
      // …but instrumentation recorded the real error, tagged with the route.
      const html = await (await fetch(server.origin + "/telemetry")).text();
      assertStringIncludes(html, "render /boom");
      assertStringIncludes(html, "intentional render error");
    });

    await t.step("a Server Action error reaches onRequestError (routeType action)", async () => {
      const home = await (await fetch(server.origin + "/")).text();
      const action = home.match(/action="([^"]+)"/)?.[1];
      assert(action, "no Server Action endpoint in the form markup");
      const post = await fetch(server.origin + action, {
        method: "POST",
        headers: { "Origin": server.origin, "Content-Type": "application/x-www-form-urlencoded" },
        body: "",
        redirect: "manual",
      });
      assertEquals(post.status, 500);
      await post.body?.cancel();
      const html = await (await fetch(server.origin + "/telemetry")).text();
      assertStringIncludes(html, "intentional action error");
    });
  } finally {
    await server.close();
  }
});
