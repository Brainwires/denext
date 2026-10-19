// `useApi({ suspense: true })` seeds hydration from a Cache Components (PPR) shell on a route
// that doesn't use Flight (an isomorphic route, hydrated as one client bundle): the value the
// static shell's prerender resolved is cached WITH the shell and lands in `#__denext_state` on
// every response — the first (MISS) and every cached one (HIT) — and a call inside a dynamic
// hole is recorded per request as the hole resumes. The client then adopts it and never
// fetches on mount (tests/e2e/use-api-ppr.e2e.test.ts drives that in a browser) — provided the
// seed is filed under the `useId()` the browser computes, which the last test holds the server's
// root signal boundaries to.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { json } from "../src/server/typed-response.ts";
import { useApi } from "../src/client/use-api.ts";
import { useId } from "../src/runtime/hooks.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { cookies } from "../src/server/request-context.ts";
import { inMemoryCacheStore, PageCache, setCacheStore } from "../src/server/cache.ts";
import { stableKey } from "../src/runtime/wire-codec.ts";

const ORIGIN = "http://localhost";

/** A `useApi` suspense call rendering its `hello`. */
function Hello(props: { path: string }) {
  const { data } = useApi(props.path as never, "GET" as never, undefined, { suspense: true });
  return h("p", null, (data as unknown as { hello: string }).hello);
}

/** A dynamic server component (reads a cookie: a per-request PPR hole) with its own call. */
function Who() {
  const who = cookies().get("u")?.value ?? "anon";
  return h("section", null, `hi ${who}`, h(Hello, { path: "/api/greet" }));
}

/** An isomorphic, cacheable route: a static `useApi` call, and (optionally) a dynamic hole. */
function pprApp(withHole: boolean, cacheComponents = true) {
  let calls = 0;
  const Page = () =>
    h(
      "main",
      null,
      h(Suspense, { fallback: h("i", null, "…"), children: h(Hello, { path: "/api/hello" }) }),
      withHole ? h(Suspense, { fallback: h("i", null, "who…"), children: h(Who, null) }) : null,
    );
  const page = {
    kind: "page" as const,
    pattern: parsePattern("iso"),
    routePath: "/iso",
    filePath: "/app/page.tsx",
    layoutChain: [],
    templateChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
  };
  const api = (name: string) => ({
    kind: "api" as const,
    pattern: parsePattern(`/api/${name}`),
    routePath: `/api/${name}`,
    filePath: `/app/api/${name}/route.ts`,
  });
  const manifest: RouteManifest = {
    pages: [page],
    api: [api("hello"), api("greet")],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
    directives: new Map(),
  };
  const modules: Record<string, unknown> = {
    "/app/page.tsx": { default: Page, revalidate: 60 },
    "/app/api/hello/route.ts": {
      GET: () => {
        calls++;
        return json({ hello: "world" });
      },
    },
    "/app/api/greet/route.ts": { GET: () => json({ hello: "greetings" }) },
  };
  const app = createApp({
    getManifest: () => manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    clientEntryFor: () => "/_denext/entry.js",
    flight: true,
    appDir: "/app",
    pageCache: new PageCache(),
    cacheComponents,
  });
  return { app, calls: () => calls };
}

/** The `#__denext_state` island (`useId → { v, k }`). */
function stateOf(html: string): Record<string, { v: unknown; k: string }> {
  const m = /<script id="__denext_state" type="application\/json">(.*?)<\/script>/s.exec(html);
  assert(m, "the page carries the signal-state island");
  return JSON.parse(m[1]);
}

/** The island's seeds (`{ v, k }`), in document order. */
function seedsOf(html: string): { v: unknown; k: string }[] {
  return Object.values(stateOf(html));
}

/**
 * The `useId`s the same route records without Cache Components — the ones the client computes
 * as it hydrates, so the ones a seed must be filed under to be adopted.
 */
async function hydrationIds(withHole: boolean): Promise<string[]> {
  const { app } = pprApp(withHole, false);
  const res = await app(new Request(`${ORIGIN}/iso`, { headers: { cookie: "u=x" } }));
  return Object.keys(stateOf(await res.text())).sort();
}

const key = (path: string) => stableKey([path, "GET", undefined, undefined, undefined]);

