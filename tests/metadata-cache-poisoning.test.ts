// Web cache poisoning through request-derived origins: absolute metadata URLs (`og:image`
// from the opengraph-image convention, automatic hreflang / canonical, the sitemap index)
// must never take their origin from a request's `Host` / `X-Forwarded-Host` in output a
// cache stores and replays (ISR, `force-static`, Cache Components shells, `cdnCacheHeaders`
// responses). A first request carrying `Host: evil.example` must leave nothing of it for
// the next visitor. Per-request (dynamic) documents may still use the request's origin,
// and are then sent `no-store`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "./helpers/released-app.ts";
import type { AppConfig } from "../src/server/app-config.ts";
import { __useCache, inMemoryCacheStore, PageCache, setCacheStore } from "../src/server/cache.ts";
import { cookies, headers } from "../src/server/request-context.ts";
import { stableBaseUrl } from "../src/server/absolute-url.ts";
import { serveMetadataFile } from "../src/server/metadata-files.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";

const EVIL = "evil.example";

function page(path: string, file: string) {
  return {
    kind: "page" as const,
    layoutChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
    templateChain: [],
    pattern: parsePattern(path),
    routePath: `/${path}`,
    filePath: file,
  };
}

const MANIFEST: RouteManifest = {
  pages: [
    page("isr", "isr.tsx"),
    page("static", "static.tsx"),
    page("based", "based.tsx"),
    page("plain", "plain.tsx"),
    page("cookie-isr", "cookie-isr.tsx"),
    page("cached-meta", "cached-meta.tsx"),
    page("cached-host", "cached-host.tsx"),
  ],
  api: [],
  rootLayout: null,
  rootNotFound: null,
  rootGlobalError: null,
  openGraphImage: "opengraph-image.tsx",
};

// A `"use cache"` body is keyed only on its arguments, so it must never see the request's
// Host: reading headers() inside one throws rather than caching the value.
const cachedMeta = __useCache("poison-meta", () => ({ title: "cached title" }));
const cachedHost = __useCache("poison-host", async () => (await headers()).get("host") ?? "");

const MODULES: Record<string, unknown> = {
  "cached-meta.tsx": {
    default: () => h("h1", null, "cached-meta"),
    generateMetadata: () => cachedMeta(),
    revalidate: 60,
  },
  "cached-host.tsx": {
    default: async () => h("h1", null, await cachedHost()),
    revalidate: 60,
  },
  "isr.tsx": { default: () => h("h1", null, "isr"), revalidate: 60 },
  "static.tsx": { default: () => h("h1", null, "static"), dynamic: "force-static" },
  "based.tsx": {
    default: () => h("h1", null, "based"),
    revalidate: 60,
    metadata: { metadataBase: "https://site.example" },
  },
  "plain.tsx": { default: () => h("h1", null, "plain") },
  "cookie-isr.tsx": {
    default: async () => h("h1", null, `hi ${(await cookies()).get("u")?.value ?? "anon"}`),
    revalidate: 60,
  },
};

function app(extra: Partial<AppConfig> = {}) {
  setCacheStore(inMemoryCacheStore());
  return createApp({
    getManifest: () => MANIFEST,
    load: (fp) => Promise.resolve(MODULES[fp]),
    pageCache: new PageCache(),
    cdnCacheHeaders: true,
    ...extra,
  });
}

async function get(
  handler: (r: Request) => Promise<Response>,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ res: Response; body: string }> {
  const res = await handler(new Request(`http://localhost${path}`, { headers }));
  return { res, body: await res.text() };
}

const FORGED = { host: EVIL, "x-forwarded-host": EVIL, "x-forwarded-proto": "https" };

for (const path of ["/isr", "/static"]) {
  Deno.test(`ISR ${path}: a forged Host on the MISS never reaches the cached document`, async () => {
    for (const trustForwardedHeaders of [false, true]) {
      const handler = app({ trustForwardedHeaders });
      const first = await get(handler, path, FORGED);
      assertEquals(first.res.headers.get("x-denext-cache"), "MISS");
      assert(!first.body.includes(EVIL), "the MISS document carries no forged origin");
      // No stable base: og:image stays relative instead of demoting the page to dynamic.
      assertStringIncludes(first.body, `<meta property="og:image" content="/opengraph-image">`);
      assertStringIncludes(first.res.headers.get("cache-control") ?? "", "public");

      const next = await get(handler, path);
      assertEquals(next.res.headers.get("x-denext-cache"), "HIT");
      assert(!next.body.includes(EVIL), "the next visitor gets no forged origin");
    }
  });
}

Deno.test("ISR: metadataBase is the stable base for convention og:image (Next parity)", async () => {
  const handler = app({ trustForwardedHeaders: true });
  const first = await get(handler, "/based", FORGED);
  assertStringIncludes(
    first.body,
    `<meta property="og:image" content="https://site.example/opengraph-image">`,
  );
  const next = await get(handler, "/based");
  assertEquals(next.res.headers.get("x-denext-cache"), "HIT");
  assert(!next.body.includes(EVIL));
});

Deno.test("ISR: canonicalOrigin wins over the request and keeps the page cacheable", async () => {
  const handler = app({ canonicalOrigin: "https://canon.example", trustForwardedHeaders: true });
  const first = await get(handler, "/isr", FORGED);
  assertStringIncludes(
    first.body,
    `<meta property="og:image" content="https://canon.example/opengraph-image">`,
  );
  const next = await get(handler, "/isr");
  assertEquals(next.res.headers.get("x-denext-cache"), "HIT");
  assert(!next.body.includes(EVIL));
});

