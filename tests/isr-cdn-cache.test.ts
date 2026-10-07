// CDN cache headers on ISR pages (`cdnCacheHeaders`, opt-in): an impersonal ISR document
// tells a shared cache `public, s-maxage=<fresh seconds>, stale-while-revalidate=…`, and
// nothing private or dynamic ever does — a credentialed request, a response setting a cookie,
// a dynamic render, an app-set Cache-Control, a request a `middleware.ts` matched (unless
// `{ evenWithMiddleware: true }`), or the key left off.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { inMemoryCacheStore, PageCache, setCacheStore } from "../src/server/cache.ts";
import { cookies } from "../src/server/request-context.ts";
import { createApp } from "../src/server/app.ts";
import type { AppConfig } from "../src/server/app-config.ts";
import { cdnCacheControl } from "../src/server/page-cache-flow.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import { resolveServerOptions } from "../src/server/config.ts";
import { createMiddlewareRunner } from "../src/server/middleware.ts";
import { detectLocale, localeMiddleware } from "../src/server/i18n.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { createMiddleware as nextIntlMiddleware } from "../src/compat/next-intl/middleware.ts";

const SWR = "stale-while-revalidate=31536000";

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
    page("dynamic", "dynamic.tsx"),
    page("plain", "plain.tsx"),
  ],
  api: [],
  rootLayout: null,
  rootNotFound: null,
  rootGlobalError: null,
};

const MODULES: Record<string, unknown> = {
  "isr.tsx": { default: () => h("h1", null, "isr"), revalidate: 60 },
  "static.tsx": { default: () => h("h1", null, "static"), dynamic: "force-static" },
  "dynamic.tsx": {
    default: async () => h("h1", null, `hi ${(await cookies()).get("u")?.value ?? "anon"}`),
    revalidate: 60,
  },
  "plain.tsx": { default: () => h("h1", null, "plain") },
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
): Promise<Response> {
  const res = await handler(new Request(`http://localhost${path}`, { headers }));
  await res.text();
  return res;
}

Deno.test("cdnCacheControl: fresh seconds left, then stale-while-revalidate; force-static a year", () => {
  const now = 1_000_000;
  assertEquals(cdnCacheControl(now + 60_000, now), `public, s-maxage=60, ${SWR}`);
  assertEquals(cdnCacheControl(now + 59_001, now), `public, s-maxage=60, ${SWR}`);
  assertEquals(cdnCacheControl(now - 5_000, now), `public, s-maxage=0, ${SWR}`);
  assertEquals(cdnCacheControl(Infinity, now), "public, s-maxage=31536000");
  assertEquals(cdnCacheControl(undefined, now), "public, s-maxage=31536000");
});

Deno.test("an ISR MISS and HIT are public for a shared cache, s-maxage = the revalidate window", async () => {
  const handler = app();
  const miss = await get(handler, "/isr");
  assertEquals(miss.headers.get("x-denext-cache"), "MISS");
  assertEquals(miss.headers.get("cache-control"), `public, s-maxage=60, ${SWR}`);
  const hit = await get(handler, "/isr");
  assertEquals(hit.headers.get("x-denext-cache"), "HIT");
  const cc = hit.headers.get("cache-control") ?? "";
  assert(/^public, s-maxage=(59|60), stale-while-revalidate=31536000$/.test(cc), cc);
  const stat = await get(handler, "/static");
  assertEquals(stat.headers.get("cache-control"), "public, s-maxage=31536000");
});

Deno.test("never public: a request with a Cookie or Authorization header", async () => {
  const handler = app();
  await get(handler, "/isr"); // warm the entry
  for (
    const headers of [{ cookie: "session=abc" }, { authorization: "Bearer t" }] as Record<
      string,
      string
    >[]
  ) {
    const res = await get(handler, "/isr", headers);
    assertEquals(res.headers.get("x-denext-cache"), "HIT", "still served from ISR");
    assertEquals(res.headers.get("cache-control"), null, JSON.stringify(headers));
  }
  const fresh = app();
  const miss = await get(fresh, "/isr", { cookie: "session=abc" });
  assertEquals(miss.headers.get("x-denext-cache"), "MISS");
  assertEquals(miss.headers.get("cache-control"), null, "a credentialed MISS is not public");
});

