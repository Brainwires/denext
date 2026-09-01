// Coverage for the createApp request pipeline (src/server/app.ts): config-driven
// redirects/rewrites/headers, path canonicalization, basePath, middleware
// outcomes, Set-Cookie/outgoing-header application, HEAD, 404/405, custom error
// rendering + request-id echo, request logging, the concurrency ceiling, the
// request timeout, the plugin claim-hook, static assets, and the exported
// header/security helpers. Driven through an in-memory manifest + module loader
// (no build, no socket), the way tests/app.test.ts does.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  applyDefaultSecurityHeaders,
  createApp,
  hstsHeaderValue,
  routeUsesBoundary,
} from "../src/server/app.ts";
import type { AppConfig } from "../src/server/app.ts";
import type { PageRoute, RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import { cookies } from "../src/server/request-context.ts";
import type { MiddlewareOutcome } from "../src/server/middleware.ts";

// --- manifest / app helpers ------------------------------------------------

function page(routePath: string, filePath: string, pattern: string): PageRoute {
  return {
    kind: "page",
    pattern: parsePattern(pattern),
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

function manifest(partial: Partial<RouteManifest>): RouteManifest {
  return {
    pages: [],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
    ...partial,
  };
}

function makeApp(
  modules: Record<string, unknown>,
  m: RouteManifest,
  extra: Partial<AppConfig> = {},
) {
  return createApp({
    getManifest: () => m,
    load: (filePath) => Promise.resolve(modules[filePath]),
    ...extra,
  });
}

// --- config-driven URL handling --------------------------------------------

Deno.test("createApp: a config redirect emits 308 (permanent) / 307 (temporary) with Location", async () => {
  const app = makeApp({}, manifest({}), {
    redirects: [
      { source: "/old", destination: "/new", permanent: true },
      { source: "/temp", destination: "/here" },
    ],
  });
  const perm = await app(new Request("http://localhost/old"));
  await perm.body?.cancel();
  assertEquals(perm.status, 308);
  assertEquals(perm.headers.get("location"), "/new");

  const temp = await app(new Request("http://localhost/temp"));
  await temp.body?.cancel();
  assertEquals(temp.status, 307);
  assertEquals(temp.headers.get("location"), "/here");
});

Deno.test("createApp: trailingSlash normalizes with a 308 redirect", async () => {
  const app = makeApp(
    { "about.tsx": { default: () => h("h1", null, "About") } },
    manifest({ pages: [page("/about", "about.tsx", "about")] }),
    { trailingSlash: true },
  );
  const res = await app(new Request("http://localhost/about?q=1"));
  await res.body?.cancel();
  assertEquals(res.status, 308);
  assertEquals(res.headers.get("location"), "/about/?q=1");
});

Deno.test("createApp: a doubled slash canonicalizes with a 308 redirect", async () => {
  const app = makeApp({}, manifest({}));
  const res = await app(new Request("http://localhost//admin"));
  await res.body?.cancel();
  assertEquals(res.status, 308);
  assertEquals(res.headers.get("location"), "/admin");
});

Deno.test("createApp: basePath is stripped before routing", async () => {
  const app = makeApp(
    { "foo.tsx": { default: () => h("h1", null, "Foo") } },
    manifest({ pages: [page("/foo", "foo.tsx", "foo")] }),
    { basePath: "/app" },
  );
  const res = await app(new Request("http://localhost/app/foo"));
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), "<h1>Foo</h1>");
});

Deno.test("createApp: a rewrite internally routes to the destination page", async () => {
  const app = makeApp(
    { "real.tsx": { default: () => h("h1", null, "Real") } },
    manifest({ pages: [page("/real", "real.tsx", "real")] }),
    { rewrites: [{ source: "/pretty", destination: "/real" }] },
  );
  const res = await app(new Request("http://localhost/pretty"));
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), "<h1>Real</h1>");
});

Deno.test("createApp: header rules append configured headers to the response", async () => {
  const app = makeApp(
    { "p.tsx": { default: () => h("p", null, "hi") } },
    manifest({ pages: [page("/", "p.tsx", "")] }),
    { headerRules: [{ source: "/:path*", headers: [{ key: "x-custom", value: "yes" }] }] },
  );
  const res = await app(new Request("http://localhost/"));
  await res.text();
  assertEquals(res.headers.get("x-custom"), "yes");
});

// --- middleware outcomes ----------------------------------------------------

