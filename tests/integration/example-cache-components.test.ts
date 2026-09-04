// Smoke test for examples/cache-components: build + serve it, then prove Partial
// Prerendering end to end — the static shell (a `use cache` island) is cached once
// and served on the second request (HIT), while the dynamic hole is re-rendered
// per request.

import { assert, assertEquals } from "@std/assert";
import { build } from "../../src/build/build.ts";
import { startProdOrigin } from "../helpers/prod-origin.ts";

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

type Ctx = { origin: string; firstHtml: string };

async function stepFirstRequestMiss(ctx: Ctx): Promise<void> {
  const res = await fetch(ctx.origin + "/");
  ctx.firstHtml = await res.text();
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("x-denext-cache"), "MISS");
  // The dynamic hole streams in: the shell flushes with the fallback, then the
  // real content arrives in a <template> the single swap runtime reveals.
  assert(
    ctx.firstHtml.includes("<template data-dnx-r="),
    "the hole content streamed in as a template",
  );
  assert(ctx.firstHtml.includes("MutationObserver"), "the swap runtime is present");
  assert(!ctx.firstHtml.includes("__dnxSwap"), "no per-hole swap script");
  assert(
    ctx.firstHtml.includes("data-cached-stamp"),
    "the shell rendered the use-cache island",
  );
}

async function stepSecondRequestHit(ctx: Ctx): Promise<void> {
  // Ensure an observable time delta for the per-request hole.
  await new Promise((r) => setTimeout(r, 5));
  const res = await fetch(ctx.origin + "/");
  const secondHtml = await res.text();
  assertEquals(
    res.headers.get("x-denext-cache"),
    "HIT",
    "the shell is served from cache",
  );

  // The `use cache` island is identical across requests (it lives in the shell).
  assertEquals(
    cachedStamp(secondHtml),
    cachedStamp(ctx.firstHtml),
    "the cached stamp must be stable across requests",
  );
  // The dynamic hole was re-rendered per request → a different timestamp.
  assert(
    liveTime(secondHtml) !== liveTime(ctx.firstHtml),
    "the dynamic hole must change on the second request",
  );
}

async function stepPprNoStore(ctx: Ctx): Promise<void> {
  const res = await fetch(ctx.origin + "/");
  await res.text();
  assert(
    (res.headers.get("cache-control") ?? "").includes("no-store"),
    "a PPR page must not be shared by an upstream cache",
  );
}

Deno.test({
  name: "examples/cache-components: cached shell + per-request dynamic hole (PPR)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const controller = new AbortController();
  let server: Deno.HttpServer | undefined;
  try {
    await build(APP);

    const started = await startProdOrigin(APP, controller.signal);
    server = started.server;
    const ctx: Ctx = { origin: started.origin, firstHtml: "" };

    await t.step(
      "first request renders + caches the shell (MISS)",
      () => stepFirstRequestMiss(ctx),
    );

    await t.step(
      "second request serves the cached shell (HIT), fresh hole",
      () => stepSecondRequestHit(ctx),
    );

    await t.step(
      "a PPR response is marked no-store (per-request)",
      () => stepPprNoStore(ctx),
    );
  } finally {
    controller.abort();
    await server?.finished;
  }
});
