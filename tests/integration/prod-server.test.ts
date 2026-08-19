// Prod-server framework endpoints, end to end. The prod `handler` wraps createApp
// and serves the health probe, the image optimizer, and client assets itself —
// paths that bypass createApp's finalize(), so it must apply the default hardening
// headers (the L5 fix) on each. Build a copy of examples/hello, serve it with the
// real prod server, and assert those endpoints behave and are hardened.
//
// The app is copied to a sibling dir under examples/ (so its `../../mod.ts` imports
// still resolve) and built there in isolation from the parallel suite.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { join } from "@std/path";
import { build } from "../../src/build/build.ts";
import { startProdServer } from "../../src/build/prod-server.ts";

const SOURCE = new URL("../../examples/hello", import.meta.url).pathname;
const APP = new URL("../../examples/.hello-prod-test", import.meta.url).pathname;

Deno.test({
  name: "prod server: framework endpoints behave and carry hardening headers",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  await Deno.remove(APP, { recursive: true }).catch(() => {});
  await copy(SOURCE, APP, { overwrite: true });
  await Deno.remove(join(APP, ".denext"), { recursive: true }).catch(() => {});

  const controller = new AbortController();
  let server: Deno.HttpServer | undefined;
  try {
    await build(APP);

    const { promise, resolve } = Promise.withResolvers<{ hostname: string; port: number }>();
    server = await startProdServer({
      projectDir: APP,
      port: 0,
      hostname: "127.0.0.1",
      signal: controller.signal,
      onListen: (info) => resolve(info),
    });
    const { hostname, port } = await promise;
    const origin = `http://${hostname}:${port}`;

    await t.step("health probe reports status + cache reachability, hardened", async () => {
      const res = await fetch(`${origin}/_denext/health`);
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("x-content-type-options"), "nosniff");
      const body = await res.json();
      assertEquals(body.status, "ok");
      assert(body.cache === "ok" || body.cache === "degraded", "reports cache reachability");
    });

    await t.step("image endpoint rejects a request with no url (400), hardened", async () => {
      const res = await fetch(`${origin}/_denext/image`);
      assertEquals(res.status, 400);
      assertEquals(res.headers.get("x-content-type-options"), "nosniff");
      await res.body?.cancel();
    });

    await t.step("a missing client asset is a hardened 404", async () => {
      const res = await fetch(`${origin}/_denext/client/does-not-exist.js`);
      assertEquals(res.status, 404);
      assertEquals(res.headers.get("x-content-type-options"), "nosniff");
      assertStringIncludes(await res.text(), "not found");
    });

    await t.step("a real page renders with the default hardening headers", async () => {
      const res = await fetch(`${origin}/`);
      assertEquals(res.status, 200);
      assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
      assertEquals(res.headers.get("x-content-type-options"), "nosniff");
      assertEquals(res.headers.get("x-frame-options"), "SAMEORIGIN");
      assertStringIncludes(await res.text(), "<!DOCTYPE html>");
    });

    await t.step("HEAD on a page returns headers with no body", async () => {
      const res = await fetch(`${origin}/`, { method: "HEAD" });
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("x-content-type-options"), "nosniff");
      assertEquals(await res.text(), "");
    });

    await t.step("an unknown route is a 404", async () => {
      const res = await fetch(`${origin}/definitely/not/a/route`);
      assertEquals(res.status, 404);
      await res.body?.cancel();
    });
  } finally {
    controller.abort();
    await server?.finished;
    await Deno.remove(APP, { recursive: true }).catch(() => {});
  }
});
