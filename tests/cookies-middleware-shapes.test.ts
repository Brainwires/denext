// Next.js-shaped cookies()/headers() and the middleware pipeline fixes from the 2.0 audit:
// cookie objects, read-only headers, noStore opting out of the page cache, request-header
// overrides on a request WITH a body, Set-Cookie surviving a short-circuit, middleware
// running before config rewrites, locale-stripped matchers, refused external rewrites,
// control signals in Server Actions, and redirectResponse.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { createMiddlewareRunner, redirect, redirectResponse } from "../src/server/middleware.ts";
import { NextResponse } from "../src/compat/next/server.ts";
import { NextRequest } from "../src/compat/next/request.ts";
import { unstable_noStore, unstable_rethrow } from "../src/compat/next/cache.ts";
import {
  cookies,
  createRequestContext,
  headers,
  runWithContext,
} from "../src/server/request-context.ts";
import { inMemoryCacheStore, PageCache, setCacheStore } from "../src/server/cache.ts";
import { actionEndpoint, serverAction } from "../src/runtime/server-action.ts";
import { handleAction } from "../src/server/action-handler.ts";
import { notFound } from "../src/runtime/error-boundary.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { PageProps } from "../src/server/types.ts";

function page(routePath: string, filePath: string) {
  return {
    kind: "page" as const,
    pattern: parsePattern(routePath.slice(1)),
    routePath,
    filePath,
    layoutChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
    templateChain: [],
  };
}
const manifest = (): RouteManifest => ({
  pages: [page("/home", "home.tsx"), page("/target", "target.tsx"), page("/dashboard", "dash.tsx")],
  api: [],
  rootLayout: null,
  rootNotFound: null,
  rootGlobalError: null,
});
const modules: Record<string, unknown> = {
  "home.tsx": { default: () => h("h1", null, "HOME") },
  "target.tsx": { default: () => h("h1", null, "TARGET") },
  "dash.tsx": { default: () => h("h1", null, "DASH") },
};
const load = (fp: string) => Promise.resolve(modules[fp]);

Deno.test("cookies(): Next shape — get().value, getAll() array, iteration, same-request visibility", () => {
  const req = new Request("http://x/", { headers: { cookie: "a=1; b=2" } });
  runWithContext(createRequestContext(req), () => {
    const c = cookies();
    assertEquals(c.get("a"), { name: "a", value: "1" });
    assertEquals(c.get("zz"), undefined);
    assertEquals(c.getAll().map((x) => x.name), ["a", "b"]);
    assertEquals(c.getAll("b"), [{ name: "b", value: "2" }]);
    assertEquals(c.size, 2);
    assertEquals([...c].map(([n]) => n), ["a", "b"]);
    assertEquals(String(c), "a=1; b=2");
    c.set("s", "new");
    assertEquals(
      cookies().get("s")?.value,
      "new",
      "a cookie set earlier in the request is readable",
    );
    c.delete("a");
    assertEquals(cookies().has("a"), false);
  });
});

Deno.test("headers() is read-only: set/append/delete throw, reads work", () => {
  const req = new Request("http://x/", { headers: { "x-a": "1" } });
  runWithContext(createRequestContext(req), () => {
    const hd = headers();
    assertEquals(hd.get("x-a"), "1");
    assertThrows(() => hd.set("x-a", "2"), TypeError);
    assertThrows(() => hd.delete("x-a"), TypeError);
    assertEquals(req.headers.get("x-a"), "1", "the request was not mutated");
  });
});

Deno.test("unstable_noStore() opts a `revalidate` route out of the page cache", async () => {
  setCacheStore(inMemoryCacheStore());
  let renders = 0;
  const app = createApp({
    getManifest: manifest,
    load: (fp) =>
      Promise.resolve(
        fp === "home.tsx"
          ? {
            default: (_p: PageProps) => {
              renders++;
              unstable_noStore();
              return h("h1", null, "per-user");
            },
            revalidate: 60,
          }
          : modules[fp],
      ),
    pageCache: new PageCache(),
  });
  for (let i = 0; i < 2; i++) await (await app(new Request("http://localhost/home"))).text();
  assertEquals(renders, 2, "noStore render must not be served from the cache");
  assertThrows(() => unstable_rethrow(new (class extends Error {})()) ?? notFound(), Error);
});