Deno.test("ISR + i18n: no request-derived hreflang / canonical in a cached document", async () => {
  const handler = app({ i18n: { locales: ["en", "fr"], defaultLocale: "en" } });
  const first = await get(handler, "/isr", { host: EVIL });
  assert(!first.body.includes(EVIL));
  assert(!first.body.includes(`hreflang=`), "hreflang needs an absolute stable origin");
  const next = await get(handler, "/isr");
  assert(!next.body.includes(EVIL));
});

Deno.test("dynamic page: a per-request og:image may use Host, and is never shared", async () => {
  const handler = app();
  const { res, body } = await get(handler, "/plain", { host: "site.example" });
  assertStringIncludes(
    body,
    `<meta property="og:image" content="http://site.example/opengraph-image">`,
  );
  assertStringIncludes(res.headers.get("cache-control") ?? "", "no-store");
  assert(!(res.headers.get("cache-control") ?? "").includes("public"));
});

Deno.test("dynamic page: X-Forwarded-Host is ignored unless trustForwardedHeaders", async () => {
  const headers = { host: "site.example", "x-forwarded-host": EVIL };
  const untrusted = await get(app(), "/plain", headers);
  assert(!untrusted.body.includes(EVIL), "a spoofed X-Forwarded-Host is ignored by default");
  const trusted = await get(app({ trustForwardedHeaders: true }), "/plain", headers);
  assertStringIncludes(trusted.body, `content="http://${EVIL}/opengraph-image"`);
  assertStringIncludes(trusted.res.headers.get("cache-control") ?? "", "no-store");
});

Deno.test("ISR page that read cookies(): request origin allowed, but never cached", async () => {
  const handler = app();
  const first = await get(handler, "/cookie-isr", { host: EVIL });
  assertStringIncludes(first.res.headers.get("cache-control") ?? "", "no-store");
  const next = await get(handler, "/cookie-isr");
  assert(next.res.headers.get("x-denext-cache") !== "HIT");
  assert(!next.body.includes(EVIL));
});

Deno.test("cacheComponents: a forged Host on the shell's MISS never reaches later visitors", async () => {
  for (const path of ["/isr", "/static", "/cookie-isr"]) {
    const handler = app({ cacheComponents: true, trustForwardedHeaders: true });
    await get(handler, path, FORGED);
    const next = await get(handler, path);
    assert(!next.body.includes(EVIL), `${path}: no forged origin after a cacheComponents MISS`);
  }
});

Deno.test("use cache: cached metadata + a cached body never carry the forged Host", async () => {
  for (const cacheComponents of [false, true]) {
    const handler = app({ cacheComponents, trustForwardedHeaders: true });
    const first = await get(handler, "/cached-meta", FORGED);
    assert(!first.body.includes(EVIL));
    assertStringIncludes(first.body, "<title>cached title</title>");
    const next = await get(handler, "/cached-meta");
    assert(!next.body.includes(EVIL));

    // headers() inside "use cache" is rejected, so the Host never enters the cache entry.
    const forged = await get(handler, "/cached-host", FORGED);
    assert(!forged.body.includes(`<h1>${EVIL}</h1>`));
    const after = await get(handler, "/cached-host");
    assert(!after.body.includes(EVIL), "no forged Host from a use-cache entry");
  }
});

Deno.test("stableBaseUrl: canonicalOrigin, then metadataBase, never the request", () => {
  assertEquals(
    stableBaseUrl("/og", "https://a.example/", "https://b.example"),
    "https://a.example/og",
  );
  assertEquals(
    stableBaseUrl("/og", undefined, new URL("https://b.example")),
    "https://b.example/og",
  );
  assertEquals(stableBaseUrl("/og", undefined, undefined), null);
  assertEquals(stableBaseUrl("/og", undefined, "not a url"), null);
});

Deno.test("sitemap index: a Host-derived origin is sent no-store; canonicalOrigin is not", async () => {
  const manifest = { ...MANIFEST, sitemap: "sitemap.ts" } as RouteManifest;
  const load = () =>
    Promise.resolve({
      generateSitemaps: () => [{ id: 0 }],
      default: () => [{ url: "https://site.example/a" }],
    });
  const fromHost = await serveMetadataFile(manifest, "/sitemap.xml", load, `http://${EVIL}`, true);
  assertEquals(fromHost!.headers.get("cache-control"), "private, no-store");
  const canonical = await serveMetadataFile(manifest, "/sitemap.xml", load, "https://x.com", false);
  assertEquals(canonical!.headers.get("cache-control"), null);
  assertStringIncludes(await canonical!.text(), "<loc>https://x.com/sitemap/0.xml</loc>");

  // Through createApp: no canonicalOrigin → no-store; with one → the configured origin.
  const handler = (extra: Partial<AppConfig>) =>
    createApp({
      getManifest: () => manifest,
      load: (fp) => fp === "sitemap.ts" ? load() : Promise.resolve(MODULES[fp]),
      ...extra,
    });
  const poisoned = await get(handler({}), "/sitemap.xml", { host: EVIL });
  assertEquals(poisoned.res.headers.get("cache-control"), "private, no-store");
  const pinned = await get(handler({ canonicalOrigin: "https://x.com" }), "/sitemap.xml", {
    host: EVIL,
  });
  assert(!pinned.body.includes(EVIL));
  assertStringIncludes(pinned.body, "<loc>https://x.com/sitemap/0.xml</loc>");
});
