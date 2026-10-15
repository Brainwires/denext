// Next.js security advisories, replayed against denext.
//
// One test per advisory (or per root cause shared by a Next.js advisory and its upstream
// React / sharp advisory), named by its GHSA / CVE id. Each test performs the advisory's
// attack against denext's equivalent surface and asserts denext refuses it or is unaffected,
// so a later change cannot reintroduce the class. `security/nextjs-advisories.json` is the
// catalog: every entry names its test, and the last test in this file fails CI when an entry
// has no matching test (or a test here has no catalog entry).
//
// Older advisories live in tests/nextjs-cve-parity.test.ts; the catalog may point there.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import type { ApiRoute, PageRoute, RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import { __useCache, inMemoryCacheStore, PageCache, setCacheStore } from "../src/server/cache.ts";
import {
  createRequestContext,
  draftMode,
  headers,
  runWithContext,
} from "../src/server/request-context.ts";
import { ImageResponse } from "../src/server/image-response.ts";
import { hardenOgBundle } from "../scripts/og-harden-svg.ts";
import { fetchRemoteImage, optimizeImage } from "../src/server/image-optimizer.ts";
import { makePinnedFetch, type Resolver, type Transport } from "../src/server/safe-fetch.ts";
import { serveMetadataFile } from "../src/server/metadata-files.ts";
import { decodeWire, WireCodecError } from "../src/runtime/wire-codec.ts";
import { actionEndpoint, serverAction } from "../src/runtime/server-action.ts";
import { handleAction } from "../src/server/action-handler.ts";
import { devOriginAllowed } from "../src/build/dev-server.ts";
import { createPagesHandler } from "../packages/pages-router/src/handler.ts";
import type { PagesScan } from "../packages/pages-router/src/scan.ts";
import type { PageCache as PageCacheT } from "../src/server/mod.ts";

// ---- shared harness ---------------------------------------------------------

