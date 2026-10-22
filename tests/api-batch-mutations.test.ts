// Typed-API batching carries mutations (POST/PUT/PATCH/DELETE) with the guarantees separate
// requests in call order give — each runs alone, after everything before it settled — and with
// each route's own CSRF checks; and `useApi({ suspense: true })` seeds hydration on routes that
// don't use Flight (buffered, streamed, and an isomorphic soft navigation's payload).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import type { ApiModule } from "../src/server/types.ts";
import type { IsoNavPayload } from "../src/server/document.ts";
import { json } from "../src/server/typed-response.ts";
import { cors, createApi, csrf } from "../src/server/mod.ts";
import { API_BATCH_HEADER, API_BATCH_PATH } from "../src/runtime/api-batch-protocol.ts";
import { createApiClient } from "../src/runtime/api-client.ts";
import { useApi } from "../src/client/use-api.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { generateRouteEntry } from "../src/build/bundle.ts";
import { stableKey } from "../src/runtime/wire-encode.ts";

const ORIGIN = "http://localhost";

/** An app whose routes log the order they ran in (and how long each took). */
function orderedApp(extra: Record<string, unknown> = {}) {
  const log: string[] = [];
  const store = { n: 0 };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const routes: Record<string, ApiModule> = {
    "count.ts": {
      GET: () => {
        log.push(`read:${store.n}`);
        return json({ n: store.n });
      },
      // Slow on purpose: a read queued after it must still see its write.
      POST: async (req) => {
        const { by } = await req.json() as { by: number };
        await wait(30);
        store.n += by;
        log.push(`add:${by}`);
        return json({ n: store.n });
      },
      DELETE: () => {
        store.n = 0;
        log.push("reset");
        return new Response(null, { status: 204 });
      },
    },
    // A route whose own policy is narrower than the app's: only `https://only.example`.
    "narrow.ts": {
      POST: createApi().use(cors({ origins: ["https://only.example"] })).define({}, () => {
        log.push("narrow");
        return { ok: true };
      }),
    },
    // A write whose answer is bigger than a small item cap.
    "big.ts": {
      POST: () => {
        store.n += 1;
        return json({ pad: "x".repeat(2048) });
      },
      GET: () => json({ pad: "x".repeat(2048) }),
    },
    "guarded.ts": {
      // The route's own CSRF check (double submit): it needs the batch's Origin and the
      // item's token.
      POST: createApi().use(csrf({ doubleSubmit: true })).define({}, () => ({ ok: true })),
    },
  } as Record<string, ApiModule>;
  const api = Object.keys(routes).map((f) => ({
    kind: "api" as const,
    pattern: parsePattern(`/api/${f.replace(".ts", "")}`),
    routePath: `/api/${f.replace(".ts", "")}`,
    filePath: f,
  }));
  const manifest: RouteManifest = {
    pages: [],
    api,
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
  const app = createApp({
    getManifest: () => manifest,
    load: (fp: string) => Promise.resolve(routes[fp] as unknown as Record<string, unknown>),
    ...extra,
  });
  return { app, log, store };
}

function batch(items: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${API_BATCH_PATH}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      host: "localhost",
      cookie: "denext-csrf=a1b2c3d4e5f6",
      "content-type": "application/json",
      [API_BATCH_HEADER]: "1",
      ...headers,
    },
    body: JSON.stringify({ v: 1, items }),
  });
}

Deno.test("api batch mutations: run alone, in call order; reads after a write see it", async () => {
  const { app, log } = orderedApp();
  const res = await app(batch([
    { id: 0, m: "GET", p: "/api/count" },
    { id: 1, m: "POST", p: "/api/count", b: JSON.stringify({ by: 2 }) },
    { id: 2, m: "POST", p: "/api/count", b: JSON.stringify({ by: 3 }) },
    { id: 3, m: "GET", p: "/api/count" },
    { id: 4, m: "DELETE", p: "/api/count" },
    { id: 5, m: "GET", p: "/api/count" },
  ]));
  assertEquals(res.status, 200);
  const { r } = await res.json();
  assertEquals(r.map((x: { id: number }) => x.id), [0, 1, 2, 3, 4, 5], "results in item order");
  assertEquals(log, ["read:0", "add:2", "add:3", "read:5", "reset", "read:0"]);
  assertEquals(JSON.parse(r[2].t), { n: 5 });
  assertEquals(r[4].s, 204);
});

Deno.test("api batch mutations: the route's own CSRF check sees the batch Origin and the item's token", async () => {
  const { app } = orderedApp();
  const ok = await (await app(batch([
    { id: 0, m: "POST", p: "/api/guarded", h: { "x-csrf-token": "a1b2c3d4e5f6" } },
    { id: 1, m: "POST", p: "/api/guarded" }, // no token → the route refuses this one
  ]))).json();
  assertEquals(ok.r[0].s, 200);
  assertEquals(ok.r[1].s, 403);
  assertEquals(JSON.parse(ok.r[1].t).error.code, "csrf_failed");
  // A batch from another origin never runs at all (the Server Actions gate).
  const cross = await app(batch([{ id: 0, m: "POST", p: "/api/guarded" }], {
    origin: "http://evil.example",
  }));
  assertEquals(cross.status, 403);
});

