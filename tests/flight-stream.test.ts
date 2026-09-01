import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToFlightStream } from "../src/jsx/render-to-flight-stream.ts";
import { streamToString } from "../src/jsx/render-to-stream.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";
import type { VNode } from "../src/jsx/types.ts";

function Island(): VNode {
  return h("button", { class: "i" }, "island");
}
const mod = { Island };
tagClientExports(mod as Record<string, unknown>, "c_isl");

/** A `client:visible` lazy island streamed inside a Suspense hole. */
function LazyIsland(): VNode {
  return h("button", { class: "lz" }, "lazy");
}
const lazyMod = { LazyIsland };
tagClientExports(lazyMod as Record<string, unknown>, "c_lz");

/**
 * A client boundary carrying `loaderData` as a prop — the shape a migrated Remix route
 * serializes, where a `defer()` field is a promise nested in that prop. Renders identifiable
 * HTML; it does not itself read the promise (the value-hole path is exercised purely by prop
 * serialization).
 */
function DeferIsland(_props: { loaderData?: unknown }): VNode {
  return h("div", { class: "defer" }, "defer-island");
}
const deferMod = { DeferIsland };
tagClientExports(deferMod as Record<string, unknown>, "c_defer");

async function Slow(): Promise<VNode> {
  await Promise.resolve();
  return h("p", null, "slow-content", h(Island, {}));
}

Deno.test("renderToFlightStream streams HTML shell then fills the Flight payload", async () => {
  const tree = h(
    "main",
    null,
    h("h1", null, "shell"),
    h(Suspense, { fallback: h("span", null, "loading"), children: h(Slow, {}) }),
  );

  const html = await streamToString(renderToFlightStream(tree));

  // Streamed HTML: the shell + fallback placeholder, then the streamed real
  // content template + swap script.
  assertStringIncludes(html, "<h1>shell</h1>");
  assertStringIncludes(html, `data-dnx-b="dnx0"`); // boundary placeholder
  assertStringIncludes(html, "loading"); // fallback shown first
  assertStringIncludes(html, `<template data-dnx-r="dnx0">`); // streamed content
  assertStringIncludes(html, "slow-content");

  // The trailing Flight island exists and has NO unfilled holes; the boundary's
  // client island is present as a reference.
  const m = /<script id="__denext_flight"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert(m, "flight island present");
  const flight = JSON.parse(m![1]);
  const json = JSON.stringify(flight);
  assert(!json.includes(`"$":"$"`), "no unfilled Suspense holes remain");
  assertStringIncludes(json, "c_isl#Island"); // client ref survived into flight
  // Root is <main> with the resolved boundary spliced in.
  assertEquals(flight.$, "h");
  assertEquals(flight.t, "main");
});

Deno.test("renderToFlightStream carves out a client:* island streamed inside a hole", async () => {
  async function SlowLazy(): Promise<VNode> {
    await Promise.resolve();
    // A client:visible island discovered while a Suspense hole streams in.
    return h("section", null, h(LazyIsland, { "client:visible": true } as never));
  }
  const tree = h(
    "main",
    null,
    h("h1", null, "shell"),
    h(Suspense, { fallback: h("span", null, "loading"), children: h(SlowLazy, {}) }),
  );

  const html = await streamToString(renderToFlightStream(tree));

  // The lazy island is wrapped in a foreign host with its strategy, inside the hole.
  assertStringIncludes(html, `<template data-dnx-r="dnx0">`);
  assertStringIncludes(html, `data-dnx-island`);
  assertStringIncludes(html, `data-dnx-strategy="visible"`);
  // Its own Flight is carved out into #__denext_islands (not the main flight).
  const islandsMatch = /<script id="__denext_islands"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert(islandsMatch, "islands payload present for the lazy island");
  assertStringIncludes(islandsMatch![1], "c_lz#LazyIsland");
});

Deno.test("renderToFlightStream: a nested client:* island carves independently", async () => {
  function Outer(props: { children?: unknown }): VNode {
    return h("div", { class: "outer" }, props.children as never);
  }
  const outerMod = { Outer };
  tagClientExports(outerMod as Record<string, unknown>, "c_outer");

  const tree = h(
    "main",
    null,
    h(Outer, {
      "client:idle": true,
      children: h(LazyIsland, { "client:visible": true } as never),
    } as never),
  );
  const html = await streamToString(renderToFlightStream(tree));

  // Two wrapper elements in the server HTML (count open-tags, not the string, which
  // also appears in the embedded islands JSON), each deferring on its own strategy.
  assertEquals((html.match(/<div data-dnx-island/g) ?? []).length, 2);
  assertStringIncludes(html, `data-dnx-strategy="idle"`);
  assertStringIncludes(html, `data-dnx-strategy="visible"`);
  // The nested island's wrapper sits inside the parent's server DOM.
  assertStringIncludes(html, `<div class="outer"><div data-dnx-island`);
  // Both islands' own Flight is present for independent per-island hydration.
  const islandsMatch = /<script id="__denext_islands"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert(islandsMatch, "islands payload present");
  type IslandNode = { i: string; c: Array<{ p: Record<string, unknown> }> };
  const islands = JSON.parse(islandsMatch![1]) as Record<string, IslandNode>;
  // Exactly two islands keyed by id (no orphaned duplicate from the Flight re-walk).
  assertEquals(Object.keys(islands).length, 2);
  // The parent's Flight children carry the nested island as a foreign host whose id
  // matches its DOM wrapper — so the parent's per-island hydrate adopts, not descends.
  const parent = Object.values(islands).find((i) => i.i === "c_outer#Outer")!;
  const foreign = parent.c[0];
  assertEquals(foreign.p.__dnxForeign, true);
  const foreignId = foreign.p["data-dnx-id"] as string;
  assert(islands[foreignId], "foreign-host id matches a real island wrapper");
  assertEquals(islands[foreignId].i, "c_lz#LazyIsland");
});