Deno.test("createApp: middleware returning a response short-circuits routing (with header rules merged)", async () => {
  const runner = (): Promise<MiddlewareOutcome> =>
    Promise.resolve({ type: "response", response: new Response("blocked", { status: 401 }) });
  const app = makeApp({}, manifest({}), {
    getMiddleware: () => runner,
    headerRules: [{ source: "/:path*", headers: [{ key: "x-mw", value: "1" }] }],
  });
  const res = await app(new Request("http://localhost/anything"));
  assertEquals(res.status, 401);
  assertEquals(await res.text(), "blocked");
  assertEquals(res.headers.get("x-mw"), "1");
});

Deno.test("createApp: middleware rewrite routes as the rewritten URL", async () => {
  const runner = (): Promise<MiddlewareOutcome> =>
    Promise.resolve({ type: "rewrite", url: "http://localhost/dest" });
  const app = makeApp(
    { "dest.tsx": { default: () => h("h1", null, "Dest") } },
    manifest({ pages: [page("/dest", "dest.tsx", "dest")] }),
    { getMiddleware: () => runner },
  );
  const res = await app(new Request("http://localhost/src"));
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), "<h1>Dest</h1>");
});

Deno.test("createApp: middleware next() headers land on the eventual page response", async () => {
  const headers = new Headers({ "x-from-mw": "yes" });
  const runner = (): Promise<MiddlewareOutcome> => Promise.resolve({ type: "next", headers });
  const app = makeApp(
    { "p.tsx": { default: () => h("p", null, "ok") } },
    manifest({ pages: [page("/", "p.tsx", "")] }),
    { getMiddleware: () => runner },
  );
  const res = await app(new Request("http://localhost/"));
  await res.text();
  assertEquals(res.headers.get("x-from-mw"), "yes");
});

Deno.test("createApp: middleware requestHeaders override is visible to the downstream handler", async () => {
  const requestHeaders = new Headers({ "x-user": "alice" });
  const runner = (): Promise<MiddlewareOutcome> =>
    Promise.resolve({ type: "next", requestHeaders });
  const app = makeApp(
    { "who.ts": { GET: (r: Request) => Response.json({ user: r.headers.get("x-user") }) } },
    manifest({
      api: [{
        kind: "api",
        pattern: parsePattern("api/who"),
        routePath: "/api/who",
        filePath: "who.ts",
      }],
    }),
    { getMiddleware: () => runner },
  );
  const res = await app(new Request("http://localhost/api/who"));
  assertEquals(await res.json(), { user: "alice" });
});

// --- outgoing headers (Set-Cookie) via applyOutgoing -----------------------

Deno.test("createApp: cookies().set() in a route handler emits Set-Cookie through finalize", async () => {
  const app = makeApp(
    {
      "login.ts": {
        POST: () => {
          cookies().set("session", "abc", { path: "/" });
          return new Response("done");
        },
      },
    },
    manifest({
      api: [{
        kind: "api",
        pattern: parsePattern("api/login"),
        routePath: "/api/login",
        filePath: "login.ts",
      }],
    }),
  );
  const res = await app(new Request("http://localhost/api/login", { method: "POST" }));
  assertEquals(res.status, 200);
  const setCookie = res.headers.get("set-cookie");
  assert(setCookie, "a Set-Cookie header is present");
  assertStringIncludes(setCookie!, "session=abc");
});

// --- HEAD / 404 -------------------------------------------------------------

Deno.test("createApp: a HEAD request to a page returns 200 with a null body", async () => {
  const app = makeApp(
    { "p.tsx": { default: () => h("h1", null, "Head") } },
    manifest({ pages: [page("/", "p.tsx", "")] }),
  );
  const res = await app(new Request("http://localhost/", { method: "HEAD" }));
  assertEquals(res.status, 200);
  assertEquals(res.body, null);
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
});

Deno.test("createApp: an unmatched HEAD request renders the 404 with a null body", async () => {
  const app = makeApp({}, manifest({}));
  const res = await app(new Request("http://localhost/missing", { method: "HEAD" }));
  assertEquals(res.status, 404);
  assertEquals(res.body, null);
});

// --- error handling: custom renderer + request-id echo ---------------------

Deno.test("createApp: a throwing page falls back to a 500 that carries x-request-id and leaks nothing", async () => {
  const app = makeApp(
    {
      "boom.tsx": {
        default: () => {
          throw new Error("secret internal detail 10.0.0.9");
        },
      },
    },
    manifest({ pages: [page("/", "boom.tsx", "")] }),
  );
  const res = await app(new Request("http://localhost/"));
  const body = await res.text();
  assertEquals(res.status, 500);
  assert(res.headers.get("x-request-id"), "the 500 carries a correlation id");
  assert(!body.includes("secret internal detail"), "the error message must not leak");
});

