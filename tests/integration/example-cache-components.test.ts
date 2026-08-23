// Smoke test for examples/cache-components: build + serve it, then prove Partial
// Prerendering end to end — the static shell (a `use cache` island) is cached once
// and served on the second request (HIT), while the dynamic hole is re-rendered
// per request.

import { assert, assertEquals } from "@std/assert";
import { build } from "../../src/build/build.ts";
import { startProdServer } from "../../src/build/prod-server.ts";

const APP = new URL("../../examples/cache-components", import.meta.url).pathname;

const cachedStamp = (html: string): string => {
  const m = html.match(/data-cached-stamp="([^"]+)"/);
  assert(m, "the page must render a data-cached-stamp value");
  return m![1];
};
const liveTime = (html: string): string => {
  const m = html.match(/data-live-time="([^"]+)"/);
  assert(m, "the page must render a data-live-time value (the dynamic hole)");
  return m![1];
};

Deno.test({
  name: "examples/cache-components: cached shell + per-request dynamic hole (PPR)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const controller = new AbortController();
  let server: Deno.HttpServer | undefined;
  try {
    await build(APP);

    const { promise, resolve } = Promise.withResolvers<
      { hostname: string; port: number }
    >();
    server = await startProdServer({
      projectDir: APP,
      port: 0,
      hostname: "127.0.0.1",
      signal: controller.signal,
      onListen: (info) => resolve(info),
    });
    const { hostname, port } = await promise;
    const origin = `http://${hostname}:${port}`;

    let firstHtml = "";
    await t.step(
      "first request renders + caches the shell (MISS)",
      async () => {
        const res = await fetch(origin + "/");
        firstHtml = await res.text();
        assertEquals(res.status, 200);
        assertEquals(res.headers.get("x-denext-cache"), "MISS");
        // The dynamic hole streams in: the shell flushes with the fallback, then the
        // real content arrives in a <template> the single swap runtime reveals.
        assert(
          firstHtml.includes("<template data-dnx-r="),
          "the hole content streamed in as a template",
        );
        assert(firstHtml.includes("MutationObserver"), "the swap runtime is present");
        assert(!firstHtml.includes("__dnxSwap"), "no per-hole swap script");
        assert(
          firstHtml.includes("data-cached-stamp"),
          "the shell rendered the use-cache island",
        );
      },
    );

    await t.step(
      "second request serves the cached shell (HIT), fresh hole",
      async () => {
        // Ensure an observable time delta for the per-request hole.
        await new Promise((r) => setTimeout(r, 5));
        const res = await fetch(origin + "/");
        const secondHtml = await res.text();
        assertEquals(
          res.headers.get("x-denext-cache"),
          "HIT",
          "the shell is served from cache",
        );

        // The `use cache` island is identical across requests (it lives in the shell).
        assertEquals(
          cachedStamp(secondHtml),
          cachedStamp(firstHtml),
          "the cached stamp must be stable across requests",
        );
        // The dynamic hole was re-rendered per request → a different timestamp.
        assert(
          liveTime(secondHtml) !== liveTime(firstHtml),
          "the dynamic hole must change on the second request",
        );
      },
    );

    await t.step(
      "a PPR response is marked no-store (per-request)",
      async () => {
        const res = await fetch(origin + "/");
        await res.text();
        assert(
          (res.headers.get("cache-control") ?? "").includes("no-store"),
          "a PPR page must not be shared by an upstream cache",
        );
      },
    );
  } finally {
    controller.abort();
    await server?.finished;
  }
});