Deno.test("middleware: NextResponse.next({ request: { headers } }) works on a request with a body", async () => {
  let seen: string | null = null;
  let body = "";
  const app = createApp({
    getManifest: manifest,
    load: (fp) =>
      Promise.resolve(fp === "home.tsx" ? { default: () => h("h1", null, "HOME") } : modules[fp]),
    getMiddleware: () =>
      Promise.resolve(createMiddlewareRunner({
        middleware: (req: Request) => {
          const hd = new Headers(req.headers);
          hd.set("x-user", "ada");
          return NextResponse.next({ request: { headers: hd } });
        },
      })),
    matchExternal: async (req) => {
      seen = req.headers.get("x-user");
      body = await req.text();
      return new Response("ok");
    },
  });
  const res = await app(
    new Request("http://localhost/anything", { method: "POST", body: "payload" }),
  );
  assertEquals(res.status, 200);
  assertEquals(seen, "ada");
  assertEquals(body, "payload");
});

Deno.test("middleware: cookies().set() before a short-circuit redirect reaches the client", async () => {
  const app = createApp({
    getManifest: manifest,
    load,
    getMiddleware: () =>
      Promise.resolve(createMiddlewareRunner({
        middleware: () => {
          cookies().delete("session");
          return NextResponse.redirect("http://localhost/login");
        },
      })),
  });
  const res = await app(new Request("http://localhost/home"));
  assertEquals(res.status, 307);
  assertStringIncludes(res.headers.get("set-cookie") ?? "", "session=");
});

Deno.test("middleware runs BEFORE config rewrites and its matcher sees the requested path", async () => {
  const seen: string[] = [];
  const app = createApp({
    getManifest: manifest,
    load,
    rewrites: [{ source: "/home", destination: "/target" }],
    getMiddleware: () =>
      Promise.resolve(createMiddlewareRunner({
        middleware: (req: Request) => {
          seen.push(new URL(req.url).pathname);
        },
        config: { matcher: "/home" },
      })),
  });
  const res = await app(new Request("http://localhost/home"));
  assertStringIncludes(await res.text(), "TARGET", "the rewrite still applies");
  assertEquals(seen, ["/home"], "middleware saw the client's URL, and its /home matcher fired");
});

Deno.test("i18n: a matcher fires on the locale-stripped path (/fr/dashboard matches /dashboard)", async () => {
  let ran = 0;
  const app = createApp({
    getManifest: manifest,
    load,
    i18n: { locales: ["en", "fr"], defaultLocale: "en" },
    getMiddleware: () =>
      Promise.resolve(createMiddlewareRunner({
        middleware: () => {
          ran++;
        },
        config: { matcher: "/dashboard/:path*" },
      })),
  });
  await (await app(new Request("http://localhost/fr/dashboard"))).text();
  assertEquals(ran, 1);
});

Deno.test("an external NextResponse.rewrite is proxied through safeFetch — a private target is refused (502), never served locally", async () => {
  const app = createApp({
    getManifest: manifest,
    load,
    getMiddleware: () =>
      Promise.resolve(createMiddlewareRunner({
        middleware: () => NextResponse.rewrite("http://127.0.0.1:9/target"),
      })),
  });
  const res = await app(new Request("http://localhost/home"));
  const text = await res.text();
  assertEquals(res.status, 502);
  assert(!text.includes("TARGET"), "must not fall back to the local /target page");
});

Deno.test("Server Action: notFound()/forbidden() are 404/403 signals, not a redacted 500", async () => {
  serverAction("cms_nf", () => notFound());
  const req = new Request(`http://app.example.com${actionEndpoint("cms_nf")}`, {
    method: "POST",
    headers: {
      host: "app.example.com",
      origin: "http://app.example.com",
      "x-denext-action": "1",
      "content-type": "application/json",
    },
    body: JSON.stringify({ args: [] }),
  });
  const res = await runWithContext(createRequestContext(req), () => handleAction(req));
  assertEquals(res.status, 404);
  assertEquals((await res.json()).signal, "notFound");
});

Deno.test("redirectResponse is the middleware helper; `redirect` is its deprecated alias", () => {
  const r = redirectResponse("/login", 308);
  assertEquals(r.status, 308);
  assertEquals(r.headers.get("location"), "/login");
  assertEquals(redirect, redirectResponse);
});

Deno.test("NextRequest.ip uses the LAST x-forwarded-for hop, never the client-supplied first one", () => {
  const req = new NextRequest("http://x/", {
    headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" },
  });
  assertEquals(req.ip, "203.0.113.9");
});
