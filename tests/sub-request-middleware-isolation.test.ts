// The app's own `middleware.ts` runs inside an in-process API call made during a cacheable render
// (ISR, a PPR prerender, a Flight PPR prerender), under the visitor's own cookie and
// authorization. A middleware that reads them and then rewrites the call or overrides a request
// header the handler reads hands the handler a per-visitor answer the handler itself never
// sees as inherited: the read in the middleware must make the caller's render per-visitor, as a
// read in the handler does (see `sub-request-cache-isolation.test.ts`). Covered: raw header
// reads, a `NextRequest`'s `cookies`, `cookies()` / `headers()`, and a matcher's `has`
// condition on the cookie. A middleware that reads no inherited header leaves the page
// cacheable. Bob must never be served Alice's data.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { json } from "../src/server/typed-response.ts";
import { cookies, headers } from "../src/server/request-context.ts";
import {
  createMiddlewareRunner,
  type MiddlewareModule,
  rewrite,
  setRequestAdapter,
} from "../src/server/middleware.ts";
import { NextRequest, NextResponse } from "../src/compat/next/server.ts";
import { createApiClient } from "../src/runtime/api-client.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { inMemoryCacheStore, PageCache, setCacheStore } from "../src/server/cache.ts";
import type { VNode } from "../src/jsx/types.ts";

const ORIGIN = "http://localhost";

// Importing `next/server` installed the `NextRequest` adapter; the plain-Request cases run
// without it (the default for an app that never imports `next/server`).
const NEXT_REQUEST = (r: Request) =>
  r instanceof NextRequest ? r : new NextRequest(r.body ? r.clone() : r);
const PLAIN = (r: Request) => r;

/** The cookie's `u` value from a raw `Cookie` header. */
const userOf = (cookie: string | null) => /(?:^|;\s*)u=([^;]*)/.exec(cookie ?? "")?.[1] ?? "anon";

/** One middleware shape under test: how it learns the visitor, and how it hands it on. */
interface Case {
  name: string;
  nextRequest: boolean;
  mod: MiddlewareModule;
}

/** Hand `u` to the handler on the rewritten URL (the handler reads no inherited header). */
const rewriteTo = (u: string) => rewrite(`/api/me?u=${encodeURIComponent(u)}`);
/** Hand `u` to the handler in a request header it reads (not one the self-call inherited). */
const overrideHeader = (u: string) =>
  NextResponse.next({ request: { headers: new Headers({ "x-user": u }) } });

const MATCH = { matcher: "/api/me" };

const CASES: Case[] = [
  {
    name: "a raw headers.get('cookie') then rewrite",
    nextRequest: false,
    mod: {
      middleware: (req: Request) => rewriteTo(userOf(req.headers.get("cookie"))),
      config: MATCH,
    },
  },
  {
    name: "a raw header iteration then a request-header override",
    nextRequest: false,
    mod: {
      middleware: (req: Request) =>
        overrideHeader(userOf([...req.headers].find(([k]) => k === "cookie")?.[1] ?? null)),
      config: MATCH,
    },
  },
  {
    name: "a NextRequest's cookies then a request-header override",
    nextRequest: true,
    mod: {
      middleware: (req: Request) =>
        overrideHeader((req as NextRequest).cookies.get("u")?.value ?? "anon"),
      config: MATCH,
    },
  },
  {
    name: "a NextRequest's headers.has('authorization') then rewrite",
    nextRequest: true,
    mod: {
      middleware: (req: Request) => {
        const auth = req.headers.has("authorization");
        return rewriteTo(auth ? `authed-${crypto.randomUUID()}` : "anon");
      },
      config: MATCH,
    },
  },
  {
    name: "cookies() then rewrite",
    nextRequest: false,
    mod: { middleware: () => rewriteTo(cookies().get("u")?.value ?? "anon"), config: MATCH },
  },
  {
    name: "headers() then a request-header override",
    nextRequest: true,
    mod: {
      middleware: () => overrideHeader(userOf(headers().get("cookie"))),
      config: MATCH,
    },
  },
  {
    name: "a matcher's has-cookie condition",
    nextRequest: false,
    mod: {
      middleware: () => rewriteTo("alice-only"),
      config: {
        matcher: [{ source: "/api/me", has: [{ type: "cookie", key: "u", value: "alice" }] }],
      },
    },
  },
];

/** A Server Component that calls the app's own API in-process. */
async function Me(): Promise<VNode> {
  const me = await createApiClient()("/api/me" as never, "GET" as never) as { u: string };
  return h("p", null, `me=${me.u}`);
}

type Mode = "isr" | "ppr" | "flight-ppr";

function app(mod: MiddlewareModule, mode: Mode) {
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
    "/app/api/me/route.ts": {
      // Reads only what the middleware handed on: never an inherited header.
      GET: (req: Request) =>
        json({
          u: new URL(req.url).searchParams.get("u") ?? req.headers.get("x-user") ?? "nobody",
        }),
    },
  };
  return createApp({
    getManifest: () => manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    clientEntryFor: () => "/_denext/entry.js",
    flight: true,
    appDir: "/app",
    pageCache: new PageCache(),
    cacheComponents: mode !== "isr",
    getMiddleware: () => Promise.resolve(createMiddlewareRunner(mod)),
    ...(mode === "flight-ppr" ? { flightRoutes: new Set(["/"]) } : {}),
  });
}

/** Alice then Bob; what each was served. */
async function visit(c: Case, mode: Mode) {
  setCacheStore(inMemoryCacheStore());
  setRequestAdapter(c.nextRequest ? NEXT_REQUEST : PLAIN);
  try {
    const handler = app(c.mod, mode);
    const out: { status: number; cache: string | null; me: string | undefined; html: string }[] =
      [];
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
  } finally {
    setRequestAdapter(NEXT_REQUEST);
  }
}

for (const mode of ["isr", "ppr", "flight-ppr"] as const) {
  for (const c of CASES) {
    Deno.test(`sub-request middleware isolation (${mode}): ${c.name} never leaks Alice's data to Bob`, async () => {
      const [alice, bob] = await visit(c, mode);
      assertEquals([alice.status, bob.status], [200, 200], alice.html.slice(0, 300));
      assert(alice.me && !alice.me.includes("bob"), `alice saw ${alice.me}`);
      assert(bob.me, `bob was served the data (${bob.html.slice(0, 300)})`);
      assert(!bob.me.includes("alice"), `bob was served alice's data: ${bob.me}`);
      if (c.name.includes("has('authorization')")) assert(bob.me !== alice.me, "bob's call ran");
      else if (!c.name.includes("matcher")) assertStringIncludes(bob.me, "bob");
    });
  }

  Deno.test(`sub-request middleware isolation (${mode}): a middleware reading no inherited header stays cacheable`, async () => {
    const [first, second] = await visit({
      name: "static rewrite",
      nextRequest: true,
      mod: {
        middleware: (req: Request) =>
          req.headers.get("x-denext-none") === null ? rewriteTo("everyone") : rewriteTo("?"),
        config: MATCH,
      },
    }, mode);
    assertEquals([first.me, second.me], ["everyone", "everyone"]);
    assertEquals(first.cache, "MISS");
    assertEquals(second.cache, "HIT", "the page (or its shell) was stored");
  });
}
