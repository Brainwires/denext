// Part A operational features: request logging, per-request timeout, and cache
// single-flight (stampede protection) for both the data cache and the ISR page
// cache — including the safety property that a live per-user render is NEVER
// shared across requests.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  inMemoryCacheStore,
  PageCache,
  setCacheStore,
  unstable_cache,
} from "../src/server/cache.ts";
import { cookies } from "../src/server/request-context.ts";
import { createApp, type RequestLogInfo } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import type { PageProps } from "../src/server/types.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isrManifest(): RouteManifest {
  const base = {
    kind: "page" as const,
    layoutChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
    templateChain: [],
  };
  return {
    pages: [
      { ...base, pattern: parsePattern("cached"), routePath: "/cached", filePath: "cached.tsx" },
    ],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
}

Deno.test("unstable_cache single-flights concurrent misses (loader runs once)", async () => {
  setCacheStore(inMemoryCacheStore());
  let calls = 0;
  const load = unstable_cache(async () => {
    await delay(20);
    return ++calls;
  }, ["sf-key"]);
  const results = await Promise.all([load(), load(), load()]);
  assertEquals(calls, 1, "the loader should run exactly once under a stampede");
  assertEquals(results, [1, 1, 1]);
});

Deno.test("ISR single-flights concurrent cacheable renders (render runs once)", async () => {
  setCacheStore(inMemoryCacheStore());
  let renders = 0;
  const modules: Record<string, unknown> = {
    "cached.tsx": {
      default: async (_p: PageProps) => {
        renders++;
        await delay(20);
        return h("h1", null, "cached");
      },
      revalidate: 60,
    },
  };
  const app = createApp({
    getManifest: isrManifest,
    load: (fp) => Promise.resolve(modules[fp]),
    pageCache: new PageCache(),
  });
  const reqs = [0, 1, 2].map(() => app(new Request("http://localhost/cached")));
  const resps = await Promise.all(reqs);
  await Promise.all(resps.map((r) => r.text()));
  assertEquals(renders, 1, "only the leader should render; followers serve the cached result");
});

Deno.test("ISR does NOT share a live per-user render across requests (safety)", async () => {
  setCacheStore(inMemoryCacheStore());
  let renders = 0;
  const modules: Record<string, unknown> = {
    "cached.tsx": {
      default: async (_p: PageProps) => {
        renders++;
        await delay(20);
        const who = cookies().get("u") ?? "anon"; // makes the render dynamic
        return h("h1", null, `hello ${who}`);
      },
      revalidate: 60,
    },
  };
  const app = createApp({
    getManifest: isrManifest,
    load: (fp) => Promise.resolve(modules[fp]),
    pageCache: new PageCache(),
  });
  const [alice, bob] = await Promise.all([
    app(new Request("http://localhost/cached", { headers: { cookie: "u=alice" } })),
    app(new Request("http://localhost/cached", { headers: { cookie: "u=bob" } })),
  ]);
  const [ta, tb] = await Promise.all([alice.text(), bob.text()]);
  // Both render independently (dynamic → uncacheable); neither sees the other's user.
  assertEquals(renders, 2);
  assertStringIncludes(ta, "hello alice");
  assertStringIncludes(tb, "hello bob");
});

Deno.test("onRequest fires once with method, path, status, and duration", async () => {
  setCacheStore(inMemoryCacheStore());
  const seen: RequestLogInfo[] = [];
  const app = createApp({
    getManifest: isrManifest,
    load: (_fp) => Promise.resolve({ default: (_p: PageProps) => h("h1", null, "x") }),
    onRequest: (info) => seen.push(info),
  });
  await (await app(new Request("http://localhost/cached"))).text();
  assertEquals(seen.length, 1);
  assertEquals(seen[0].method, "GET");
  assertEquals(seen[0].path, "/cached");
  assertEquals(seen[0].status, 200);
  assert(seen[0].durationMs >= 0);
});

Deno.test({
  name: "requestTimeout returns 503 when a route exceeds the deadline",
  sanitizeOps: false, // the orphaned slow render's timer outlives the test
  sanitizeResources: false,
}, async () => {
  setCacheStore(inMemoryCacheStore());
  const app = createApp({
    getManifest: isrManifest,
    load: (_fp) =>
      Promise.resolve({
        default: async (_p: PageProps) => {
          await delay(300);
          return h("h1", null, "slow");
        },
      }),
    requestTimeout: 30,
  });
  const res = await app(new Request("http://localhost/cached"));
  assertEquals(res.status, 503);
  await res.text();
});
