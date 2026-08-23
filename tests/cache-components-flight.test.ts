// Stage 4b: Cache Components / PPR wired through createApp for FLIGHT ("use client")
// routes. A cacheable client-island route with a dynamic hole (cookies() behind a
// Suspense) serves a static shell — cached ONCE with its Flight tree / islands /
// signal state — and streams the hole per request, emitting the SAME trailing
// #__denext_flight / #__denext_islands / entry a non-PPR streamed Flight route emits.
// This is the "on by default" unlock: PPR now covers client-island routes (previously
// the `!useFlight` gate skipped them entirely).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import { inMemoryCacheStore, PageCache, setCacheStore } from "../src/server/cache.ts";
import { cookies } from "../src/server/request-context.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import type { VNode } from "../src/jsx/types.ts";

// A client island rendered in the STATIC shell.
function ShellWidget(): VNode {
  return h("button", { class: "sw" }, "shell-widget");
}
// A client island rendered INSIDE the dynamic hole.
function HoleWidget(props: { who?: string }): VNode {
  return h("button", { class: "hw" }, props.who ?? "hole-widget");
}
const islandMod = { ShellWidget, HoleWidget };
tagClientExports(islandMod as Record<string, unknown>, "c_isl");

// A dynamic server component: reads a cookie (postpones during prerender), then
// renders a client island discovered only inside the hole.
async function Slow(): Promise<VNode> {
  const u = cookies().get("u") ?? "anon";
  return await Promise.resolve(
    h("section", { id: "who" }, `hi ${u}`, h(HoleWidget, { "client:load": true, who: u } as never)),
  );
}

const Page = () =>
  h(
    "main",
    null,
    h("h1", null, "Shell"),
    h(ShellWidget, { "client:visible": true } as never),
    h(Suspense, { fallback: h("p", null, "loading…"), children: h(Slow, {}) }),
  );

const filePath = "/app/page.tsx";
const manifest: RouteManifest = {
  pages: [{
    kind: "page",
    pattern: parsePattern(""),
    routePath: "/",
    filePath,
    layoutChain: [],
    templateChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
  }],
  api: [],
  rootLayout: null,
  rootNotFound: null,
  rootGlobalError: null,
  // The page is a SERVER component that renders client islands (pre-tagged below);
  // `flightRoutes` forces the Flight path. No page-level "client" directive — that
  // would make the whole page one client boundary and elide the server hole.
  directives: new Map(),
};

const pageModule = { default: Page, revalidate: 60 };

const makeApp = () =>
  createApp({
    getManifest: () => manifest,
    load: (fp) => Promise.resolve(fp === filePath ? pageModule : undefined),
    clientEntryFor: () => "/_denext/entry.js",
    flight: true,
    appDir: "/app",
    flightRoutes: new Set(["/"]),
    pageCache: new PageCache(),
    cacheComponents: true,
  });

const get = (handler: (r: Request) => Promise<Response>, user: string) =>
  handler(new Request("http://localhost/", { headers: { cookie: `u=${user}` } }));

Deno.test("4b: Flight PPR caches the shell (with its Flight payload) and streams the hole", async () => {
  setCacheStore(inMemoryCacheStore());
  const handler = makeApp();

  // First request (MISS): prerender + cache the shell, stream alice's hole.
  const r1 = await get(handler, "alice");
  const b1 = await r1.text();
  assertEquals(r1.status, 200);
  assertEquals(r1.headers.get("x-denext-cache"), "MISS");

  // The static shell flushes first: chrome + the shell island wrapper + the hole's
  // fallback, then the real hole content streams in as a <template>.
  assertStringIncludes(b1, "<h1>Shell</h1>");
  assertStringIncludes(b1, `data-dnx-strategy="visible"`); // the shell island
  assertStringIncludes(b1, `<div data-dnx-b="dnx0">`);
  assertStringIncludes(b1, "loading…");
  assertStringIncludes(b1, `<template data-dnx-r="dnx0">`);
  assertStringIncludes(b1, "hi alice"); // the streamed hole content
  assertStringIncludes(b1, `data-dnx-strategy="load"`); // the island inside the hole

  // The trailing Flight tail hydrates the whole tree: #__denext_flight (holes filled),
  // #__denext_islands (shell + hole islands), then the client entry LAST.
  assertStringIncludes(b1, `id="__denext_flight"`);
  assertStringIncludes(b1, `id="__denext_islands"`);
  const flightAt = b1.indexOf(`id="__denext_flight"`);
  const entryAt = b1.indexOf("/_denext/entry.js");
  assert(flightAt !== -1 && entryAt !== -1 && flightAt < entryAt, "flight precedes the entry");
  // The islands map carries BOTH islands (shell + hole) referencing the client module.
  const islandsJson = /<script id="__denext_islands"[^>]*>([\s\S]*?)<\/script>/.exec(b1)![1];
  assertStringIncludes(islandsJson, "c_isl#ShellWidget");
  assertStringIncludes(islandsJson, "c_isl#HoleWidget");
  // The filled Flight tree carries the resumed hole content (no unfilled `{$:"$"}`).
  const flightJson = /<script id="__denext_flight"[^>]*>([\s\S]*?)<\/script>/.exec(b1)![1];
  assert(!flightJson.includes(`"$":"$"`), "no unfilled Suspense holes remain in the flight");
  assertStringIncludes(flightJson, "hi alice");

  // Streamed, per-request, CSP-carrying (swap-runtime hash in script-src).
  assertStringIncludes(r1.headers.get("cache-control") ?? "", "no-store");
  assertStringIncludes(
    r1.headers.get("content-security-policy") ?? "",
    "script-src 'self' 'sha256-",
  );

  // Second request (HIT): the SAME cached shell, but bob's hole streamed in.
  const r2 = await get(handler, "bob");
  const b2 = await r2.text();
  assertEquals(r2.headers.get("x-denext-cache"), "HIT");
  assertStringIncludes(b2, "<h1>Shell</h1>");
  assertStringIncludes(b2, `data-dnx-strategy="visible"`); // shell island from cache
  assertStringIncludes(b2, "hi bob");
  assert(!b2.includes("hi alice"), "the hole is re-rendered for the second request");
  // The hole island still hydrates on a HIT (resume tagged its module).
  const islandsJson2 = /<script id="__denext_islands"[^>]*>([\s\S]*?)<\/script>/.exec(b2)![1];
  assertStringIncludes(islandsJson2, "c_isl#HoleWidget");
});

Deno.test("4b: the cached Flight shell is request-independent across users", async () => {
  setCacheStore(inMemoryCacheStore());
  const handler = makeApp();
  // Warm the cache.
  await (await get(handler, "alice")).text();
  // Two HITs for different users share the shell chrome + shell island, differ in holes.
  const a = await (await get(handler, "carol")).text();
  const b = await (await get(handler, "dave")).text();
  for (const body of [a, b]) {
    assertStringIncludes(body, "<h1>Shell</h1>");
    assertStringIncludes(body, `data-dnx-strategy="visible"`);
  }
  assertStringIncludes(a, "hi carol");
  assertStringIncludes(b, "hi dave");
});