function pageRoute(path: string, filePath: string, layoutChain: string[] = []): PageRoute {
  return {
    kind: "page",
    layoutChain,
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
    templateChain: [],
    pattern: parsePattern(path.replace(/^\//, "")),
    routePath: path,
    filePath,
  };
}

function manifest(pages: PageRoute[], extra: Partial<RouteManifest> = {}): RouteManifest {
  return { pages, api: [], rootLayout: null, rootNotFound: null, rootGlobalError: null, ...extra };
}

function appOf(m: RouteManifest, modules: Record<string, unknown>) {
  setCacheStore(inMemoryCacheStore());
  return createApp({
    getManifest: () => m,
    load: (fp) => Promise.resolve(modules[fp]),
    pageCache: new PageCache(),
  });
}

async function get(
  handler: (r: Request) => Promise<Response>,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: string; cache: string | null; res: Response }> {
  const res = await handler(new Request(`http://localhost${path}`, init));
  return {
    status: res.status,
    body: await res.text(),
    cache: res.headers.get("x-denext-cache"),
    res,
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The data URI satori embeds for an inline `<svg>`, decoded back to markup. */
function inlineSvgMarkup(svgDocument: string): string {
  const m = svgDocument.match(/data:image\/svg\+xml;utf8,([^"]+)/);
  assert(m, "the inline <svg> is embedded as a data URI");
  return decodeURIComponent(m[1]);
}

let ogAvailable = false;
try {
  await import("@denext/og");
  ogAvailable = true;
} catch { /* @denext/og unresolvable — the og test self-skips */ }

// ===========================================================================
// GHSA-vcvr-r3jv-pc5j / CVE-2026-94545 — RCE in next/og ImageResponse (Critical, 2026-09-22)
// https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j
// Attack: a route puts a request value inside an inline `<svg>` (`<title>{value}</title>`,
// an attribute, a style) passed to ImageResponse; satori concatenated it unescaped into the
// SVG it hands resvg, so the value injects arbitrary SVG. Next fixed its vendored @vercel/og.
// denext: AFFECTED — @denext/og vendors the same satori serializer. Fixed by
// scripts/og-harden-svg.ts (XML-name checks, escaped attributes and text) on the bundle.
// ===========================================================================

Deno.test({
  name: "GHSA-vcvr-r3jv-pc5j / CVE-2026-94545: request values in an og <svg> cannot inject markup",
  ignore: !ogAvailable,
  fn: async () => {
    const value = `</title><image href="file:///etc/passwd"/><circle r="999"/><title>`;
    const attr = `x" onload="alert(1)`;
    const res = ImageResponse(
      h(
        "div",
        { style: { display: "flex", width: "100%", height: "100%" } },
        h(
          "svg",
          { width: 100, height: 100, viewBox: "0 0 100 100" },
          h("title", null, value),
          h("rect", { width: 10, height: 10, fill: attr, style: { opacity: `1"/><g x="` } }),
        ),
      ),
      { width: 200, height: 200, format: "svg" },
    );
    const markup = inlineSvgMarkup(await res.text());
    assert(!markup.includes("<image"), "no injected <image> element");
    assert(!markup.includes("<circle"), "no injected <circle> element");
    assert(!markup.includes(`onload="`), "no injected attribute");
    assert(!markup.includes(`<g x=`), "a style value cannot close the attribute");
    assertStringIncludes(markup, "&lt;/title&gt;", "the text is escaped, not dropped");

    // The same tree still rasterizes (the hardening keeps valid SVG valid).
    const png = ImageResponse(
      h(
        "div",
        { style: { display: "flex", width: "100%", height: "100%" } },
        h("svg", { width: 50, height: 50, viewBox: "0 0 10 10" }, h("title", null, value)),
      ),
      { width: 64, height: 64 },
    );
    const bytes = new Uint8Array(await png.arrayBuffer());
    assertEquals([...bytes.subarray(0, 4)], [137, 80, 78, 71]);

    // The committed bundle is the hardened one: re-applying the script changes nothing, so a
    // regenerated bundle that skipped the script fails here.
    const bundle = await Deno.readTextFile(
      new URL("../packages/og/lib/og.bundle.js", import.meta.url),
    );
    assertEquals(hardenOgBundle(bundle), bundle, "og.bundle.js must be hardened");
  },
});

// ===========================================================================
// GHSA-2464-fhr4-w9xw / CVE-2026-96889 (Critical, 2026-10-14), with the upstream sharp
// advisory GHSA-wq5f-xc86-pv6w (librsvg, 2026-10-06) — RCE in the Image Optimization API
// when SVG files are used.
// https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw
// Attack: request `/_next/image?url=<an SVG>` so sharp hands attacker SVG to librsvg
// (memory corruption on glibc Linux).
// denext: NOT AFFECTED — no sharp / librsvg; decoding is wasm (@denext/photon) and an SVG
// source is sniffed from its bytes and refused before any decoder runs.
// ===========================================================================

Deno.test("GHSA-2464-fhr4-w9xw / CVE-2026-96889 / GHSA-wq5f-xc86-pv6w: an SVG source never reaches an image decoder", async () => {
  const root = await Deno.makeTempDir();
  try {
    const pub = join(root, "public");
    await Deno.mkdir(pub);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg"><filter id="f"><feImage href="x"/></filter></svg>`;
    // An honest .svg, one disguised as a .png, and one behind a BOM + XML prolog.
    await Deno.writeTextFile(join(pub, "a.svg"), svg);
    await Deno.writeTextFile(join(pub, "b.png"), svg);
    await Deno.writeTextFile(join(pub, "c.png"), `﻿<?xml version="1.0"?>\n${svg}`);
    for (const name of ["a.svg", "b.png", "c.png"]) {
      const res = await optimizeImage(
        new Request(`http://localhost/_denext/image?url=%2F${name}&w=64&q=75`),
        { publicDir: pub },
      );
      const body = await res.text();
      assertEquals(res.status, 400, `${name}: an SVG source is refused`);
      assert(!(res.headers.get("content-type") ?? "").includes("svg"), `${name}: never svg out`);
      assert(!body.includes("<svg"), `${name}: the source is never echoed`);
    }
    // The optimizer's module graph carries no native image library at all.
    const src = await Deno.readTextFile(
      new URL("../src/server/image-optimizer.ts", import.meta.url),
    );
    assert(!/from\s+["'](npm:)?sharp/.test(src) && !src.includes('import("sharp'), "no sharp");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ===========================================================================
// GHSA-cjq9-62q9-8jv4 / CVE-2026-94483 — SSRF in Image Optimization (High, 2026-09-30)
// https://github.com/vercel/next.js/security/advisories/GHSA-cjq9-62q9-8jv4
// Attack: an allow-listed `images.remotePatterns` host whose DNS the attacker controls
// resolves (or re-resolves at connect time) to a private address; the optimizer's fetch
// then reaches it. Next's fix (e002ad68) pins DNS resolution for the fetch.
// denext: NOT AFFECTED — the remote fetch resolves once, refuses any private answer, and
// connects to that exact validated IP (Host + SNI keep the name).
// ===========================================================================

Deno.test("GHSA-cjq9-62q9-8jv4 / CVE-2026-94483: an allow-listed host cannot steer the image fetch to a private IP", async () => {
  const opts = { remotePatterns: [{ protocol: "https" as const, hostname: "cdn.example.com" }] };
  const png = "HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: 2\r\n\r\nhi";

  // 1. The allow-listed name resolves straight to an internal address: never connected.
  for (const internal of ["169.254.169.254", "127.0.0.1", "10.0.0.7", "::1", "::ffff:10.0.0.7"]) {
    const dialed: string[] = [];
    const transport: Transport = (o) => {
      dialed.push(o.ip);
      return Promise.resolve(new TextEncoder().encode(png));
    };
    const pinned = makePinnedFetch({ resolver: () => Promise.resolve([internal]), transport });
    const got = await fetchRemoteImage(new URL("https://cdn.example.com/a.png"), opts, pinned);
    assertEquals(got, null, `${internal} is refused`);
    assertEquals(dialed, [], `${internal}: no connection is opened`);
  }

  // 2. Rebinding: the first answer is public, any later one private. The fetch resolves
  //    ONCE and dials the validated address, so the second answer is never consulted.
  let lookups = 0;
  const resolver: Resolver = () =>
    Promise.resolve(lookups++ === 0 ? ["93.184.216.34"] : ["169.254.169.254"]);
  const dialed: Array<{ ip: string; hostname: string }> = [];
  const transport: Transport = (o) => {
    dialed.push({ ip: o.ip, hostname: o.hostname });
    return Promise.resolve(new TextEncoder().encode(png));
  };
  const got = await fetchRemoteImage(
    new URL("https://cdn.example.com/a.png"),
    opts,
    makePinnedFetch({ resolver, transport }),
  );
  assert(got !== null, "the public answer is fetched");
  assertEquals(lookups, 1, "one resolution per hop");
  assertEquals(dialed, [{ ip: "93.184.216.34", hostname: "cdn.example.com" }]);
});

// ===========================================================================
// GHSA-mcj8-r9mp-w47p / CVE-2026-94484 — cache poisoning in SSG/ISR rendering with a
// root-level catch-all (Moderate, 2026-09-30)
// https://github.com/vercel/next.js/security/advisories/GHSA-mcj8-r9mp-w47p
// Attack: with `app/[...slug]` plus SSG/ISR routes, one request for an encoded or `/index`
// form of another route's path (`/blog%2Fpost`, `/index`) is rendered by the catch-all and
// stored under the cache key the other route owns, so every visitor gets the catch-all's
// page (or a persistent 500). Next's fix (719e4c67) scopes response-cache keys to the
// source route.
// denext: NOT AFFECTED — the page-cache key is the request's own raw pathname (never a
// decoded / `/index`-normalized form) and the route a pathname matches is a function of
// that same pathname, so no request can write an entry another route reads.
// ===========================================================================

Deno.test("GHSA-mcj8-r9mp-w47p / CVE-2026-94484: encoded and /index paths cannot poison another route's ISR entry", async () => {
  const m = manifest([
    pageRoute("/", "home.tsx"),
    pageRoute("/blog/[slug]", "blog.tsx"),
    pageRoute("/[...slug]", "catchall.tsx"),
  ]);
  const handler = appOf(m, {
    "home.tsx": { default: () => h("p", null, "HOME"), revalidate: 60 },
    "blog.tsx": {
      default: async ({ params }: { params: Promise<{ slug: string }> }) =>
        h("p", null, `BLOG ${(await params).slug}`),
      revalidate: 60,
    },
    "catchall.tsx": {
      default: async ({ params }: { params: Promise<{ slug: string[] }> }) =>
        h("p", null, `CATCHALL ${(await params).slug.join("|")}`),
      revalidate: 60,
    },
  });

  // The attacker goes first, against a cold cache.
  const attacks = [
    "/blog%2Fpost",
    "/blog%2fpost",
    "/%62log/post",
    "/blog/post%2F",
    "/index",
    "/index.html",
    "/blog/post/index",
    "/BLOG/post",
  ];
  for (const path of attacks) {
    const r = await get(handler, path);
    assert(r.status < 500, `${path} must not 500 (status ${r.status})`);
  }

  // Every legitimate visitor still gets their own route's page.
  for (const [path, want] of [["/", "HOME"], ["/blog/post", "BLOG post"]] as const) {
    const first = await get(handler, path);
    assertEquals(first.status, 200);
    assertStringIncludes(first.body, want, `${path} renders its own route`);
    assert(!first.body.includes("CATCHALL"), `${path} is not the catch-all's page`);
    const again = await get(handler, path);
    assertEquals(again.cache, "HIT");
    assertStringIncludes(again.body, want, `${path}'s cached entry is its own`);
  }
});

// ===========================================================================
// GHSA-4jqv-mc3x-m676 / CVE-2026-94543 — cache poisoning of SSG/ISR pages in self-hosted
// Pages Router apps (Moderate, 2026-09-30)
// https://github.com/vercel/next.js/security/advisories/GHSA-4jqv-mc3x-m676
// Attack: a crafted path makes a Pages Router SSG/ISR page's cache entry be replaced by
// content from a different route, served to every visitor until revalidation.
// denext (@denext/pages-router): NOT AFFECTED — the ISR entry is keyed `pr:<pathname>` on
// the request's own pathname, the prerendered file is looked up by that same pathname,
// and only that request's route ever regenerates it.
// ===========================================================================

Deno.test("GHSA-4jqv-mc3x-m676 / CVE-2026-94543: a crafted path never rewrites another Pages Router ISR entry", async () => {
  const staticDir = await Deno.makeTempDir({ prefix: "denext_ghsa_4jqv_" });
  try {
    const writePrerendered = async (rel: string, html: string, page: string) => {
      const dir = join(staticDir, rel);
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(join(dir, "index.html"), html);
      await Deno.writeTextFile(
        join(dir, "props.json"),
        JSON.stringify({ page, pageProps: {}, revalidate: 60 }),
      );
    };
    await writePrerendered("", "<!DOCTYPE html><body>HOME</body>", "/");
    await writePrerendered("blog/post", "<!DOCTYPE html><body>BLOG post</body>", "/blog/[slug]");

    const store = new Map<string, { body: string; staleAt?: number; status: number }>();
    // The blog entry is stale, so any request that reaches it would regenerate it.
    store.set("pr:/blog/post", { body: "BLOG post", staleAt: Date.now() - 1000, status: 200 });
    store.set("pr:/", { body: "HOME", staleAt: Date.now() + 60_000, status: 200 });
    const written: string[] = [];
    const cache = {
      // deno-lint-ignore no-explicit-any
      get: (k: string) => Promise.resolve(store.get(k) as any),
      // deno-lint-ignore no-explicit-any
      set: (k: string, v: any) => {
        written.push(k);
        store.set(k, v);
        return Promise.resolve();
      },
      revalidatePath: () => Promise.resolve(),
      revalidateTag: () => Promise.resolve(),
    } as unknown as PageCacheT;
    const entry = (routePath: string, pattern: string, filePath: string) => ({
      routePath,
      filePath,
      isApi: false,
      pattern: parsePattern(pattern),
    });
    const scan: PagesScan = {
      app: null,
      document: null,
      error: null,
      notFound: null,
      serverError: null,
      pages: [
        entry("/", "", "index.tsx"),
        entry("/blog/[slug]", "blog/[slug]", "blog.tsx"),
        entry("/[...slug]", "[...slug]", "catchall.tsx"),
      ],
      api: [],
    };
    const modules: Record<string, unknown> = {
      "index.tsx": { default: () => h("p", null, "HOME") },
      "blog.tsx": { default: () => h("p", null, "BLOG post") },
      "catchall.tsx": { default: () => h("p", null, "CATCHALL") },
    };
    const handle = createPagesHandler({
      getScan: () => scan,
      load: (fp) => Promise.resolve(modules[fp]),
      staticDir,
      pageCache: cache,
    });

    for (
      const path of ["/blog%2Fpost", "/%62log/post", "/index", "/blog/post/index", "/BLOG/POST"]
    ) {
      const res = await handle(new Request(`http://localhost${path}`));
      await res?.body?.cancel();
      await delay(20); // let any background regeneration settle
      const own = `pr:${new URL(`http://localhost${path}`).pathname}`;
      for (const k of written) assertEquals(k, own, `${path} wrote only its own entry`);
      written.length = 0;
      assertEquals(store.get("pr:/blog/post")!.body, "BLOG post", `${path} left the blog entry`);
      assertEquals(store.get("pr:/")!.body, "HOME", `${path} left the home entry`);
    }
  } finally {
    await Deno.remove(staticDir, { recursive: true });
  }
});

// ===========================================================================
// GHSA-f87g-xv8r-7p7x / CVE-2026-94485 — information disclosure in App Router metadata
// image routes via a dynamicParams bypass (Moderate, 2026-09-30)
// https://github.com/vercel/next.js/security/advisories/GHSA-f87g-xv8r-7p7x
// Attack: `app/blog/[slug]/opengraph-image.tsx` beside a page with `dynamicParams = false`
// and `generateStaticParams()` excluding `secret`: GET `/blog/secret/opengraph-image`
// renders the image for the excluded param anyway.
// denext: AFFECTED (nested image routes ignored the segment config) — fixed: a nested
// metadata image now honours `dynamicParams = false` from its layouts, the page beside it
// and its own module, and 404s an unenumerated param set.
// ===========================================================================

Deno.test("GHSA-f87g-xv8r-7p7x / CVE-2026-94485: a metadata image honours dynamicParams = false", async () => {
  const og = (label: string) => ({
    default: ({ params }: { params: Record<string, string> }) =>
      new Response(`${label}:${params.slug}`, { headers: { "content-type": "image/png" } }),
  });
  const cases: Array<{ name: string; m: RouteManifest; modules: Record<string, unknown> }> = [
    {
      name: "page-level dynamicParams",
      m: manifest([pageRoute("/blog/[slug]", "app/blog/[slug]/page.tsx")], {
        imageRoutes: new Map([[
          "/blog/[slug]/opengraph-image",
          "app/blog/[slug]/opengraph-image.tsx",
        ]]),
      }),
      modules: {
        "app/blog/[slug]/page.tsx": {
          default: () => h("p", null, "post"),
          dynamicParams: false,
          generateStaticParams: () => [{ slug: "public" }],
        },
        "app/blog/[slug]/opengraph-image.tsx": og("og"),
      },
    },
    {
      name: "layout-level dynamicParams, image under a layout-only segment",
      m: manifest(
        [
          pageRoute("/docs/[slug]/intro", "app/docs/[slug]/intro/page.tsx", [
            "app/docs/[slug]/layout.tsx",
          ]),
        ],
        {
          imageRoutes: new Map([[
            "/docs/[slug]/twitter-image",
            "app/docs/[slug]/twitter-image.tsx",
          ]]),
        },
      ),
      modules: {
        "app/docs/[slug]/layout.tsx": {
          default: ({ children }: { children: unknown }) => children,
          dynamicParams: false,
          generateStaticParams: () => [{ slug: "public" }],
        },
        "app/docs/[slug]/intro/page.tsx": { default: () => h("p", null, "intro") },
        "app/docs/[slug]/twitter-image.tsx": og("tw"),
      },
    },
  ];
  for (const { name, m, modules } of cases) {
    const load = (fp: string) => Promise.resolve(modules[fp]);
    const base = name.startsWith("page") ? "/blog" : "/docs";
    const file = name.startsWith("page") ? "opengraph-image" : "twitter-image";
    const refused = await serveMetadataFile(m, `${base}/secret/${file}`, load);
    assert(refused, `${name}: the excluded param is answered`);
    assertEquals(refused.status, 404, `${name}: an excluded param 404s`);
    assert(!(await refused.text()).includes("secret"), `${name}: nothing rendered for it`);
    const allowed = await serveMetadataFile(m, `${base}/public/${file}`, load);
    assertEquals(allowed?.status, 200, `${name}: an enumerated param renders`);
    assertStringIncludes(await allowed!.text(), ":public");
  }

  // Default dynamicParams (true) is untouched: any param renders, as in Next.
  const open = manifest([pageRoute("/blog/[slug]", "app/blog/[slug]/page.tsx")], {
    imageRoutes: new Map([["/blog/[slug]/opengraph-image", "app/blog/[slug]/opengraph-image.tsx"]]),
  });
  const openModules: Record<string, unknown> = {
    "app/blog/[slug]/page.tsx": { default: () => h("p", null, "post") },
    "app/blog/[slug]/opengraph-image.tsx": og("og"),
  };
  const res = await serveMetadataFile(
    open,
    "/blog/anything/opengraph-image",
    (fp) => Promise.resolve(openModules[fp]),
  );
  assertEquals(res?.status, 200);
  await res?.body?.cancel();
});

// ===========================================================================
// GHSA-h694-7cp9-m8p3 / CVE-2026-103004 — cache leak across root param values in nested
// 'use cache' functions (Moderate, 2026-09-30)
// https://github.com/vercel/next.js/security/advisories/GHSA-h694-7cp9-m8p3
// Attack (not attacker-steerable): an outer 'use cache' calls an inner one that reads a
// root param; on an inner hit the outer key omitted that param, so one locale's entry is
// served for another.
// denext: NOT AFFECTED — there is no implicit per-request input to a cached body: root
// params are ordinary arguments (part of every enclosing key) and request APIs throw inside
// a "use cache" scope, nested or not.
// ===========================================================================

Deno.test("GHSA-h694-7cp9-m8p3 / CVE-2026-103004: nested use cache keys every input, root params included", async () => {
  setCacheStore(inMemoryCacheStore());
  const inner = __useCache("ghsa-h694-inner", (lang: string) => `inner:${lang}`);
  const outer = __useCache(
    "ghsa-h694-outer",
    async (lang: string) => `outer(${await inner(lang)})`,
  );
  await inner("fr"); // a warm inner entry is exactly the advisory's trigger
  assertEquals(await outer("en"), "outer(inner:en)");
  assertEquals(await outer("fr"), "outer(inner:fr)");
  assertEquals(await outer("en"), "outer(inner:en)", "the en entry is not fr's");

  // A nested body cannot read the request (the only implicit input there could be).
  const implicit = __useCache(
    "ghsa-h694-implicit",
    async () => (await headers()).get("x-root") ?? "",
  );
  const wrap = __useCache("ghsa-h694-wrap", async () => await implicit());
  const req = new Request("http://localhost/", { headers: { "x-root": "fr" } });
  await assertRejects(
    () => runWithContext(createRequestContext(req), () => wrap()),
    Error,
    "use cache",
  );
});

// ===========================================================================
// GHSA-3w37-wq28-93x7 / CVE-2026-94544 — a pending 'use cache' fill leaks Draft Mode
// content into regular responses and persisted pages (Moderate, 2026-09-30)
// https://github.com/vercel/next.js/security/advisories/GHSA-3w37-wq28-93x7
// Attack: a regular request overlapping an editor's Draft Mode request for the same
// 'use cache' key joins the draft request's pending fill and receives (and may prerender
// and persist) unpublished content.
// denext: NOT AFFECTED — `draftMode()` throws inside "use cache" (it reads cookies), so a
// cached body cannot depend on draft state unless it is an argument, which keys the entry;
// a draft-mode render reads a cookie, so the page is never stored for other visitors.
// ===========================================================================

Deno.test("GHSA-3w37-wq28-93x7 / CVE-2026-94544: overlapping draft and regular requests never share draft content", async () => {
  const content = __useCache("ghsa-3w37-content", async (draft: boolean) => {
    await delay(40); // keep the fill pending while the other request arrives
    return draft ? "DRAFT-SECRET" : "PUBLISHED";
  });
  const api: ApiRoute = {
    kind: "api",
    pattern: parsePattern("api/draft"),
    routePath: "/api/draft",
    filePath: "draft-api.ts",
  };
  const m = manifest([pageRoute("/post", "post.tsx")], { api: [api] });
  const handler = appOf(m, {
    "draft-api.ts": {
      GET: async () => {
        (await draftMode()).enable();
        return new Response("ok");
      },
    },
    "post.tsx": {
      default: async () => {
        const { isEnabled } = await draftMode();
        return h("p", null, await content(isEnabled));
      },
      revalidate: 60,
    },
  });
  const enable = await get(handler, "/api/draft");
  const setCookie = enable.res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  assertStringIncludes(cookie, "__denext_draft=");

  const [draft, regular] = await Promise.all([
    get(handler, "/post", { headers: { cookie } }),
    delay(5).then(() => get(handler, "/post")),
  ]);
  assertStringIncludes(draft.body, "DRAFT-SECRET");
  assert(!regular.body.includes("DRAFT-SECRET"), "the overlapping regular request is clean");
  const later = await get(handler, "/post");
  assert(!later.body.includes("DRAFT-SECRET"), "nothing draft was persisted");

  // A cached body that reads draft state directly is refused, not silently keyed wrong.
  const direct = __useCache("ghsa-3w37-direct", async () => (await draftMode()).isEnabled);
  const req = new Request("http://localhost/post", { headers: { cookie } });
  await assertRejects(
    () => runWithContext(createRequestContext(req), () => direct()),
    Error,
    "use cache",
  );
});

// ===========================================================================
// GHSA-39w2-rjm5-chcv / CVE-2026-94486 — information disclosure from the dev server's
// Model Context Protocol endpoint (Low, 2026-09-30)
// https://github.com/vercel/next.js/security/advisories/GHSA-39w2-rjm5-chcv
// Attack: a page the developer visits reads `next dev`'s MCP endpoint cross-origin (or by
// DNS rebinding) for the project path, source snippets, routes and logs.
// denext: NOT AFFECTED — `denext mcp` speaks stdio, and the dev-server endpoints it reads
// (`/_denext/dev-state`, `dev-inspect`, `dev-routes`, `dev-cache`, `dev-log`) sit behind one
// gate that refuses a cross-origin Origin / Sec-Fetch-Site and any non-loopback Host.
// ===========================================================================

Deno.test("GHSA-39w2-rjm5-chcv / CVE-2026-94486: the dev endpoints the MCP tools read refuse other sites", () => {
  for (
    const path of [
      "/_denext/dev-state",
      "/_denext/dev-inspect?url=%2F",
      "/_denext/dev-routes?path=%2F",
      "/_denext/dev-cache",
      "/_denext/dev-log",
    ]
  ) {
    const url = new URL(`http://localhost:3000${path}`);
    const req = (h: Record<string, string>) => new Request(url, { headers: h });
    // A page on another site, with or without an Origin header.
    assertEquals(devOriginAllowed(req({ origin: "https://evil.example" }), url, []), false, path);
    assertEquals(devOriginAllowed(req({ "sec-fetch-site": "cross-site" }), url, []), false, path);
    assertEquals(
      devOriginAllowed(
        req({ origin: "http://localhost:4000", "sec-fetch-site": "same-site" }),
        url,
        [],
      ),
      false,
      path,
    );
    // DNS rebinding: evil.example resolves to 127.0.0.1, so the browser calls it same-origin.
    const rebound = new URL(`http://evil.example:3000${path}`);
    assertEquals(
      devOriginAllowed(
        new Request(rebound, {
          headers: { origin: "http://evil.example:3000", "sec-fetch-site": "same-origin" },
        }),
        rebound,
        [],
      ),
      false,
      `${path} via rebinding`,
    );
    // The developer's own page still works.
    assertEquals(devOriginAllowed(req({ "sec-fetch-site": "same-origin" }), url, []), true, path);
  }
});

// ===========================================================================
// GHSA-xqc2-xf4c-x3h3 — unauthenticated RCE in React Server Components (Critical,
// 2026-10-14; react-server-dom-* 19.0.0–19.3.0)
// https://github.com/react/react/security/advisories/GHSA-xqc2-xf4c-x3h3
// Attack: a crafted Flight payload (typed arrays plus an attacker-controlled value) makes the
// deserializer hand out objects it should never construct, the same gadget family as
// CVE-2025-55182 (`__proto__` / `constructor` reached through the decoder).
// denext: AFFECTED in the gadget sense — denext has no react-server-dom, but its wire codec
// (Server Action args, typed API bodies, Live frames) looked up the `N` tag with `v in {…}`,
// so `{ "$": "N", "v": "__proto__" }` decoded to `Object.prototype` and `"constructor"` to the
// `Object` function inside the handler's arguments. Fixed: the enum is a `Map`; any name it
// does not own is a malformed tag (400). Typed arrays are not a wire type at all.
// ===========================================================================

Deno.test("GHSA-xqc2-xf4c-x3h3: a crafted wire payload never decodes to a prototype or constructor", async () => {
  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
    let threw: unknown = null;
    try {
      decodeWire({ $: "N", v: name });
    } catch (e) {
      threw = e;
    }
    assert(threw instanceof WireCodecError, `N tag "${name}" is malformed, not a lookup`);
  }
  // Typed-array-shaped and unknown tags are refused rather than constructed.
  for (const tag of ["AT", "Uint8Array", "Function", "O", "T"]) {
    let threw: unknown = null;
    try {
      decodeWire({ $: tag, v: [1, 2, 3] });
    } catch (e) {
      threw = e;
    }
    assert(threw instanceof WireCodecError, `tag "${tag}" is refused`);
  }
  // The legitimate values still decode.
  const ok = decodeWire([{ $: "N", v: "NaN" }, { $: "N", v: "-0" }]) as number[];
  assert(Number.isNaN(ok[0]) && Object.is(ok[1], -0));

  // End to end: the action handler answers 400 and the handler never sees the gadget.
  let received: unknown = "not called";
  serverAction("ghsa_xqc2", (x: unknown) => {
    received = x;
    return "ran";
  });
  const req = new Request("http://localhost" + actionEndpoint("ghsa_xqc2"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "localhost",
      origin: "http://localhost",
      "x-denext-action": "1",
    },
    body: JSON.stringify({ args: [{ $: "N", v: "__proto__" }], enc: 1 }),
  });
  const res = await runWithContext(createRequestContext(req), () => handleAction(req));
  await res.body?.cancel();
  assertEquals(res.status, 400);
  assertEquals(received, "not called");
});

// ===========================================================================
// GHSA-673q-mjm6-r5xr — unauthenticated RCE in 'use cache' functions returning typed arrays
// (Critical, 2026-10-14; Next 16.0.0–16.4.0 with Cache Components)
// https://github.com/vercel/next.js/security/advisories/GHSA-673q-mjm6-r5xr
// Attack: a 'use cache' function that returns several typed arrays has its result
// round-tripped through the vulnerable Flight serializer/deserializer (GHSA-xqc2).
// denext: NOT AFFECTED — a "use cache" result that is not plain JSON (typed arrays included)
// stays in-process and is never serialized or deserialized; the durable store only ever
// receives JSON-safe values.
// ===========================================================================

Deno.test("GHSA-673q-mjm6-r5xr: a use cache result with typed arrays never crosses a deserializer", async () => {
  const store = inMemoryCacheStore();
  const written: unknown[] = [];
  const setData = store.setData.bind(store);
  store.setData = (k, e) => {
    written.push(e.value);
    return setData(k, e);
  };
  setCacheStore(store);
  const make = __useCache("ghsa-673q-typed", (n: number) => ({
    a: new Uint8Array([n, 1, 2]),
    b: new Float64Array([n / 2]),
    c: new BigInt64Array([BigInt(n)]),
  }));
  const first = await make(7);
  const second = await make(7);
  assert(first.a instanceof Uint8Array && first.b instanceof Float64Array);
  assertEquals([...first.a], [7, 1, 2]);
  assertEquals(second, first, "the hit returns the same value");
  assertEquals(written, [], "a typed-array result is never written to the durable store");
});

// ===========================================================================
// GHSA-p3m5-59mp-jv5r (Next, High, 2026-10-14) / GHSA-h3gv-c5rc-p453 (React, High,
// 2026-10-14) — denial of service in Server Actions / Server Functions
// https://github.com/vercel/next.js/security/advisories/GHSA-p3m5-59mp-jv5r
// https://github.com/react/react/security/advisories/GHSA-h3gv-c5rc-p453
// Attack: a crafted POST to a Server Action endpoint makes reply decoding burn CPU (or
// memory) and block the process.
// denext: NOT AFFECTED — no `decodeReply`: the body is capped (1 MiB, 413) before decoding,
// the wire decode is a single linear walk with depth and node budgets, BigInt digits are
// capped (quadratic `BigInt()`), and the multipart index is range-checked.
// ===========================================================================

Deno.test("GHSA-p3m5-59mp-jv5r / GHSA-h3gv-c5rc-p453: hostile Server Action bodies are answered in bounded time", async () => {
  serverAction("ghsa_p3m5", (..._args: unknown[]) => "ok");
  const post = (body: BodyInit, contentType = "application/json") => {
    const req = new Request("http://localhost" + actionEndpoint("ghsa_p3m5"), {
      method: "POST",
      headers: {
        "content-type": contentType,
        host: "localhost",
        origin: "http://localhost",
        "x-denext-action": "1",
      },
      body,
    });
    return runWithContext(createRequestContext(req), () => handleAction(req));
  };
  const deep = 100_000;
  const multipart = new FormData();
  multipart.append("__denext_meta", JSON.stringify({ fdIndex: 2 ** 31, others: [] }));
  const payloads: Array<[string, () => Promise<Response>]> = [
    [
      "a 900k-digit BigInt tag",
      () => post(JSON.stringify({ args: [{ $: "n", v: "9".repeat(900_000) }], enc: 1 })),
    ],
    [
      "deep codec nesting",
      () => post(`{"enc":1,"args":[${'{"$":"S","v":['.repeat(deep)}${"]}".repeat(deep)}]}`),
    ],
    [
      "a wide Set",
      () => post(JSON.stringify({ args: [{ $: "S", v: new Array(200_000).fill(0) }], enc: 1 })),
    ],
    ["an over-cap body", () => post("x".repeat(2 * 1024 * 1024))],
    ["a huge multipart index", () => post(multipart, "")],
  ];
  for (const [name, send] of payloads) {
    const started = performance.now();
    const res = await send();
    await res.body?.cancel();
    const ms = performance.now() - started;
    assert(res.status < 500, `${name}: answered without a server error (${res.status})`);
    assert(ms < 5_000, `${name}: answered in ${Math.round(ms)}ms`);
  }
});

// ===========================================================================
// Catalog integrity: every advisory in security/nextjs-advisories.json names a test that
// exists (in the file it names, with the advisory id in the test name), and every advisory
// test in this file is catalogued. Adding an advisory without its test fails CI.
// ===========================================================================

interface CatalogEntry {
  id: string;
  aliases?: string[];
  status: string;
  test: string;
  file: string;
}

Deno.test("catalog: every Next.js advisory entry has a matching regression test", async () => {
  const catalog = JSON.parse(
    await Deno.readTextFile(new URL("../security/nextjs-advisories.json", import.meta.url)),
  ) as { advisories: CatalogEntry[] };
  assert(catalog.advisories.length > 0);
  const sources = new Map<string, string>();
  const ids = new Set<string>();
  for (const a of catalog.advisories) {
    assert(/^(GHSA(-[23456789cfghjmpqrvwx]{4}){3}|CVE-\d{4}-\d{4,})$/.test(a.id), `id ${a.id}`);
    assert(!ids.has(a.id), `${a.id} is listed once`);
    ids.add(a.id);
    assert(
      a.status === "not-affected" || /^fixed in [0-9a-f]{7,40}$|^fixed$/.test(a.status),
      `${a.id}: status is "not-affected" or "fixed in <commit>" (got "${a.status}")`,
    );
    assertStringIncludes(a.test, a.id, `${a.id}: the test is named by the advisory id`);
    if (!sources.has(a.file)) {
      sources.set(a.file, await Deno.readTextFile(new URL(`../${a.file}`, import.meta.url)));
    }
    assertStringIncludes(
      sources.get(a.file)!,
      JSON.stringify(a.test),
      `${a.id}: test ${JSON.stringify(a.test)} exists in ${a.file}`,
    );
  }
  // The other direction: no advisory test in this file is missing from the catalog.
  const self = await Deno.readTextFile(new URL(import.meta.url));
  const named = [...self.matchAll(/(?:Deno\.test\(|name: )"((?:GHSA|CVE)-[^"]+)"/g)].map((m) =>
    m[1]
  );
  const catalogued = new Set(catalog.advisories.map((a) => a.test));
  for (const name of named) assert(catalogued.has(name), `"${name}" has a catalog entry`);
});