Deno.test("renderToFlightStream carves client:only (no SSR) and client:media (with query)", async () => {
  const tree = h(
    "main",
    null,
    h(Island, { "client:only": true } as never),
    h(LazyIsland, { "client:media": "(min-width:700px)" } as never),
  );
  const html = await streamToString(renderToFlightStream(tree));

  // client:only: wrapper present, but the island body is NOT server-rendered.
  assertStringIncludes(html, `data-dnx-strategy="only"`);
  assert(!html.includes(`<button class="i">island</button>`), "client:only must not SSR");
  // client:media: wrapper carries the query and still SSRs its body for first paint.
  assertStringIncludes(html, `data-dnx-strategy="media"`);
  assertStringIncludes(html, `data-dnx-strategy-param="(min-width:700px)"`);
  assertStringIncludes(html, `<button class="lz">lazy</button>`);
  // Both islands' Flight is carved into #__denext_islands.
  const islandsMatch = /<script id="__denext_islands"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert(islandsMatch, "islands payload present");
  assertStringIncludes(islandsMatch![1], "c_isl#Island");
  assertStringIncludes(islandsMatch![1], "c_lz#LazyIsland");
});

// ---- end-to-end: streaming a Flight route through createApp -------------------

/** A Flight page: a client-boundary island wrapping a Suspense-deferred child. */
function IslandRoot(props: { children?: unknown }): VNode {
  return h("section", { id: "island" }, props.children as never);
}
const rootMod = { IslandRoot };
tagClientExports(rootMod as Record<string, unknown>, "c_root");

