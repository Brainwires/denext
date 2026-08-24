// Part C5: Cache Components / PPR wired through createApp. A cacheable page with
// a dynamic hole (cookies() behind a Suspense) serves a static shell cached once,
// with the hole re-rendered per request. Gated on `cacheComponents`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import { inMemoryCacheStore, PageCache, setCacheStore } from "../src/server/cache.ts";
import { cookies } from "../src/server/request-context.ts";

let shellRenders = 0;

const modules: Record<string, unknown> = {
  "layout.tsx": {
    default: (p: { children: unknown }) => {
      shellRenders++;
      return h("main", null, [h("h1", null, "Shell"), p.children as never]);
    },
  },
  "loading.tsx": { default: () => h("p", null, "loading…") },
  "page.tsx": {
    default: async () => {
      const u = cookies().get("u") ?? "anon";
      return await Promise.resolve(h("span", { id: "who" }, `hi ${u}`));
    },
    // Per-request metadata: generateMetadata reads a cookie, so the <title> must be
    // rebuilt for each request even though the shell body is cached once.
    generateMetadata: () => {
      const u = cookies().get("u") ?? "anon";
      return { title: `hi ${u}` };
    },
    // Opt the page into caching; PPR then caches the shell and holes the cookie read.
    revalidate: 60,
  },
};

const manifest: RouteManifest = {
  pages: [{
    kind: "page",
    pattern: parsePattern(""),
    routePath: "/",
    filePath: "page.tsx",
    layoutChain: ["layout.tsx"],
    loading: "loading.tsx",
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
    templateChain: [],
  }],
  api: [],
  rootLayout: "layout.tsx",
  rootNotFound: null,
  rootGlobalError: null,
};

const app = (cacheComponents: boolean) =>
  createApp({
    getManifest: () => manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    pageCache: new PageCache(),
    cacheComponents,
  });

const get = (handler: (r: Request) => Promise<Response>, user: string) =>
  handler(new Request("http://localhost/", { headers: { cookie: `u=${user}` } }));

Deno.test("C5: PPR caches the shell once and streams the dynamic hole per request", async () => {
  setCacheStore(inMemoryCacheStore());
  const handler = app(true);

  // First request (MISS): prerender + cache the shell, stream alice's hole.
  const r1 = await get(handler, "alice");
  const b1 = await r1.text();
  assertEquals(r1.status, 200);
  assertEquals(r1.headers.get("x-denext-cache"), "MISS");
  assertStringIncludes(b1, "<h1>Shell</h1>");
  // The shell flushes with the hole's fallback shown, then the real content streams
  // in as a <template> revealed by the single swap runtime (no per-hole script).
  assertStringIncludes(b1, `<div data-dnx-b="dnx0">`);
  assertStringIncludes(b1, "loading…"); // the fallback is in the flushed shell
  assertStringIncludes(b1, `<template data-dnx-r="dnx0">`);
  assertStringIncludes(b1, "hi alice"); // the real hole content (in the template)
  assert(!b1.includes("__dnxSwap"), "no per-hole swap script");
  // A PPR page is per-request — it must not be shared by an upstream cache.
  assertStringIncludes(r1.headers.get("cache-control") ?? "", "no-store");
  // A streamed PPR response now carries the same strict hash-based CSP as a buffered
  // one (the swap runtime is a hashed constant in script-src).
  const csp = r1.headers.get("content-security-policy");
  assert(csp, "streamed PPR response carries a CSP");
  assertStringIncludes(csp!, "script-src 'self' 'sha256-");

  // Second request (HIT): the SAME cached shell, but bob's hole streamed in.
  const r2 = await get(handler, "bob");
  const b2 = await r2.text();
  assertEquals(r2.headers.get("x-denext-cache"), "HIT");
  assertStringIncludes(b2, "<h1>Shell</h1>");
  assertStringIncludes(b2, "hi bob");
  assert(!b2.includes("hi alice"), "the hole is re-rendered for the second request");
});

Deno.test("C5: a PPR cache hit rebuilds per-request metadata (<title>) while reusing the shell", async () => {
  setCacheStore(inMemoryCacheStore());
  const handler = app(true);

  // MISS: generateMetadata reads alice's cookie -> the shell's <title> is "hi alice".
  const b1 = await (await get(handler, "alice")).text();
  assertStringIncludes(b1, "<title>hi alice</title>");

  // HIT: the shell body is served from cache, but the <head> is rebuilt for THIS
  // request — generateMetadata reads bob's cookie, so the title reflects bob.
  const r2 = await get(handler, "bob");
  const b2 = await r2.text();
  assertEquals(r2.headers.get("x-denext-cache"), "HIT");
  assertStringIncludes(b2, "<h1>Shell</h1>"); // same cached shell chrome
  assertStringIncludes(b2, "hi bob"); // per-request hole
  assertStringIncludes(b2, "<title>hi bob</title>"); // per-request metadata
  assert(
    !b2.includes("<title>hi alice</title>"),
    "the cached title must not leak to another request",
  );
});

Deno.test("C5: with cacheComponents OFF, a cookie-reading page is not cached (unchanged)", async () => {
  setCacheStore(inMemoryCacheStore());
  const handler = app(false);

  const r1 = await get(handler, "alice");
  await r1.text();
  const r2 = await get(handler, "bob");
  const b2 = await r2.text();
  // Without PPR the dynamic read disqualifies the whole page from caching: no HIT.
  assertEquals(r2.headers.get("x-denext-cache"), null);
  assertStringIncludes(b2, "hi bob");
});