Deno.test("createApp: a custom onError renderer handles a thrown page", async () => {
  const calls: unknown[] = [];
  const app = makeApp(
    {
      "boom.tsx": {
        default: () => {
          throw new Error("kaboom");
        },
      },
    },
    manifest({ pages: [page("/", "boom.tsx", "")] }),
    {
      onError: (err) => {
        calls.push(err);
        return new Response("handled", { status: 503 });
      },
    },
  );
  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 503);
  assertEquals(await res.text(), "handled");
  assertEquals(calls.length, 1);
});

Deno.test("createApp: a throwing onError renderer still yields a 500 with x-request-id", async () => {
  const app = makeApp(
    {
      "boom.tsx": {
        default: () => {
          throw new Error("kaboom");
        },
      },
    },
    manifest({ pages: [page("/", "boom.tsx", "")] }),
    {
      onError: () => {
        throw new Error("renderer also failed");
      },
    },
  );
  const res = await app(new Request("http://localhost/"));
  await res.text();
  assertEquals(res.status, 500);
  assert(res.headers.get("x-request-id"));
});

Deno.test("createApp: onRequestError instrumentation is reported for a thrown API handler", async () => {
  const seen: Array<{ routeType?: string }> = [];
  const app = makeApp(
    {
      "t.ts": {
        GET: () => {
          throw new Error("api failure");
        },
      },
    },
    manifest({
      api: [{ kind: "api", pattern: parsePattern("api/t"), routePath: "/api/t", filePath: "t.ts" }],
    }),
    {
      onRequestError: (_err, _req, ctx) => {
        seen.push({ routeType: ctx.routeType });
      },
    },
  );
  const res = await app(new Request("http://localhost/api/t"));
  await res.text();
  assertEquals(res.status, 500);
  assertEquals(seen.length, 1);
  assertEquals(seen[0].routeType, "route");
});

// --- observability ----------------------------------------------------------

Deno.test("createApp: onRequest observability fires with method/path/status/requestId", async () => {
  const logs: Array<{ method: string; path: string; status: number; requestId: string }> = [];
  const app = makeApp(
    { "p.tsx": { default: () => h("p", null, "ok") } },
    manifest({ pages: [page("/", "p.tsx", "")] }),
    {
      onRequest: (info) =>
        logs.push({
          method: info.method,
          path: info.path,
          status: info.status,
          requestId: info.requestId,
        }),
    },
  );
  const res = await app(new Request("http://localhost/"));
  await res.text();
  assertEquals(logs.length, 1);
  assertEquals(logs[0].method, "GET");
  assertEquals(logs[0].path, "/");
  assertEquals(logs[0].status, 200);
  assert(logs[0].requestId.length > 0);
});

// --- concurrency ceiling ----------------------------------------------------

Deno.test("createApp: maxConcurrency sheds an over-capacity request with 503 + Retry-After", async () => {
  const gate = Promise.withResolvers<void>();
  const logs: number[] = [];
  const app = makeApp(
    {
      "slow.tsx": {
        default: async () => {
          await gate.promise;
          return h("p", null, "slow");
        },
      },
    },
    manifest({ pages: [page("/", "slow.tsx", "")] }),
    { maxConcurrency: 1, onRequest: (i) => logs.push(i.status) },
  );

  // First request claims the only slot (its render is parked on the gate).
  const first = app(new Request("http://localhost/"));
  // Second request arrives at capacity → shed immediately.
  const shed = await app(new Request("http://localhost/"));
  await shed.body?.cancel();
  assertEquals(shed.status, 503);
  assertEquals(shed.headers.get("retry-after"), "1");

  // Release the first render so the slot frees and its response settles.
  gate.resolve();
  const firstRes = await first;
  await firstRes.text();
  assertEquals(firstRes.status, 200);
  // The shed request was surfaced to observability with a 0ms/"shed" record.
  assert(logs.includes(503), "the shed request was logged");
});

// --- request timeout --------------------------------------------------------

Deno.test("createApp: a render exceeding requestTimeout resolves as a 503", async () => {
  const gate = Promise.withResolvers<void>();
  const app = makeApp(
    {
      "hang.tsx": {
        default: async () => {
          await gate.promise;
          return h("p", null, "eventually");
        },
      },
    },
    manifest({ pages: [page("/", "hang.tsx", "")] }),
    { requestTimeout: 25 },
  );
  const res = await app(new Request("http://localhost/"));
  const body = await res.text();
  assertEquals(res.status, 503);
  assertStringIncludes(body, "timeout");
  assert(res.headers.get("x-request-id"), "the timeout 503 echoes a request id");
  // Let the parked render unwind so it holds nothing after the test.
  gate.resolve();
  await Promise.resolve();
});

