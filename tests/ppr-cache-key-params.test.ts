// Cache Components / PPR with `cacheKeyParams`: a `searchParams` name the narrowed key drops is a
// request-time value, so reading it while the shell prerenders postpones (Next's rule for
// `searchParams` under Cache Components). Inside a `<Suspense>` the read becomes a per-request
// hole; outside one the shell cannot be prerendered, and the page falls back to a render that
// is never stored. A name the key keeps stays in the shell: the shell is cached per value.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import type { PageProps } from "../src/server/types.ts";
import { cookies } from "../src/server/request-context.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { withoutPostpone } from "../src/runtime/prerender.ts";
import { inMemoryCacheStore, PageCache, setCacheStore } from "../src/server/cache.ts";

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
  api: [],
  rootLayout: null,
  rootNotFound: null,
  rootGlobalError: null,
  directives: new Map(),
};

/** A per-visitor hole, so the shell has holes even when the page reads no param inside one. */
function Who() {
  return h("b", null, `who=${cookies().get("u")?.value ?? "anon"}`);
}

const hole = (child: unknown) =>
  h(Suspense, { fallback: h("i", null, "loading"), children: child as never });

function app(page: (p: PageProps) => unknown, flight: boolean, cacheComponents = true) {
  const modules: Record<string, unknown> = {
    "/app/page.tsx": { default: page, revalidate: 60 },
  };
  return createApp({
    getManifest: () => manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    ...(flight
      ? {
        clientEntryFor: () => "/_denext/entry.js",
        flight: true,
        appDir: "/app",
        flightRoutes: new Set(["/"]),
      }
      : {}),
    pageCache: new PageCache(),
    cacheComponents,
    cacheKeyParams: ["page"],
  });
}

async function get(handler: (r: Request) => Promise<Response>, query: string) {
  const res = await handler(new Request(`http://localhost/${query}`));
  return { cache: res.headers.get("x-denext-cache"), body: await res.text() };
}

/** Run `fn` in dev mode, collecting `console.warn` output. */
async function inDev(fn: (warnings: string[]) => Promise<void>): Promise<void> {
  const g = globalThis as { __denextDev?: boolean };
  const prevDev = g.__denextDev;
  const origWarn = console.warn;
  const warnings: string[] = [];
  g.__denextDev = true;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    await fn(warnings);
  } finally {
    console.warn = origWarn;
    g.__denextDev = prevDev;
  }
}