Deno.test("streaming: a Flight route streams its shell then the trailing flight islands", async () => {
  async function SlowChild(): Promise<VNode> {
    await Promise.resolve();
    return h("p", null, "streamed-flight-child");
  }
  const filePath = "/app/page.tsx";
  const manifest: RouteManifest = {
    pages: [{
      kind: "page",
      pattern: parsePattern("f"),
      routePath: "/f",
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
    directives: new Map([[filePath, "client"]]),
  };
  const Page = () =>
    h(
      IslandRoot,
      null,
      h("h1", null, "shell"),
      h(Suspense, { fallback: h("span", null, "loading"), children: h(SlowChild, {}) }),
    );
  const app = createApp({
    getManifest: () => manifest,
    load: (fp) => Promise.resolve(fp === filePath ? { default: Page } : undefined),
    clientEntryFor: () => "/_denext/entry.js",
    flight: true,
    appDir: "/app",
    streaming: true,
  });

  const res = await app(new Request("http://localhost/f"));
  assertEquals(res.status, 200);
  // Streamed (per-request, never CDN-cached) and CSP-carrying (swap-runtime hash).
  assertStringIncludes(res.headers.get("cache-control") ?? "", "no-store");
  assertStringIncludes(
    res.headers.get("content-security-policy") ?? "",
    "script-src 'self' 'sha256-",
  );

  const body = await res.text();
  assertStringIncludes(body, "<!DOCTYPE html>");
  assertStringIncludes(body, "<h1>shell</h1>"); // shell flushed first
  assertStringIncludes(body, "loading"); // Suspense fallback in the shell
  assertStringIncludes(body, '<template data-dnx-r="dnx0">'); // hole streamed in
  assertStringIncludes(body, "streamed-flight-child");
  // The trailing Flight island hydrates the client boundary; the client entry is last.
  assertStringIncludes(body, `id="__denext_flight"`);
  const flightAt = body.indexOf(`id="__denext_flight"`);
  const entryAt = body.indexOf("/_denext/entry.js");
  assert(
    flightAt !== -1 && entryAt !== -1 && flightAt < entryAt,
    "flight island precedes the entry",
  );
});

Deno.test("streaming: a hole-less Flight route is buffered (cache-friendly), not streamed", async () => {
  // A client-island route with NO Suspense has nothing to stream, so it is served
  // buffered — no swap runtime, not no-store — parity with the non-Flight branch.
  const filePath = "/app/page.tsx";
  const manifest: RouteManifest = {
    pages: [{
      kind: "page",
      pattern: parsePattern("f"),
      routePath: "/f",
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
    directives: new Map(),
  };
  const Page = () => h(IslandRoot, null, h("h1", null, "static"), h(Island, {}));
  const app = createApp({
    getManifest: () => manifest,
    load: (fp) => Promise.resolve(fp === filePath ? { default: Page } : undefined),
    clientEntryFor: () => "/_denext/entry.js",
    flight: true,
    appDir: "/app",
    flightRoutes: new Set(["/f"]),
    streaming: true,
  });

  const res = await app(new Request("http://localhost/f"));
  assertEquals(res.status, 200);
  // Buffered: no per-request no-store, and no swap runtime (nothing to reveal).
  assert(
    !(res.headers.get("cache-control") ?? "").includes("no-store"),
    "hole-less → not no-store",
  );
  const body = await res.text();
  assert(!body.includes("MutationObserver"), "no swap runtime on a buffered hole-less page");
  assert(!body.includes("data-dnx-r"), "no streamed-hole template");
  // Still a complete Flight document: the tail hydrates the client boundary.
  assertStringIncludes(body, `id="__denext_flight"`);
  assertStringIncludes(body, "<h1>static</h1>");
  const flightAt = body.indexOf(`id="__denext_flight"`);
  const entryAt = body.indexOf("/_denext/entry.js");
  assert(flightAt !== -1 && entryAt !== -1 && flightAt < entryAt, "flight precedes the entry");
});

// ---- deferred (Remix `defer()`) props on the streaming Flight path ------------

Deno.test("renderToFlightStream: a deferred (promise) prop resolves into the tail Flight, not {}", async () => {
  // A migrated Remix route threads `defer()` data as a promise-valued prop on a client
  // boundary. The streaming serializer must NOT collapse the promise to `{}` (what a bare
  // `Object.entries(promise)` yields): it leaves a value-hole placeholder so the shell can
  // flush, then fills it with the resolved value at tail time — so the client hydrates with
  // real deferred data.
  const slow = new Promise((r) => setTimeout(() => r({ items: [1, 2, 3] }), 0));
  const tree = h(DeferIsland, { loaderData: { critical: "now", slow } });

  const html = await streamToString(renderToFlightStream(tree));
  assertStringIncludes(html, "defer-island"); // shell painted the boundary
  const m = /<script id="__denext_flight"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert(m, "flight island present");
  const flight = JSON.parse(m![1]);
  const json = JSON.stringify(flight);
  assert(!json.includes(`"$":"vh"`), "no unfilled value holes remain in the tail");
  assertStringIncludes(json, `"items":[1,2,3]`); // resolved deferred value crossed
  assertStringIncludes(json, `"critical":"now"`); // critical data alongside it
});

Deno.test("renderToFlightStream: the shell flushes before a slow deferred prop settles", async () => {
  // The whole point of the value hole: first paint is NOT blocked on the deferred promise.
  let resolveSlow!: (v: unknown) => void;
  const slow = new Promise((r) => (resolveSlow = r));
  const stream = renderToFlightStream(h(DeferIsland, { loaderData: { slow } }));
  const reader = stream.getReader();
  const dec = new TextDecoder();

  // The first chunk (the shell) must arrive while the promise is STILL pending.
  const first = await reader.read();
  assert(!first.done, "a shell chunk is emitted");
  assertStringIncludes(dec.decode(first.value), "defer-island");

  // Now let the deferred value settle; the tail carries it.
  resolveSlow({ ok: true });
  let rest = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += dec.decode(value);
  }
  assertStringIncludes(rest, `"ok":true`);
});

Deno.test("renderToFlightStream: a REJECTED deferred prop resolves to an error marker", async () => {
  // A rejected `defer()` field must not vanish to `null` (which `<Await>` would render as
  // ordinary children). It resolves to the plain `__dnxAwaitError` marker in the tail so the
  // client `<Await>` renders its `errorElement` — and no unfilled hole is left behind.
  const boom = new Promise((_, rej) => setTimeout(() => rej(new Error("loader boom")), 0));
  const tree = h(DeferIsland, { loaderData: { slow: boom } });
  const html = await streamToString(renderToFlightStream(tree));
  const m = /<script id="__denext_flight"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert(m, "flight island present");
  const json = JSON.stringify(JSON.parse(m![1]));
  assertStringIncludes(json, `"__dnxAwaitError":true`);
  assertStringIncludes(json, `"message":"loader boom"`);
  assert(!json.includes(`"$":"vh"`), "no unfilled value hole remains");
});

Deno.test("renderToFlightStream: a user object shaped like a value hole is left as data", async () => {
  // Value-hole substitution keys on the framework-generated `dnxv` id prefix, so a user
  // data object that happens to look like a placeholder is never resolved away.
  const tree = h(DeferIsland, { loaderData: { marker: { $: "vh", r: "not-ours" } } });
  const html = await streamToString(renderToFlightStream(tree));
  const m = /<script id="__denext_flight"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert(m, "flight island present");
  const json = JSON.stringify(JSON.parse(m![1]));
  assertStringIncludes(json, `"r":"not-ours"`); // preserved as data, not nulled
});
