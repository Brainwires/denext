// Default hardening response headers: X-Content-Type-Options, X-Frame-Options,
// Referrer-Policy on every response; HSTS only over HTTPS. The app can override
// any of them via headers()/middleware (its value wins).

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { createMiddlewareRunner, next } from "../src/server/middleware.ts";
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

const modules: Record<string, unknown> = {
  "home.tsx": { default: (_p: PageProps) => h("h1", null, "home") },
};

function appWith(extra: Record<string, unknown> = {}) {
  return createApp({
    getManifest: manifest,
    load: (fp: string) => Promise.resolve(modules[fp]),
    ...extra,
  });
}

Deno.test("default hardening headers are present on a page response", async () => {
  const app = appWith();
  const res = await app(new Request("http://localhost/"));
  await res.text();
  assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  assertEquals(res.headers.get("x-frame-options"), "SAMEORIGIN");
  assertEquals(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
});

Deno.test("HSTS is sent over HTTPS and withheld over plain HTTP", async () => {
  const app = appWith();
  const httpRes = await app(new Request("http://localhost/"));
  await httpRes.text();
  assertEquals(httpRes.headers.get("strict-transport-security"), null);

  const httpsRes = await app(new Request("https://localhost/"));
  await httpsRes.text();
  assertEquals(httpsRes.headers.get("strict-transport-security"), "max-age=31536000");

  // A spoofable X-Forwarded-Proto is IGNORED unless the app opts into trusting
  // its proxy — otherwise any client could induce HSTS pinning.
  const untrusted = await app(
    new Request("http://localhost/", { headers: { "x-forwarded-proto": "https" } }),
  );
  await untrusted.text();
  assertEquals(untrusted.headers.get("strict-transport-security"), null);

  // Behind a TLS-terminating proxy the app declares trusted.
  const trustedApp = appWith({ trustForwardedHeaders: true });
  const proxied = await trustedApp(
    new Request("http://localhost/", { headers: { "x-forwarded-proto": "https" } }),
  );
  await proxied.text();
  assertEquals(proxied.headers.get("strict-transport-security"), "max-age=31536000");
});

Deno.test("an app-set header overrides the default", async () => {
  const app = appWith({
    getMiddleware: () =>
      createMiddlewareRunner({
        default: () => next({ headers: { "x-frame-options": "DENY" } }),
      } as never),
  });
  const res = await app(new Request("http://localhost/"));
  await res.text();
  assertEquals(res.headers.get("x-frame-options"), "DENY");
  // The other defaults are still applied.
  assertEquals(res.headers.get("x-content-type-options"), "nosniff");
});