Deno.test("api batch: a cookieless batch from an app-cors origin runs no item a route's own cors() refuses", async () => {
  const PARTNER = "https://partner.example";
  const { app, log } = orderedApp({ cors: { origins: [PARTNER, "https://only.example"] } });
  const cross = (origin: string) => {
    const req = batch([
      { id: 0, m: "POST", p: "/api/narrow", b: "{}" },
      { id: 1, m: "GET", p: "/api/count" },
    ], { origin, authorization: "Bearer t" });
    req.headers.delete("cookie"); // nothing ambient: the app's cors may let it in
    return req;
  };
  const res = await app(cross(PARTNER));
  assertEquals(res.status, 200, "the app's cors lets the batch in");
  const { r } = await res.json();
  assertEquals(r[0].s, 403, "the route's own policy leaves the origin out");
  assertEquals(JSON.parse(r[0].t).error.code, "cors_forbidden");
  assertEquals(r[1].s, 200, "a route under the app's policy still answers");
  assertEquals(log.includes("narrow"), false, "the refused handler never ran");
  const allowed = await (await app(cross("https://only.example"))).json();
  assertEquals(allowed.r[0].s, 200);
  // A same-origin batch is unaffected.
  assertEquals(
    (await (await app(batch([{ id: 0, m: "POST", p: "/api/narrow", b: "{}" }])))
      .json()).r[0].s,
    200,
  );
});

Deno.test("api batch: a mutation whose answer is over the cap keeps its status (never a 5xx to retry)", async () => {
  const { app, store } = orderedApp({ apiBatch: { maxItemResponseBytes: 1000 } });
  const { r } = await (await app(batch([
    { id: 0, m: "POST", p: "/api/big" },
    { id: 1, m: "GET", p: "/api/big" },
  ]))).json();
  assertEquals(store.n, 1, "the write ran");
  assertEquals(r[0].s, 200, "its own status, not a 500");
  assertEquals(r[0].t, undefined);
  assertEquals(r[0].h["x-denext-batch-dropped"], "response too large");
  assertEquals(r[1].s, 500, "a read over the cap stays a 500 (safe to ask again)");
});

Deno.test("api batch mutations: malformed mutation items and apiBatch.mutations:false fail the whole batch", async () => {
  const { app, log } = orderedApp();
  const bad: unknown[] = [
    [{ id: 0, m: "GET", p: "/api/count", b: "{}" }], // a read with a body
    [{ id: 0, m: "POST", p: "/api/count", b: 7 }], // a non-string body
    [{ id: 0, m: "POST", p: "/api/count", h: { cookie: "x=1" } }], // a non-allowlisted header
    [{ id: 0, m: "POST", p: "/api/count", benc: 1 }], // a codec flag with no body
    [{ id: 0, m: "TRACE", p: "/api/count" }],
  ];
  for (const items of bad) {
    assertEquals((await app(batch(items))).status, 400, JSON.stringify(items));
  }
  const off = orderedApp({ apiBatch: { mutations: false } });
  const refused = await off.app(batch([{ id: 0, m: "POST", p: "/api/count", b: '{"by":1}' }]));
  assertEquals(refused.status, 400);
  assertEquals([...log, ...off.log], [], "nothing ran");
});

/** Pretend to be a browser bundle: hide the server's context bridge for the duration. */
async function asBrowser(fn: () => Promise<void>): Promise<void> {
  const g = globalThis as { __denextCurrentRequestContext?: unknown };
  const bridge = g.__denextCurrentRequestContext;
  delete g.__denextCurrentRequestContext;
  try {
    await fn();
  } finally {
    g.__denextCurrentRequestContext = bridge;
  }
}

/** A fetch that serves the app in-process and records each request it saw. */
function appFetch(app: (r: Request) => Promise<Response>, seen: Request[]): typeof fetch {
  return ((input: string, init?: RequestInit) => {
    const req = new Request(new URL(input, ORIGIN), {
      ...init,
      headers: {
        origin: ORIGIN,
        host: "localhost",
        ...Object.fromEntries(new Headers(init?.headers)),
      },
    });
    seen.push(req.clone());
    return app(req);
  }) as typeof fetch;
}

