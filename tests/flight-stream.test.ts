import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToFlightStream } from "../src/jsx/render-to-flight-stream.ts";
import { streamToString } from "../src/jsx/render-to-stream.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { assembleStreamedFlight } from "../src/jsx/flight-holes.ts";
import type { FlightNode, FlightValue } from "../src/jsx/render-to-flight.ts";
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

/** The JSON chunks a streamed document sent under `attr`, by id. */
function streamedChunks<T>(html: string, attr: string): Map<string, T> {
  const re = new RegExp(
    `<script type="application/json" ${attr}="([^"]+)">([\\s\\S]*?)</script>`,
    "g",
  );
  return new Map([...html.matchAll(re)].map((m) => [m[1], JSON.parse(m[2]) as T]));
}

/**
 * The Flight tree the browser hydrates: `#__denext_flight` with the hole and deferred-value
 * chunks the document streamed put back (what the entry's `readStreamedFlight` does).
 */
function hydratedFlight(html: string) {
  const m = /<script id="__denext_flight"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert(m, "flight island present");
  return assembleStreamedFlight(
    JSON.parse(m![1]),
    streamedChunks<FlightNode>(html, "data-dnx-f"),
    streamedChunks<FlightValue>(html, "data-dnx-v"),
  ) as { $?: string; t?: string };
}

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

  // The boundary's Flight subtree streamed as its own chunk, next to its template.
  assert(streamedChunks(html, "data-dnx-f").has("dnx0"), "the hole's Flight streamed");
  // What the browser hydrates has NO unfilled holes; the boundary's client island is
  // present as a reference.
  const flight = hydratedFlight(html);
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

/** A one-page manifest for "/f" backed by `filePath`, optionally marked as a client boundary. */
function flightManifest(filePath: string, directives: RouteManifest["directives"]): RouteManifest {
  return {
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
    directives,
  };
}

