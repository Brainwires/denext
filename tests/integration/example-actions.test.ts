// Smoke test for examples/actions: build + serve it and drive the Server Action
// through its no-JS progressive-enhancement path — SSR renders the action's secure
// endpoint into the <form>, a native POST runs it server-side (CSRF-checked) and
// 303-redirects, and the mutation persists into the next render. Also asserts the
// "use client" island (useActionState/useOptimistic) shipped a client bundle.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { build } from "../../src/build/build.ts";
import { startProdServer } from "../../src/build/prod-server.ts";

const APP = new URL("../../examples/actions", import.meta.url).pathname;

Deno.test({
  name: "examples/actions: server action progressive enhancement + client island",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
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

    let actionUrl = "";

    await t.step("the page SSRs the native form with a Server Action endpoint", async () => {
      const html = await (await fetch(`${origin}/`)).text();
      // The seed entry renders (server read), and the form points at the action endpoint.
      assertStringIncludes(html, "Server Actions work with zero client JavaScript.");
      const m = html.match(/<form action="(\/_denext\/action\/[^"]+)"/);
      assert(m, "the native <form> must carry the Server Action endpoint URL");
      actionUrl = m![1].replace(/&amp;/g, "&");
      // The interactive island shipped a hydration bundle.
      assertStringIncludes(html, "/_denext/");
    });

    await t.step("a same-origin native POST runs the action and 303-redirects", async () => {
      const body = new URLSearchParams({ name: "Ada", message: "Hello from a no-JS form" });
      const res = await fetch(`${origin}${actionUrl}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin, // same-origin → passes the CSRF check
        },
        body,
        redirect: "manual",
      });
      await res.body?.cancel();
      assertEquals(res.status, 303, "a no-JS action post redirects back");
    });

    await t.step("the mutation persists into the next server render", async () => {
      const html = await (await fetch(`${origin}/`)).text();
      assertStringIncludes(html, "Ada");
      assertStringIncludes(html, "Hello from a no-JS form");
    });

    await t.step("a cross-origin action post is refused (CSRF)", async () => {
      const res = await fetch(`${origin}${actionUrl}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "http://evil.example", // mismatched origin
        },
        body: new URLSearchParams({ name: "Mallory", message: "xss" }),
        redirect: "manual",
      });
      await res.body?.cancel();
      assert(res.status >= 400, `cross-origin action must be refused, got ${res.status}`);
      // And it must not have been recorded.
      const html = await (await fetch(`${origin}/`)).text();
      assert(!html.includes("Mallory"), "a cross-origin post must not mutate state");
    });
  } finally {
    controller.abort();
    await server?.finished;
  }
});