for (const flight of [false, true]) {
  const mode = flight ? "Flight" : "HTML";

  Deno.test(`PPR cacheKeyParams (${mode}): an un-keyed read outside a hole never reaches another visitor`, async () => {
    setCacheStore(inMemoryCacheStore());
    const handler = app(
      (p) => h("main", null, h("p", null, `q=${p.searchParams.q}`), hole(h(Who, null))),
      flight,
    );
    await inDev(async (warnings) => {
      const a = await get(handler, "?page=1&q=alice");
      assertStringIncludes(a.body, "q=alice");
      // Same keyed value, another visitor's `q`: it must render its own value, never alice's.
      const b = await get(handler, "?page=1&q=bob");
      assert(!b.body.includes("alice"), "the first request's query value leaked into the second");
      assertStringIncludes(b.body, "q=bob");
      assert(b.cache !== "HIT", "a render that read an un-keyed param must not be cached");
      assert(
        warnings.some((w) => w.includes("cacheKeyParams") && w.includes("[q]")),
        `expected a dev warning naming the un-keyed read; got: ${warnings.join(" | ")}`,
      );
    });
  });

  Deno.test(`PPR cacheKeyParams (${mode}): a keyed read outside a hole stays in the cached shell`, async () => {
    setCacheStore(inMemoryCacheStore());
    const handler = app(
      (p) => h("main", null, h("p", null, `page=${p.searchParams.page}`), hole(h(Who, null))),
      flight,
    );
    const a = await get(handler, "?page=1&utm=x");
    assertEquals(a.cache, "MISS");
    assertStringIncludes(a.body, "page=1");
    const b = await get(handler, "?page=1&utm=y");
    assertEquals(b.cache, "HIT");
    assertStringIncludes(b.body, "page=1");
    const c = await get(handler, "?page=2");
    assertEquals(c.cache, "MISS", "another keyed value is another shell");
    assertStringIncludes(c.body, "page=2");
  });

  Deno.test(`PPR cacheKeyParams (${mode}): an un-keyed read inside Suspense stays a per-request hole`, async () => {
    setCacheStore(inMemoryCacheStore());
    const Q = ({ sp }: { sp: PageProps["searchParams"] }) => h("em", null, `q=${sp.q}`);
    const handler = app(
      (p) => h("main", null, h("h1", null, "static"), hole(h(Q, { sp: p.searchParams }))),
      flight,
    );
    await inDev(async (warnings) => {
      const a = await get(handler, "?page=1&q=alice");
      assertEquals(a.cache, "MISS");
      assertStringIncludes(a.body, "q=alice");
      const b = await get(handler, "?page=1&q=bob");
      assertEquals(b.cache, "HIT", "the shell around the hole is cached");
      assertStringIncludes(b.body, "static");
      assertStringIncludes(b.body, "q=bob");
      assert(!b.body.includes("alice"), "the hole renders per request");
      assert(
        !warnings.some((w) => w.includes("cacheKeyParams")),
        `a read inside a hole needs no warning; got: ${warnings.join(" | ")}`,
      );
    });
  });
  Deno.test(`PPR cacheKeyParams (${mode}): an un-keyed read that cannot postpone keeps the shell out of the cache`, async () => {
    setCacheStore(inMemoryCacheStore());
    // A `use cache` body reads its inputs statically (postponing is suppressed there).
    const Cached = async ({ sp }: { sp: PageProps["searchParams"] }) =>
      await withoutPostpone(() => Promise.resolve(h("p", null, `q=${sp.q}`)));
    const handler = app(
      (p) => h("main", null, h(Cached, { sp: p.searchParams }), hole(h(Who, null))),
      flight,
    );
    await inDev(async (warnings) => {
      const a = await get(handler, "?page=1&q=alice");
      assertStringIncludes(a.body, "q=alice");
      const b = await get(handler, "?page=1&q=bob");
      assert(!b.body.includes("alice"), "the first request's query value leaked into the second");
      assertStringIncludes(b.body, "q=bob");
      assert(warnings.some((w) => w.includes("cacheKeyParams") && w.includes("[q]")));
    });
  });
  Deno.test(`PPR cacheKeyParams (${mode}): enumerating the query outside a hole counts every name`, async () => {
    setCacheStore(inMemoryCacheStore());
    const handler = app(
      (p) =>
        h("main", null, h("p", null, `all=${p.searchParams.raw.toString()}`), hole(h(Who, null))),
      flight,
    );
    const a = await get(handler, "?page=1&q=alice");
    assertStringIncludes(a.body, "q=alice");
    const b = await get(handler, "?page=1&q=bob");
    assert(!b.body.includes("alice"), "the first request's query value leaked into the second");
    assertStringIncludes(b.body, "q=bob");
  });
  Deno.test(`PPR cacheKeyParams (${mode}): an awaited searchParams is tracked like the record`, async () => {
    setCacheStore(inMemoryCacheStore());
    const handler = app(
      async (p) => {
        const sp = await p.searchParams; // Next 15's form
        return h("main", null, h("p", null, `q=${sp.q} page=${sp.page}`), hole(h(Who, null)));
      },
      flight,
    );
    const a = await get(handler, "?page=1&q=alice");
    assertStringIncludes(a.body, "q=alice");
    const b = await get(handler, "?page=1&q=bob");
    assert(!b.body.includes("alice"), "the first request's query value leaked into the second");
    assertStringIncludes(b.body, "q=bob");
  });

  Deno.test(`PPR cacheKeyParams (${mode}): a presence check or key listing counts as a read`, async () => {
    setCacheStore(inMemoryCacheStore());
    const handler = app(
      (p) =>
        h(
          "main",
          null,
          h("p", null, "debug" in p.searchParams ? "debug-on" : "debug-off"),
          h("p", null, `keys=${Object.keys(p.searchParams).join("+")}`),
          hole(h(Who, null)),
        ),
      flight,
    );
    const a = await get(handler, "?page=1&debug=1");
    assertStringIncludes(a.body, "debug-on");
    const b = await get(handler, "?page=1");
    assertStringIncludes(b.body, "debug-off");
    assert(!b.body.includes("debug-on"), "the first request's query leaked into the second");
  });
}

Deno.test("ISR cacheKeyParams: an awaited searchParams read keeps a whole-body render out of the cache", async () => {
  setCacheStore(inMemoryCacheStore());
  const handler = app(
    async (p) => {
      const sp = await p.searchParams;
      return h("p", null, `q=${sp.q}`);
    },
    false,
    false,
  );
  const a = await get(handler, "?page=1&q=alice");
  assertStringIncludes(a.body, "q=alice");
  const b = await get(handler, "?page=1&q=bob");
  assert(!b.body.includes("alice"), "the first request's query value leaked into the second");
  assertStringIncludes(b.body, "q=bob");
});
