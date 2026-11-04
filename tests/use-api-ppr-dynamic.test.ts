// `useApi({ suspense: true })` on a Cache Components route whose API reads the visitor's request
// (`cookies()`, `headers()`, or the raw request headers): the prerender postpones that call's
// `<Suspense>` into a per-request hole — it is not a 500 `ApiClientError` — and the hole renders
// each visitor's own answer, seeded for hydration, on the first request and on every cached one.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "./helpers/released-app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { json } from "../src/server/typed-response.ts";
import { cookies, headers } from "../src/server/request-context.ts";
import { useApi } from "../src/client/use-api.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { inMemoryCacheStore, PageCache, setCacheStore } from "../src/server/cache.ts";

type Read = "cookies" | "headers" | "raw";

function Me() {
  const { data } = useApi("/api/me" as never, "GET" as never, undefined, { suspense: true });
  return h("p", null, `me=${(data as unknown as { u: string }).u}`);
}

function app(read: Read) {
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
    h(
      "main",
      null,
      h("h1", null, "static"),
      h(Suspense, { fallback: h("i", null, "loading"), children: h(Me, null) }),
    );
  const fromCookie = (header: string | null) => /u=(\w+)/.exec(header ?? "")?.[1];
  const user = (req: Request) =>
    read === "cookies"
      ? cookies().get("u")?.value
      : read === "headers"
      ? fromCookie(headers().get("cookie"))
      : fromCookie(req.headers.get("cookie"));
  const modules: Record<string, unknown> = {
    "/app/page.tsx": { default: Page, revalidate: 60 },
    "/app/api/me/route.ts": { GET: (req: Request) => json({ u: user(req) ?? "anon" }) },
  };
  return createApp({
    getManifest: () => manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    clientEntryFor: () => "/_denext/entry.js",
    flight: true,
    appDir: "/app",
    pageCache: new PageCache(),
    cacheComponents: true,
  });
}

for (const read of ["cookies", "headers", "raw"] as const) {
  Deno.test(`useApi PPR: an API reading ${read} postpones its boundary into a per-visitor hole`, async () => {
    setCacheStore(inMemoryCacheStore());
    const handler = app(read);
    for (const [u, cache] of [["alice", "MISS"], ["bob", "HIT"]]) {
      const res = await handler(
        new Request("http://localhost/", { headers: { cookie: `u=${u}` } }),
      );
      const html = await res.text();
      assertEquals(res.status, 200, html.slice(0, 400));
      assertEquals(res.headers.get("x-denext-cache"), cache, "the static shell is cached");
      assertStringIncludes(html, "<h1>static</h1>");
      assertStringIncludes(html, `me=${u}`, `${u} got their own answer`);
      const other = u === "alice" ? "bob" : "alice";
      assert(!html.includes(`me=${other}`), `${u} never sees ${other}`);
      const state = /<script id="__denext_state"[^>]*>(.*?)<\/script>/s.exec(html)?.[1] ?? "";
      assertStringIncludes(state, `"u":"${u}"`, "the hole's answer seeds hydration");
    }
  });
}