Deno.test("never public: a response that sets a cookie (middleware Set-Cookie)", async () => {
  const handler = app({
    getMiddleware: () =>
      Promise.resolve((_req: Request) =>
        Promise.resolve({
          type: "next",
          headers: new Headers({ "set-cookie": "seen=1; Path=/" }),
        } as never)
      ),
  });
  for (const expected of ["MISS", "HIT"]) {
    const res = await get(handler, "/isr");
    assertEquals(res.headers.get("x-denext-cache"), expected);
    assertEquals(res.headers.getSetCookie().length, 1);
    assertEquals(res.headers.get("cache-control"), null, expected);
  }
});

Deno.test("never public: a dynamic (cookie-reading) render or a page without ISR", async () => {
  const handler = app();
  const dyn = await get(handler, "/dynamic");
  assertStringIncludes(dyn.headers.get("cache-control") ?? "", "private");
  assertEquals(dyn.headers.get("x-denext-cache"), null, "not stored");
  const plain = await get(handler, "/plain");
  assertEquals(plain.headers.get("cache-control"), null);
});

Deno.test("the app's own Cache-Control (middleware / headers()) wins over the default", async () => {
  const handler = app({
    getMiddleware: () =>
      Promise.resolve((_req: Request) =>
        Promise.resolve({
          type: "next",
          headers: new Headers({ "cache-control": "private, max-age=0" }),
        } as never)
      ),
  });
  const res = await get(handler, "/isr");
  assertEquals(res.headers.get("cache-control"), "private, max-age=0");
});

Deno.test("cdnCacheHeaders is off by default: no Cache-Control with ISR pages", async () => {
  const handler = app({ cdnCacheHeaders: undefined });
  const miss = await get(handler, "/isr");
  assertEquals(miss.headers.get("x-denext-cache"), "MISS");
  assertEquals(miss.headers.get("cache-control"), null);
  const hit = await get(handler, "/isr");
  assertEquals(hit.headers.get("x-denext-cache"), "HIT");
  assertEquals(hit.headers.get("cache-control"), null);
  assertEquals((await get(handler, "/static")).headers.get("cache-control"), null);
});

/** A `middleware.ts` gating `/isr` on something other than a cookie (an IP allow-list, say). */
const GATE = createMiddlewareRunner({
  middleware: () => undefined,
  config: { matcher: "/isr" },
});

Deno.test("cdnCacheHeaders: a request a middleware.ts matched is never public", async () => {
  const handler = app({ getMiddleware: () => Promise.resolve(GATE) });
  for (const expected of ["MISS", "HIT"]) {
    const res = await get(handler, "/isr");
    assertEquals(res.headers.get("x-denext-cache"), expected);
    assertEquals(res.headers.get("cache-control"), null, expected);
  }
  // A middleware whose matcher leaves the route alone does not hold the header back.
  const stat = await get(handler, "/static");
  assertEquals(stat.headers.get("cache-control"), "public, s-maxage=31536000");
  // A runner that does not say whether it matched counts as matched (fail closed).
  const opaque = app({
    getMiddleware: () => Promise.resolve(() => Promise.resolve({ type: "next" } as never)),
  });
  assertEquals((await get(opaque, "/isr")).headers.get("cache-control"), null);
});

Deno.test("cdnCacheHeaders: { evenWithMiddleware: true } keeps the header behind a middleware", async () => {
  const handler = app({
    cdnCacheHeaders: { evenWithMiddleware: true },
    getMiddleware: () => Promise.resolve(GATE),
  });
  const miss = await get(handler, "/isr");
  assertEquals(miss.headers.get("cache-control"), `public, s-maxage=60, ${SWR}`);
  // `{}` turns it on without the middleware exception.
  const plain = app({ cdnCacheHeaders: {}, getMiddleware: () => Promise.resolve(GATE) });
  assertEquals((await get(plain, "/isr")).headers.get("cache-control"), null);
  assertEquals(
    (await get(plain, "/static")).headers.get("cache-control"),
    "public, s-maxage=31536000",
  );
});