Deno.test("streaming: a Flight route streams its shell then the trailing flight islands", async () => {
  async function SlowChild(): Promise<VNode> {
    await Promise.resolve();
    return h("p", null, "streamed-flight-child");
  }
  const filePath = "/app/page.tsx";
  const manifest = flightManifest(filePath, new Map([[filePath, "client"]]));
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
  const manifest = flightManifest(filePath, new Map());
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
  const json = JSON.stringify(hydratedFlight(html));
  assert(!json.includes(`"$":"vh"`), "no unfilled value holes remain once assembled");
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

Deno.test("renderToFlightStream: each deferred value's data streams as it resolves, before a slow one", async () => {
  // Remix `defer()` streaming, per boundary: a fast deferred field's data — and the
  // `<Await>`-style boundary that renders it — reach the wire while a slow field is still
  // pending, instead of the whole Flight payload waiting for the slowest one.
  let resolveSlow!: (v: unknown) => void;
  const slow = new Promise((r) => (resolveSlow = r));
  const fast = Promise.resolve({ reviews: ["great"] });
  async function FastPanel(): Promise<VNode> {
    return h("p", { class: "fast" }, (await fast).reviews[0]);
  }
  async function SlowPanel(): Promise<VNode> {
    return h("p", { class: "slow" }, String(((await slow) as { n: number }).n));
  }
  const tree = h(
    "main",
    null,
    h(DeferIsland, { loaderData: { fast, slow } }),
    h(Suspense, { fallback: h("i", null, "fast…"), children: h(FastPanel, {}) }),
    h(Suspense, { fallback: h("i", null, "slow…"), children: h(SlowPanel, {}) }),
  );
  const reader = renderToFlightStream(tree).getReader();
  const dec = new TextDecoder();
  let early = "";
  // Read until the fast field's data chunk arrives — the slow promise is STILL pending.
  while (!/data-dnx-v="dnxv0">\{"reviews":\["great"\]\}/.test(early)) {
    const { value, done } = await reader.read();
    assert(!done, "the stream must not end while the slow field is pending");
    early += dec.decode(value);
  }
  assertStringIncludes(early, `<template data-dnx-r="dnx0"><p class="fast">great</p>`);
  assert(streamedChunks(early, "data-dnx-f").has("dnx0"), "the fast boundary's Flight streamed");
  assert(!early.includes(`data-dnx-v="dnxv1"`), "the slow field has no data yet");
  assert(!early.includes(`id="__denext_flight"`), "the tail waits for the slow boundary");

  resolveSlow({ n: 7 });
  let rest = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += dec.decode(value);
  }
  assertStringIncludes(rest, `data-dnx-v="dnxv1">{"n":7}`);
  assertStringIncludes(rest, `<template data-dnx-r="dnx1"><p class="slow">7</p>`);
  // The browser reassembles the complete tree: both deferred values in the boundary's props.
  const json = JSON.stringify(hydratedFlight(early + rest));
  assert(!json.includes(`"$":"vh"`) && !json.includes(`"$":"$"`), "nothing left unfilled");
  assertStringIncludes(json, `"fast":{"reviews":["great"]}`);
  assertStringIncludes(json, `"slow":{"n":7}`);
});

Deno.test("renderToFlightStream: a REJECTED deferred prop resolves to an error marker", async () => {
  // A rejected `defer()` field must not vanish to `null` (which `<Await>` would render as
  // ordinary children). It resolves to the plain `__dnxAwaitError` marker in the tail so the
  // client `<Await>` renders its `errorElement` — and no unfilled hole is left behind.
  const boom = new Promise((_, rej) => setTimeout(() => rej(new Error("loader boom")), 0));
  const tree = h(DeferIsland, { loaderData: { slow: boom } });
  const html = await streamToString(renderToFlightStream(tree));
  const json = JSON.stringify(hydratedFlight(html));
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

// A streamed island's serialized children must be WALKED, not rendered: rendering them ran a
// consumer island outside the provider its parent island rendered around it (the App Router
// playground's `/context`: a client `CounterProvider` in the layout, `useCounter` in the page).
Deno.test("renderToFlightStream: an island's children are not invoked by the Flight walk", async () => {
  const { createContext, useContext } = await import("../mod.ts");
  const { tagClientExports } = await import("../src/runtime/client-reference.ts");
  const Ctx = createContext<string | null>(null);
  let consumerRuns = 0;
  // deno-lint-ignore no-explicit-any
  function Provider(props: any) {
    return h(Ctx.Provider, { value: "ok" }, props.children);
  }
  function Consumer() {
    consumerRuns++;
    const v = useContext(Ctx);
    if (v == null) throw new Error("useX must be used within Provider");
    return h("b", null, v);
  }
  tagClientExports({ Provider, Consumer } as Record<string, unknown>, "c_stream_ctx");
  // Server-authored: the consumer is the provider island's child.
  const tree = h("main", null, h(Provider, null, h("div", null, h(Consumer, null))));
  const html = await streamToString(renderToFlightStream(tree));
  assertStringIncludes(html, "<b>ok</b>");
  assertEquals(consumerRuns, 1, "rendered once for HTML; the Flight walk emitted a reference");
  assertStringIncludes(html, "c_stream_ctx#Consumer");
});

Deno.test("renderToFlightStream: a deferred value inside a Map/Set prop fills its hole at tail time", async () => {
  // Value-hole substitution must descend into the wire codec's `M`/`S` containers, or a
  // `defer()` promise nested in a Set would reach the client as an unfilled `{$:"vh"}`.
  const slow = new Promise((r) => setTimeout(() => r("late"), 0));
  const tree = h(DeferIsland, {
    loaderData: { bag: new Set(["now", slow]), byId: new Map([["a", slow]]) },
  });

  const html = await streamToString(renderToFlightStream(tree));
  const json = JSON.stringify(hydratedFlight(html));
  assert(!json.includes(`"$":"vh"`), "no unfilled value holes remain inside Map/Set");
  assertStringIncludes(json, `{"$":"S","v":["now","late"]}`);
  assertStringIncludes(json, `{"$":"M","v":[["a","late"]]}`);
});

// ---- Dropped function props: the dev warning on the streaming path -------------------

/** Run `fn` with `__denextDev` set and `console.warn` captured. */
async function withDevWarnings(fn: () => Promise<void>): Promise<string[]> {
  const g = globalThis as { __denextDev?: boolean };
  const prevDev = g.__denextDev;
  const origWarn = console.warn;
  const warnings: string[] = [];
  g.__denextDev = true;
  console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.warn = origWarn;
    if (prevDev === undefined) delete g.__denextDev;
    else g.__denextDev = prevDev;
  }
  return warnings;
}

Deno.test("streaming: an onClick on a host element inside an async Server Component warns in dev", async () => {
  async function Page(): Promise<VNode> {
    await Promise.resolve();
    return h("main", null, h("button", { onClick: () => {}, id: "inert" }, "go"));
  }
  const warnings = await withDevWarnings(async () => {
    const html = await streamToString(renderToFlightStream(h(Page, {})));
    const m = /<script id="__denext_flight"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    assert(m, "flight island present");
    assert(!m![1].includes("onClick"), "the handler is dropped from the Flight tree");
  });
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "<button>");
  assertStringIncludes(warnings[0], '"onClick"');
});

Deno.test("streaming: a host handler rendered by a client island's own code does not warn", async () => {
  function Toggle(): VNode {
    return h("button", { onClick: () => {}, class: "t" }, "toggle");
  }
  tagClientExports({ Toggle } as Record<string, unknown>, "c_toggle");
  const warnings = await withDevWarnings(async () => {
    await streamToString(renderToFlightStream(h("main", null, h(Toggle, {}))));
  });
  assertEquals(warnings, []);
});
