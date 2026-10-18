// An in-process API call made during a cacheable render (ISR, a PPR prerender, a Flight PPR
// prerender) runs under the visitor's own cookies. A handler that reads them — `cookies()`,
// `headers()`, or the request's raw `headers` (get / has / iteration) — produces per-visitor
// output, so the render must not be stored for other visitors: the read makes the parent render
// dynamic (ISR) or postpones the enclosing Suspense boundary into a per-request hole (PPR). A
// handler that reads none of them stays cacheable. Bob must never be served Alice's data.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { json } from "../src/server/typed-response.ts";
import { cookies, headers } from "../src/server/request-context.ts";
import { createApiClient } from "../src/runtime/api-client.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { inMemoryCacheStore, PageCache, setCacheStore } from "../src/server/cache.ts";
import type { VNode } from "../src/jsx/types.ts";

const ORIGIN = "http://localhost";

/** How the API handler learns who is calling. */
type Read = "none" | "raw-get" | "raw-has" | "raw-iterate" | "raw-foreach" | "cookies" | "headers";

/** Handler runs so far (a `has()` read reveals no name, so its answer carries the run). */
let runs = 0;

/** The cookie the handler saw, by the read under test. */
const READERS: Record<Read, (req: Request) => string> = {
  "none": () => "everyone",
  "raw-get": (req) => req.headers.get("cookie") ?? "anon",
  "raw-has": (req) => `${req.headers.has("authorization") ? "authed" : "anon"}#${++runs}`,
  "raw-iterate": (req) => [...req.headers].find(([k]) => k === "cookie")?.[1] ?? "anon",
  "raw-foreach": (req) => {
    let out = "anon";
    req.headers.forEach((v, k) => {
      if (k === "cookie") out = v;
    });
    return out;
  },
  "cookies": () => cookies().get("u")?.value ?? "anon",
  "headers": () => headers().get("cookie") ?? "anon",
};

const who = (req: Request, read: Read): string => READERS[read](req);

/** A Server Component that calls the app's own API in-process. */
async function Me(): Promise<VNode> {
  const me = await createApiClient()("/api/me" as never, "GET" as never) as { u: string };
  return h("p", null, `me=${me.u}`);
}

type Mode = "isr" | "ppr" | "flight-ppr";

function app(read: Read, mode: Mode) {
  const page = {
    kind: "page" as const,
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
  };
  const manifest: RouteManifest = {
    pages: [page],
    api: [{
      kind: "api",
      pattern: parsePattern("/api/me"),
      routePath: "/api/me",
      filePath: "/app/api/me/route.ts",
    }],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
    directives: new Map(),
  };
  const Page = () =>
    h("main", null, h(Suspense, { fallback: h("i", null, "loading"), children: h(Me, null) }));
  const modules: Record<string, unknown> = {
    "/app/page.tsx": { default: Page, revalidate: 60 },
    "/app/api/me/route.ts": { GET: (req: Request) => json({ u: who(req, read) }) },
  };
  return createApp({
    getManifest: () => manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    clientEntryFor: () => "/_denext/entry.js",
    flight: true,
    appDir: "/app",
    pageCache: new PageCache(),
    cacheComponents: mode !== "isr",
    ...(mode === "flight-ppr" ? { flightRoutes: new Set(["/"]) } : {}),
  });
}

/** Alice then Bob; what each was served. */
async function visit(read: Read, mode: Mode) {
  setCacheStore(inMemoryCacheStore());
  const handler = app(read, mode);
  const out: { status: number; cache: string | null; me: string | undefined; html: string }[] = [];
  for (const user of ["alice", "bob"]) {
    const res = await handler(
      new Request(`${ORIGIN}/`, {
        headers: { cookie: `u=${user}`, authorization: `Bearer ${user}` },
      }),
    );
    const html = await res.text();
    out.push({
      status: res.status,
      cache: res.headers.get("x-denext-cache"),
      me: />me=([^<]*)/.exec(html)?.[1],
      html,
    });
  }
  return out;
}

const READS: Read[] = ["raw-get", "raw-has", "raw-iterate", "raw-foreach", "cookies", "headers"];

for (const mode of ["isr", "ppr", "flight-ppr"] as const) {
  for (const read of READS) {
    Deno.test(`sub-request cache isolation (${mode}): a handler reading ${read} never leaks Alice's data to Bob`, async () => {
      const [alice, bob] = await visit(read, mode);
      assertEquals([alice.status, bob.status], [200, 200], alice.html.slice(0, 300));
      assert(alice.me && !alice.me.includes("bob"), `alice saw ${alice.me}`);
      assert(bob.me, `bob was served the data (${bob.html.slice(0, 300)})`);
      assert(!bob.me.includes("alice"), `bob was served alice's data: ${bob.me}`);
      if (read === "raw-has") assert(bob.me !== alice.me, "bob's call ran for bob");
      else assertStringIncludes(bob.me, "bob");
    });
  }

  Deno.test(`sub-request cache isolation (${mode}): a handler that reads no header stays cacheable`, async () => {
    const [first, second] = await visit("none", mode);
    assertEquals([first.me, second.me], ["everyone", "everyone"]);
    assertEquals(first.cache, "MISS");
    assertEquals(second.cache, "HIT", "the page (or its shell) was stored");
  });
}
