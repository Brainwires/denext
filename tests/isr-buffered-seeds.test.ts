// An ISR page (`revalidate`, no Cache Components) is rendered once and served from the page
// cache: the stored document must carry what hydration needs — the `#__denext_state` island
// (`useApi({ suspense: true })` seeds, so the client never fetches on mount) and, on a Flight
// route, the `#__denext_islands` map of its deferred `client:*` islands — on the first response
// and on every cached one.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { json } from "../src/server/typed-response.ts";
import { useApi } from "../src/client/use-api.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";
import { inMemoryCacheStore, PageCache, setCacheStore } from "../src/server/cache.ts";
import { stableKey } from "../src/runtime/wire-codec.ts";
import type { VNode } from "../src/jsx/types.ts";

function Hello() {
  const { data } = useApi("/api/hello" as never, "GET" as never, undefined, { suspense: true });
  return h("p", null, (data as unknown as { hello: string }).hello);
}

function Widget(): VNode {
  return h("button", { class: "w" }, "widget");
}
const islandMod = { Widget };
tagClientExports(islandMod as Record<string, unknown>, "c_isr");

function app(flight: boolean) {
  const Page = flight
    ? () => h("main", null, h(Widget, { "client:visible": true } as never))
    : () => h("main", null, h(Suspense, { fallback: h("i", null, "…"), children: h(Hello, null) }));
  const manifest: RouteManifest = {
    pages: [{
      kind: "page",
      pattern: parsePattern(""),
      routePath: "/",
      filePath: "/app/page.tsx",
      layoutChain: [],
      templateChain: [],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
    }],
    api: [{
      kind: "api",
      pattern: parsePattern("/api/hello"),
      routePath: "/api/hello",
      filePath: "/app/api/hello/route.ts",
    }],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
    directives: new Map(),
  };
  const modules: Record<string, unknown> = {
    "/app/page.tsx": { default: Page, revalidate: 60 },
    "/app/api/hello/route.ts": { GET: () => json({ hello: "world" }) },
  };
  return createApp({
    getManifest: () => manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    clientEntryFor: () => "/_denext/entry.js",
    flight: true,
    appDir: "/app",
    pageCache: new PageCache(),
    streaming: false,
    ...(flight ? { flightRoutes: new Set(["/"]) } : {}),
  });
}

const island = (html: string, id: string) =>
  new RegExp(`<script id="${id}" type="application/json">(.*?)</script>`, "s").exec(html)?.[1];

Deno.test("ISR: the cached document carries the useApi seeds (MISS and HIT)", async () => {
  setCacheStore(inMemoryCacheStore());
  const handler = app(false);
  for (const cache of ["MISS", "HIT"]) {
    const res = await handler(new Request("http://localhost/"));
    assertEquals(res.headers.get("x-denext-cache"), cache);
    const html = await res.text();
    assertStringIncludes(html, "<p>world</p>");
    const state = island(html, "__denext_state");
    assert(state, `${cache}: the page carries the signal-state island`);
    assertEquals(Object.values(JSON.parse(state)), [{
      v: { hello: "world" },
      k: stableKey(["/api/hello", "GET", undefined, undefined, undefined]),
    }]);
  }
});

Deno.test("ISR: the cached document of a Flight route keeps its islands map (MISS and HIT)", async () => {
  setCacheStore(inMemoryCacheStore());
  const handler = app(true);
  for (const cache of ["MISS", "HIT"]) {
    const res = await handler(new Request("http://localhost/"));
    assertEquals(res.headers.get("x-denext-cache"), cache);
    const html = await res.text();
    const islands = island(html, "__denext_islands");
    assert(islands, `${cache}: the page carries the islands map`);
    assertStringIncludes(islands, "c_isr#Widget");
  }
});