Deno.test("useApi PPR seeding: a fully static shell carries its seed, cached with it", async () => {
  setCacheStore(inMemoryCacheStore());
  const { app, calls } = pprApp(false);
  const first = await app(new Request(`${ORIGIN}/iso`));
  assertEquals(first.headers.get("x-denext-cache"), "MISS");
  const html = await first.text();
  assertStringIncludes(html, "<p>world</p>");
  assertEquals(seedsOf(html), [{ v: { hello: "world" }, k: key("/api/hello") }]);
  // Filed under the id the client computes (the suspended first attempt must not shift it).
  assertEquals(Object.keys(stateOf(html)), await hydrationIds(false));
  const hit = await app(new Request(`${ORIGIN}/iso`));
  assertEquals(hit.headers.get("x-denext-cache"), "HIT");
  assertEquals(seedsOf(await hit.text()), [{ v: { hello: "world" }, k: key("/api/hello") }]);
  assertEquals(calls(), 1, "the shell's call ran once, at prerender");
});

Deno.test("useApi PPR seeding: a shell with a dynamic hole seeds the shell's call and the hole's", async () => {
  setCacheStore(inMemoryCacheStore());
  const { app } = pprApp(true);
  const ids = await hydrationIds(true);
  for (const [user, cache] of [["alice", "MISS"], ["bob", "HIT"]]) {
    const res = await app(new Request(`${ORIGIN}/iso`, { headers: { cookie: `u=${user}` } }));
    assertEquals(res.headers.get("x-denext-cache"), cache);
    const html = await res.text();
    assertStringIncludes(html, `hi ${user}`);
    const seeds = seedsOf(html);
    assertEquals(
      seeds.map((s) => s.k).sort(),
      [key("/api/greet"), key("/api/hello")].sort(),
      `${cache}: the shell's seed (cached) and the hole's (this request)`,
    );
    assertEquals(seeds.find((s) => s.k === key("/api/hello"))?.v, { hello: "world" });
    assertEquals(seeds.find((s) => s.k === key("/api/greet"))?.v, { hello: "greetings" });
    // The island is emitted before the entry, so the entry can adopt it.
    assert(html.indexOf('id="__denext_state"') < html.indexOf("/_denext/entry.js"));
    assertEquals(Object.keys(stateOf(html)).sort(), ids, `${cache}: the client's ids`);
  }
});

/**
 * A route rendered with `levels` (a scanned app's per-segment nesting: the root level's
 * not-found / forbidden / unauthorized boundaries around the page) and without (the shape the
 * browser entry hydrates): the page component's `useId()` must not depend on it.
 */
async function pageIdWith(levels: boolean): Promise<string | undefined> {
  const Page = () => {
    const id = useId();
    return h("main", { "data-id": id }, "page");
  };
  const manifest: RouteManifest = {
    pages: [{
      kind: "page",
      pattern: parsePattern(""),
      routePath: "/",
      filePath: "/app/page.tsx",
      layoutChain: ["/app/layout.tsx"],
      templateChain: [],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
      ...(levels
        ? {
          levels: [{
            depth: 0,
            layout: "/app/layout.tsx",
            template: null,
            loading: null,
            error: null,
          }],
        }
        : {}),
    }],
    api: [],
    rootLayout: "/app/layout.tsx",
    rootNotFound: null,
    rootGlobalError: null,
    directives: new Map(),
  };
  const modules: Record<string, unknown> = {
    "/app/page.tsx": { default: Page },
    "/app/layout.tsx": {
      default: (p: { children: unknown }) => h("div", null, p.children as never),
    },
  };
  const app = createApp({
    getManifest: () => manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    clientEntryFor: () => "/_denext/entry.js",
    flight: true,
    appDir: "/app",
  });
  const html = await (await app(new Request(`${ORIGIN}/`))).text();
  return /data-id="([^"]+)"/.exec(html)?.[1];
}

Deno.test("useId: the server's signal boundaries take no component slot (ids match the browser entry's)", async () => {
  const flat = await pageIdWith(false);
  assert(flat, "the page rendered its id");
  assertEquals(await pageIdWith(true), flat);
});

Deno.test("useApi PPR seeding: a prerender that throws falls back and closes its collection", async () => {
  setCacheStore(inMemoryCacheStore());
  const Boom = () => {
    throw new Error("boom");
  };
  const manifest: RouteManifest = {
    pages: [{
      kind: "page",
      pattern: parsePattern("boom"),
      routePath: "/boom",
      filePath: "/app/boom.tsx",
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
  const app = createApp({
    getManifest: () => manifest,
    load: () => Promise.resolve({ default: Boom, revalidate: 60 }),
    clientEntryFor: () => "/_denext/entry.js",
    flight: true,
    appDir: "/app",
    pageCache: new PageCache(),
    cacheComponents: true,
  });
  const res = await app(new Request(`${ORIGIN}/boom`));
  assertEquals(res.status, 500);
  await res.body?.cancel();
  // A later render still records and seeds normally.
  const { app: ok } = pprApp(false);
  assertEquals(seedsOf(await (await ok(new Request(`${ORIGIN}/iso`))).text()).length, 1);
});