Deno.test("cdnCacheHeaders: a response after locale negotiation is never public, even with evenWithMiddleware", async () => {
  // localeMiddleware passes a default-locale visitor through on the unprefixed path and
  // redirects a French one: the page a CDN would keep depends on Accept-Language.
  const i18n = { locales: ["en", "fr"], defaultLocale: "en" };
  const handler = app({
    cdnCacheHeaders: { evenWithMiddleware: true },
    getMiddleware: () =>
      Promise.resolve(createMiddlewareRunner({ middleware: [localeMiddleware(i18n)] })),
  });
  for (const expected of ["MISS", "HIT"]) {
    const res = await get(handler, "/isr", { "accept-language": "en-US" });
    assertEquals(res.headers.get("x-denext-cache"), expected);
    assertEquals(res.headers.get("cache-control"), null, expected);
  }
});

Deno.test("locale negotiation marks the request (detectLocale, next-intl's middleware)", async () => {
  const request = new Request("http://localhost/isr", { headers: { "accept-language": "fr" } });
  const ctx = createRequestContext(request);
  runWithContext(ctx, () => detectLocale(request, { locales: ["en", "fr"], defaultLocale: "en" }));
  assertEquals(ctx.localeNegotiated, true);
  const intl = createRequestContext(request);
  const mw = nextIntlMiddleware({ locales: ["en", "fr"], defaultLocale: "en" });
  await runWithContext(intl, () => mw(request as never, {} as never));
  assertEquals(intl.localeNegotiated, true);
  // Outside a request it is a plain function.
  assertEquals(detectLocale(request, { locales: ["en", "fr"], defaultLocale: "en" }), "fr");
});

Deno.test("cdnCacheHeaders: false sends no Cache-Control with ISR pages", async () => {
  const handler = app({ cdnCacheHeaders: false });
  assertEquals((await get(handler, "/isr")).headers.get("cache-control"), null);
  const hit = await get(handler, "/isr");
  assertEquals(hit.headers.get("x-denext-cache"), "HIT");
  assertEquals(hit.headers.get("cache-control"), null);
});

Deno.test("cacheComponents: a static shell stored on MISS is public too; a cookie request is not", async () => {
  const handler = app({ cacheComponents: true });
  const miss = await get(handler, "/isr");
  assertEquals(miss.headers.get("x-denext-cache"), "MISS");
  assertEquals(miss.headers.get("cache-control"), `public, s-maxage=60, ${SWR}`);
  const cookied = await get(handler, "/isr", { cookie: "a=1" });
  assertEquals(cookied.headers.get("cache-control"), null);
});

Deno.test("validateDenextConfig: cdnCacheHeaders is a boolean or { evenWithMiddleware }", () => {
  assertThrows(
    () => validateDenextConfig({ cdnCacheHeaders: "yes" } as never),
    Error,
    "`cdnCacheHeaders` must be a boolean or { evenWithMiddleware?: boolean }",
  );
  assertThrows(
    () => validateDenextConfig({ cdnCacheHeaders: { evenWithMiddleware: "yes" } } as never),
    Error,
    "`cdnCacheHeaders.evenWithMiddleware` must be a boolean",
  );
  validateDenextConfig({ cdnCacheHeaders: false });
  validateDenextConfig({ cdnCacheHeaders: { evenWithMiddleware: true } });
});

Deno.test("resolveServerOptions carries cdnCacheHeaders from the config to createApp", () => {
  assertEquals(resolveServerOptions({ cdnCacheHeaders: false }).cdnCacheHeaders, false);
  assertEquals(
    resolveServerOptions({ cdnCacheHeaders: { evenWithMiddleware: true } }).cdnCacheHeaders,
    {
      evenWithMiddleware: true,
    },
  );
});
