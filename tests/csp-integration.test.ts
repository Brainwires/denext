// End-to-end CSP: a document response carries a hash-based Content-Security-Policy;
// per-route `export const csp` opts external hosts in; a cache hit reuses the
// stored policy; an app-set CSP wins.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { createMiddlewareRunner, next } from "../src/server/middleware.ts";
import { inMemoryCacheStore, PageCache, setCacheStore } from "../src/server/cache.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import type { PageProps } from "../src/server/types.ts";

function manifest(): RouteManifest {
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
    pages: [{ ...base, pattern: parsePattern("/"), routePath: "/", filePath: "home.tsx" }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
}

function appWith(homeModule: unknown, extra: Record<string, unknown> = {}) {
  return createApp({
    getManifest: manifest,
    load: (fp: string) => Promise.resolve(fp === "home.tsx" ? homeModule : undefined),
    ...extra,
  });
}

Deno.test("a page response carries a strict default CSP", async () => {
  const app = appWith({ default: (_p: PageProps) => h("h1", null, "home") });
  const res = await app(new Request("http://localhost/"));
  await res.text();
  const csp = res.headers.get("content-security-policy");
  assert(csp, "CSP header present");
  assertStringIncludes(csp!, "default-src 'self'");
  assertStringIncludes(csp!, "object-src 'none'");
  assertStringIncludes(csp!, "frame-ancestors 'self'");
});

Deno.test("per-route csp export opts an external host into script-src", async () => {
  const app = appWith({
    default: (_p: PageProps) => h("h1", null, "home"),
    csp: { scriptSrc: ["https://plausible.io"], styleSrc: ["https://fonts.googleapis.com"] },
  });
  const res = await app(new Request("http://localhost/"));
  await res.text();
  const csp = res.headers.get("content-security-policy")!;
  assertStringIncludes(csp, "script-src 'self' https://plausible.io");
  assertStringIncludes(csp, "style-src 'self' https://fonts.googleapis.com");
});

Deno.test("a cache hit reuses the stored CSP", async () => {
  setCacheStore(inMemoryCacheStore());
  const app = appWith(
    { default: (_p: PageProps) => h("h1", null, "cached"), revalidate: 60 },
    { pageCache: new PageCache() },
  );
  const r1 = await app(new Request("http://localhost/"));
  await r1.text();
  assertEquals(r1.headers.get("x-denext-cache"), "MISS");
  const csp1 = r1.headers.get("content-security-policy");

  const r2 = await app(new Request("http://localhost/"));
  await r2.text();
  assertEquals(r2.headers.get("x-denext-cache"), "HIT");
  assertEquals(r2.headers.get("content-security-policy"), csp1);
  assert(csp1, "the stored CSP is served on the hit");
});

Deno.test("global csp: 'off' emits no CSP header", async () => {
  const app = appWith({ default: (_p: PageProps) => h("h1", null, "home") }, { csp: "off" });
  const res = await app(new Request("http://localhost/"));
  await res.text();
  assertEquals(res.headers.get("content-security-policy"), null);
});

Deno.test("global csp: 'off' but a route re-enables via its own csp export", async () => {
  const app = appWith(
    { default: (_p: PageProps) => h("h1", null, "home"), csp: "strict" },
    { csp: "off" },
  );
  const res = await app(new Request("http://localhost/"));
  await res.text();
  const csp = res.headers.get("content-security-policy");
  assert(csp, "the route's csp:'strict' overrides the global 'off'");
  assertStringIncludes(csp!, "script-src 'self'");
});

Deno.test("global strict but a route opts out with csp: 'off' (or false)", async () => {
  for (const off of ["off", false] as const) {
    const app = appWith({ default: (_p: PageProps) => h("h1", null, "home"), csp: off });
    const res = await app(new Request("http://localhost/"));
    await res.text();
    assertEquals(
      res.headers.get("content-security-policy"),
      null,
      `route csp:${JSON.stringify(off)} disables the CSP`,
    );
  }
});

Deno.test("global csp object applies its opt-ins to every route", async () => {
  const app = appWith(
    { default: (_p: PageProps) => h("h1", null, "home") },
    { csp: { connectSrc: ["https://api.example.com"] } },
  );
  const res = await app(new Request("http://localhost/"));
  await res.text();
  const csp = res.headers.get("content-security-policy")!;
  assertStringIncludes(csp, "connect-src 'self' https://api.example.com");
});

Deno.test("an app-set CSP overrides the denext default", async () => {
  const app = appWith(
    { default: (_p: PageProps) => h("h1", null, "home") },
    {
      getMiddleware: () =>
        createMiddlewareRunner({
          default: () => next({ headers: { "content-security-policy": "default-src 'none'" } }),
        } as never),
    },
  );
  const res = await app(new Request("http://localhost/"));
  await res.text();
  assertEquals(res.headers.get("content-security-policy"), "default-src 'none'");
});