// --- plugin claim-hook + static assets + security headers ------------------

Deno.test("createApp: matchExternal claims a request the core router did not match", async () => {
  const app = makeApp({}, manifest({}), {
    matchExternal: (req) =>
      new URL(req.url).pathname === "/claimed" ? new Response("by plugin") : null,
  });
  const claimed = await app(new Request("http://localhost/claimed"));
  assertEquals(claimed.status, 200);
  assertEquals(await claimed.text(), "by plugin");

  const unclaimed = await app(new Request("http://localhost/nope"));
  await unclaimed.body?.cancel();
  assertEquals(unclaimed.status, 404);
});

Deno.test("createApp: static assets are served from publicDir", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_app_static_" });
  try {
    await Deno.writeTextFile(`${dir}/hello.txt`, "static-body");
    const app = makeApp({}, manifest({}), { publicDir: dir });
    const res = await app(new Request("http://localhost/hello.txt"));
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "static-body");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createApp: default hardening headers are applied to a normal page response", async () => {
  const app = makeApp(
    { "p.tsx": { default: () => h("p", null, "ok") } },
    manifest({ pages: [page("/", "p.tsx", "")] }),
  );
  const res = await app(new Request("http://localhost/"));
  await res.text();
  assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  assertEquals(res.headers.get("x-frame-options"), "SAMEORIGIN");
  assertEquals(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  // Plain-HTTP request: no HSTS pin.
  assertEquals(res.headers.get("strict-transport-security"), null);
  // The vary key for hard/soft-nav variants.
  assertStringIncludes(res.headers.get("vary") ?? "", "x-denext-nav");
});

Deno.test("createApp: an https request gets a Strict-Transport-Security header", async () => {
  const app = makeApp(
    { "p.tsx": { default: () => h("p", null, "ok") } },
    manifest({ pages: [page("/", "p.tsx", "")] }),
  );
  const res = await app(new Request("https://secure.example/"));
  await res.text();
  assertStringIncludes(res.headers.get("strict-transport-security") ?? "", "max-age=");
});

// --- exported header/security helpers (direct) -----------------------------

Deno.test("hstsHeaderValue: default, includeSubDomains, preload, and disabled", () => {
  assertEquals(hstsHeaderValue(), "max-age=31536000");
  assertEquals(hstsHeaderValue({ maxAge: 60 }), "max-age=60");
  assertEquals(
    hstsHeaderValue({ includeSubDomains: true }),
    "max-age=31536000; includeSubDomains",
  );
  assertEquals(
    hstsHeaderValue({ preload: true }),
    "max-age=31536000; includeSubDomains; preload",
  );
  assertEquals(hstsHeaderValue(false), null);
});

Deno.test("applyDefaultSecurityHeaders: sets defaults, never overrides, and rebuilds immutable headers", () => {
  // Mutable path: defaults set, an app-set header preserved.
  const res = new Response("x", { headers: { "x-frame-options": "DENY" } });
  const out = applyDefaultSecurityHeaders(res, false);
  assertEquals(out.headers.get("x-content-type-options"), "nosniff");
  assertEquals(out.headers.get("x-frame-options"), "DENY", "an app value is not overridden");
  assertEquals(
    out.headers.get("strict-transport-security"),
    null,
    "no HSTS on an insecure request",
  );

  // Secure request → HSTS added.
  const secure = applyDefaultSecurityHeaders(new Response("x"), true);
  assertStringIncludes(secure.headers.get("strict-transport-security") ?? "", "max-age=");

  // Immutable headers (a redirect) → rebuilt, status/body preserved.
  const redirect = Response.redirect("https://example.com/next", 307);
  const rebuilt = applyDefaultSecurityHeaders(redirect, true);
  assertEquals(rebuilt.status, 307);
  assertEquals(rebuilt.headers.get("x-content-type-options"), "nosniff");
});

Deno.test("routeUsesBoundary: true only when a route module carries the client directive", () => {
  const r = page("/x", "x.tsx", "x");
  r.error = "error.tsx";
  const directives = new Map<string, "client" | "server">([["error.tsx", "client"]]);
  assert(routeUsesBoundary(r, directives));
  assert(!routeUsesBoundary(r, new Map([["error.tsx", "server"]])));
  assert(!routeUsesBoundary(r, undefined), "no directives → false");
  assert(!routeUsesBoundary(r, new Map()), "empty directives → false");
});