Deno.test("client: one tick's reads and mutations ride ONE batch, in order", () =>
  asBrowser(async () => {
    const { app, log } = orderedApp();
    const seen: Request[] = [];
    type S = {
      "/api/count": {
        GET: { response: { n: number } };
        POST: { body: { by: number }; response: { n: number } };
      };
    };
    const api = createApiClient<S>({ fetch: appFetch(app, seen) });
    const [a, b, c] = await Promise.all([
      api("/api/count", "POST", { body: { by: 4 } }),
      api("/api/count", "GET"),
      api("/api/count", "POST", { body: { by: 1 } }),
    ]);
    assertEquals([a, b, c], [{ n: 4 }, { n: 4 }, { n: 5 }]);
    assertEquals(seen.length, 1, "one round trip");
    assertEquals(new URL(seen[0].url).pathname, API_BATCH_PATH);
    assertEquals(log, ["add:4", "read:4", "add:1"]);

    // `batch: { mutations: false }` keeps the old behaviour: mutations go alone.
    seen.length = 0;
    const separate = createApiClient<S>({
      fetch: appFetch(app, seen),
      batch: { mutations: false },
    });
    await Promise.all([
      separate("/api/count", "POST", { body: { by: 1 } }),
      separate("/api/count", "GET"),
    ]);
    assertEquals(seen.map((r) => r.method).sort(), ["GET", "POST"]);
  }));

Deno.test("client: a mutation with a custom header other than x-csrf-token goes alone", () =>
  asBrowser(async () => {
    const { app } = orderedApp();
    const seen: Request[] = [];
    const api = createApiClient({ fetch: appFetch(app, seen) });
    await Promise.all([
      api(
        "/api/count" as never,
        "POST" as never,
        { body: { by: 1 }, headers: { "x-other": "1" } } as never,
      ),
      api("/api/count" as never, "GET" as never),
    ]);
    assertEquals(seen.length, 2, "the custom-header mutation did not join the batch");
  }));

// ── useApi seeding on non-Flight routes ─────────────────────────────────────

const routeBase = {
  kind: "page" as const,
  layoutChain: [],
  templateChain: [],
  loading: null,
  error: null,
  notFound: null,
  forbidden: null,
  unauthorized: null,
};

/** An isomorphic route (no "use client" boundary) whose page calls `useApi` in suspense mode. */
function isoApp(extra: Record<string, unknown> = {}) {
  const Data = () => {
    const { data } = useApi("/api/hello" as never, "GET" as never, undefined, { suspense: true });
    return h("p", null, (data as unknown as { hello: string }).hello);
  };
  const Page = () => h(Suspense, { fallback: h("i", null, "…"), children: h(Data, null) });
  const manifest: RouteManifest = {
    pages: [{
      ...routeBase,
      pattern: parsePattern("iso"),
      routePath: "/iso",
      filePath: "/app/page.tsx",
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
    "/app/page.tsx": { default: Page },
    "/app/api/hello/route.ts": { GET: () => json({ hello: "world" }) },
  };
  return createApp({
    getManifest: () => manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    clientEntryFor: () => "/_denext/entry.js",
    flight: true,
    appDir: "/app",
    ...extra,
  });
}

/** The `#__denext_state` island of a document. */
function stateOf(html: string): Record<string, { v: unknown; k: string }> {
  const m = /<script id="__denext_state" type="application\/json">(.*?)<\/script>/s.exec(html);
  assert(m, "the page carries the signal-state island");
  return JSON.parse(m[1]);
}

const helloKey = stableKey(["/api/hello", "GET", undefined, undefined, undefined]);

for (const streaming of [true, false]) {
  Deno.test(`useApi seeding: an isomorphic route records the suspense result (streaming ${streaming})`, async () => {
    const res = await isoApp({ streaming })(new Request(`${ORIGIN}/iso`));
    const html = await res.text();
    assertStringIncludes(html, "<p>world</p>");
    const seeds = Object.values(stateOf(html));
    assertEquals(seeds, [{ v: { hello: "world" }, k: helloKey }]);
  });
}

Deno.test("useApi seeding: an isomorphic soft navigation's payload carries the signal state", async () => {
  const res = await isoApp({ streaming: false })(
    new Request(`${ORIGIN}/iso`, { headers: { "x-denext-nav": "1" } }),
  );
  assertEquals(res.headers.get("x-denext-iso"), "1");
  const payload = await res.json() as IsoNavPayload;
  assertEquals(Object.values(payload.signalState ?? {}), [{ v: { hello: "world" }, k: helloKey }]);
});

Deno.test("useApi seeding: a route entry adopts #__denext_state before it hydrates", () => {
  const source = generateRouteEntry({
    ...routeBase,
    pattern: parsePattern("iso"),
    routePath: "/iso",
    filePath: "/app/page.tsx",
  });
  const adopt = source.indexOf('document.getElementById("__denext_state")');
  assert(adopt > 0, "the entry reads the state island");
  assert(adopt < source.indexOf("startClient(el, tree)"), "before hydration");
  assertStringIncludes(source, "globalThis.__denextSignalState = adoptedState");
});
