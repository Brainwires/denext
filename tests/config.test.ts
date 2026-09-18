import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  asyncContextEnabled,
  compilePattern,
  type DenextConfig,
  featureFlags,
  fillDestination,
  isOrigin,
  matchPattern,
  reactCompilerEnabled,
  resolveCacheComponents,
  resolveLive,
  resolveServerOptions,
  resolveStreaming,
  safeRedirectLocation,
} from "../src/server/config.ts";
import { createApp } from "../src/server/app.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { Link } from "../src/client/navigation.ts";

Deno.test("resolveStreaming/resolveLive: top-level only — the legacy experimental.* alias is ignored", () => {
  // The top-level fields are the only home (the alias was removed in 2.0).
  assertEquals(resolveStreaming({ streaming: false }), false);
  const live = { allowAnonymous: true };
  assertEquals(resolveLive({ live }), live);

  // A pre-1.4 config still setting `experimental.streaming`/`experimental.live` no
  // longer resolves through the alias: the value is ignored (the config validator
  // warns about the moved key in dev) and the caller's default applies.
  const legacy = {
    experimental: { streaming: false, live },
  } as unknown as DenextConfig;
  assertEquals(resolveStreaming(legacy), undefined);
  assertEquals(resolveLive(legacy), undefined);

  // A stale legacy value next to the top-level field never leaks through either.
  const both = {
    streaming: true,
    experimental: { streaming: false },
  } as unknown as DenextConfig;
  assertEquals(resolveStreaming(both), true);

  // Neither set → undefined (the caller's default-on applies).
  assertEquals(resolveStreaming({}), undefined);
  assertEquals(resolveLive(null), undefined);
});

Deno.test("resolveCacheComponents: top-level wins, legacy experimental alias still honored", () => {
  // The graduated top-level field is the canonical home.
  assertEquals(resolveCacheComponents({ cacheComponents: true }), true);
  assertEquals(resolveCacheComponents({ cacheComponents: false }), false);

  // Soft migration: a config written against a 2.0 pre-release still works through
  // the legacy `experimental.cacheComponents` alias.
  const legacy = { experimental: { cacheComponents: true } } as unknown as DenextConfig;
  assertEquals(resolveCacheComponents(legacy), true);

  // The top-level field takes precedence when both are set — even an explicit `false`.
  const both = {
    cacheComponents: false,
    experimental: { cacheComponents: true },
  } as unknown as DenextConfig;
  assertEquals(resolveCacheComponents(both), false);

  // Neither set → undefined (off).
  assertEquals(resolveCacheComponents({}), undefined);
  assertEquals(resolveCacheComponents({ experimental: {} }), undefined);
  assertEquals(resolveCacheComponents(null), undefined);
  assertEquals(resolveCacheComponents(undefined), undefined);
});

Deno.test("reactCompiler/asyncContext/features: top-level wins, the experimental.* alias still reads", () => {
  // The graduated top-level fields are the canonical home.
  assertEquals(reactCompilerEnabled({ reactCompiler: true }), true);
  assertEquals(asyncContextEnabled({ asyncContext: true }), true);
  assertEquals(featureFlags({ features: { A: true, B: false } }), { A: true, B: false });

  // Both spellings produce the same effective value: a 2.x config still works unchanged.
  assertEquals(reactCompilerEnabled({ experimental: { reactCompiler: true } }), true);
  assertEquals(reactCompilerEnabled({ experimental: { compiler: true } }), true);
  assertEquals(asyncContextEnabled({ experimental: { asyncContext: true } }), true);
  assertEquals(featureFlags({ experimental: { features: { A: true } } }), { A: true });

  // The top-level field takes precedence when both are set — even an explicit `false`, and
  // the maps are not merged.
  assertEquals(
    reactCompilerEnabled({ reactCompiler: false, experimental: { reactCompiler: true } }),
    false,
  );
  assertEquals(
    reactCompilerEnabled({ reactCompiler: true, experimental: { compiler: false } }),
    true,
  );
  assertEquals(
    asyncContextEnabled({ asyncContext: false, experimental: { asyncContext: true } }),
    false,
  );
  assertEquals(
    featureFlags({ features: { A: false }, experimental: { features: { A: true, B: true } } }),
    { A: false },
  );

  // Neither set → off / an empty map.
  for (const config of [{}, { experimental: {} }, null, undefined]) {
    assertEquals(reactCompilerEnabled(config), false);
    assertEquals(asyncContextEnabled(config), false);
    assertEquals(featureFlags(config), {});
  }
});

Deno.test("compilePattern + matchPattern capture named params", () => {
  const p = compilePattern("/old/:slug");
  assertEquals(matchPattern(p, "/old/hello"), { slug: "hello" });
  assertEquals(matchPattern(p, "/other"), null);
  const wild = compilePattern("/blog/:path*");
  assertEquals(matchPattern(wild, "/blog/a/b/c"), { path: "a/b/c" });
});

Deno.test("fillDestination substitutes params", () => {
  assertEquals(fillDestination("/new/:slug", { slug: "x" }), "/new/x");
  assertEquals(fillDestination("/n/:path*", { path: "a/b" }), "/n/a/b");
});

// A manifest with two pages: /a and /target.
function manifest(): RouteManifest {
  const page = (routePath: string, pattern: string) => ({
    kind: "page" as const,
    pattern: parsePattern(pattern),
    routePath,
    filePath: `${routePath}.tsx`,
    layoutChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
    templateChain: [],
  });
  return {
    pages: [page("/a", "a"), page("/target", "target")],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
}

const load = (filePath: string) =>
  Promise.resolve({
    default: () => h("h1", {}, filePath === "/target.tsx" ? "TARGET_PAGE" : "A_PAGE"),
  });

Deno.test("safeRedirectLocation neutralizes protocol-relative / backslash paths", () => {
  // Same-origin paths pass through unchanged.
  assertEquals(safeRedirectLocation("/about"), "/about");
  assertEquals(safeRedirectLocation("/new?x=1"), "/new?x=1");
  // Protocol-relative and backslash prefixes collapse to a single-slash path.
  assertEquals(safeRedirectLocation("//evil.com"), "/evil.com");
  assertEquals(safeRedirectLocation("//evil.com/"), "/evil.com/");
  assertEquals(safeRedirectLocation("///evil.com"), "/evil.com");
  assertEquals(safeRedirectLocation("/\\evil.com"), "/evil.com");
  assertEquals(safeRedirectLocation("\\\\evil.com"), "/evil.com");
  // Explicit http(s) absolute URLs (deliberate external redirects) are preserved.
  assertEquals(safeRedirectLocation("https://ok.example/x"), "https://ok.example/x");
  assertEquals(safeRedirectLocation("http://ok.example/x"), "http://ok.example/x");
  // A `javascript:`-style scheme is treated as a path, not passed through.
  assertEquals(safeRedirectLocation("javascript:alert(1)"), "/javascript:alert(1)");
  // Control characters are stripped BEFORE the collapse: the URL parser drops tab/newline,
  // so `/\t/evil.com` would otherwise reach the browser as protocol-relative `//evil.com`.
  assertEquals(safeRedirectLocation("/\t/evil.com"), "/evil.com");
  assertEquals(safeRedirectLocation("/\t\\evil.com"), "/evil.com");
  assertEquals(safeRedirectLocation("/\r\n/x"), "/x");
  assertEquals(safeRedirectLocation(" //evil.com"), "/evil.com");
  // A stripped value is also a legal header value (no CR/LF → `new Response` won't throw).
  new Response(null, { status: 307, headers: { location: safeRedirectLocation("/\r/x") } });
});

Deno.test("trailingSlash redirect cannot become a protocol-relative open redirect", async () => {
  // Both branches: add-slash (trailingSlash:true, no trailing slash) and
  // strip-slash (trailingSlash:false, has trailing slash) must stay same-origin.
  // Use a non-file last segment so the trailingSlash normalization actually runs
  // (paths ending in `.ext` are treated as static files and skipped).
  const cases: Array<{ ts: boolean; path: string }> = [
    { ts: true, path: "//evil.com/x" }, // → add-slash branch
    { ts: false, path: "//evil.com/x/" }, // → strip-slash branch
  ];
  for (const { ts, path } of cases) {
    const app = createApp({ getManifest: manifest, load, trailingSlash: ts });
    const res = await app(new Request("http://localhost" + path));
    const loc = res.headers.get("location");
    await res.body?.cancel();
    assertEquals(res.status, 308, `${path} should 308`);
    assert(loc && !loc.startsWith("//"), `open redirect: ${loc}`);
    assert(!/^https?:\/\//i.test(loc!), `absolute-origin redirect: ${loc}`);
    assertStringIncludes(loc!, "/evil.com"); // stays a same-origin path
  }
});

Deno.test("config redirect cannot be turned into an open redirect via the captured path", async () => {
  const app = createApp({
    getManifest: manifest,
    load,
    // A natural path-preserving redirect rule.
    redirects: [{ source: "/old/:path*", destination: "/:path*", permanent: true }],
  });
  const res = await app(new Request("http://localhost/old//evil.com"));
  assertEquals(res.status, 308);
  const loc = res.headers.get("location");
  await res.body?.cancel();
  assert(!loc!.startsWith("//"), `open redirect: ${loc}`);
  // The `//` is collapsed by path canonicalization (a 308 to the canonical single-slash
  // form) before the config redirect runs, so a protocol-relative `//evil.com` can't be
  // smuggled through the captured path. `safeRedirectLocation` on the destination stays
  // a second-line defense for a `//` produced purely by param substitution.
  assertEquals(loc, "/old/evil.com");
});

Deno.test("config redirect issues a 308/307 with param substitution", async () => {
  const app = createApp({
    getManifest: manifest,
    load,
    redirects: [{ source: "/old/:slug", destination: "/new/:slug", permanent: true }],
  });
  const res = await app(new Request("http://localhost/old/hello"));
  assertEquals(res.status, 308);
  assertEquals(res.headers.get("location"), "/new/hello");
  await res.body?.cancel();
});

Deno.test("config rewrite serves the destination route without a client redirect", async () => {
  const app = createApp({
    getManifest: manifest,
    load,
    rewrites: [{ source: "/a", destination: "/target" }],
  });
  const res = await app(new Request("http://localhost/a"));
  assertEquals(res.status, 200);
  const html = await res.text();
  assert(html.includes("TARGET_PAGE"), "rewrite should render the destination page");
});

Deno.test("config headers are attached to matching responses", async () => {
  const app = createApp({
    getManifest: manifest,
    load,
    headerRules: [{
      source: "/a",
      headers: [{ key: "x-custom", value: "denext" }],
    }],
  });
  const res = await app(new Request("http://localhost/a"));
  assertEquals(res.headers.get("x-custom"), "denext");
  await res.body?.cancel();
});

Deno.test("trailingSlash normalizes with a 308 redirect", async () => {
  const add = createApp({ getManifest: manifest, load, trailingSlash: true });
  const r1 = await add(new Request("http://localhost/a"));
  assertEquals(r1.status, 308);
  assertEquals(r1.headers.get("location"), "/a/");
  await r1.body?.cancel();

  const strip = createApp({ getManifest: manifest, load, trailingSlash: false });
  const r2 = await strip(new Request("http://localhost/a/"));
  assertEquals(r2.status, 308);
  assertEquals(r2.headers.get("location"), "/a");
  await r2.body?.cancel();
});

Deno.test("basePath strips the prefix before routing", async () => {
  const app = createApp({ getManifest: manifest, load, basePath: "/docs" });
  const res = await app(new Request("http://localhost/docs/a"));
  assertEquals(res.status, 200);
  assert((await res.text()).includes("A_PAGE"));
});

Deno.test("basePath prefixes server-rendered <Link> hrefs and embeds itself", async () => {
  const linkLoad = () =>
    Promise.resolve({
      default: () => h(Link, { href: "/target" }, "go"),
    });
  const app = createApp({
    getManifest: manifest,
    load: linkLoad,
    basePath: "/docs",
    clientEntryFor: () => "/docs/_denext/route.js", // enables hydration payload
  });
  const html = await (await app(new Request("http://localhost/docs/a"))).text();
  assertStringIncludes(html, `href="/docs/target"`); // Link prefixed with basePath
  assertStringIncludes(html, `"basePath":"/docs"`); // embedded for the client
});

// ---- resolveServerOptions: config > env > default -----------------------------

/** Run `fn` with these env vars set (and restored after), for the env-fallback tests. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, Deno.env.get(k));
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const SERVER_ENV = {
  DENEXT_CANONICAL_ORIGIN: undefined,
  DENEXT_TRUST_PROXY: undefined,
  DENEXT_REQUEST_TIMEOUT_MS: undefined,
  DENEXT_MAX_CONCURRENCY: undefined,
};

Deno.test("resolveServerOptions: unset config + unset env leaves every knob undefined (createApp defaults)", () => {
  withEnv(SERVER_ENV, () => {
    assertEquals(resolveServerOptions(null), {
      canonicalOrigin: undefined,
      trustForwardedHeaders: undefined,
      requestTimeout: undefined,
      maxConcurrency: undefined,
      slotBackstop: undefined,
      actionMaxBodyBytes: undefined,
      cacheKeyParams: undefined,
    });
  });
});

Deno.test("resolveServerOptions: the env vars fill in what the config leaves unset", () => {
  withEnv({
    DENEXT_CANONICAL_ORIGIN: "https://example.com",
    DENEXT_TRUST_PROXY: "1",
    DENEXT_REQUEST_TIMEOUT_MS: "0",
    DENEXT_MAX_CONCURRENCY: "64",
  }, () => {
    const r = resolveServerOptions({ slotBackstop: 5000, cacheKeyParams: ["page"] });
    assertEquals(r.canonicalOrigin, "https://example.com");
    assertEquals(r.trustForwardedHeaders, true);
    assertEquals(r.requestTimeout, 0);
    assertEquals(r.maxConcurrency, 64);
    assertEquals(r.slotBackstop, 5000);
    assertEquals(r.cacheKeyParams, ["page"]);
  });
  // The flag's spellings: 1/true/yes/on are on; anything else set is an explicit off.
  for (
    const [raw, want] of [["true", true], ["YES", true], ["on", true], ["0", false], [
      "no",
      false,
    ]] as const
  ) {
    withEnv({ ...SERVER_ENV, DENEXT_TRUST_PROXY: raw }, () => {
      assertEquals(
        resolveServerOptions({}).trustForwardedHeaders,
        want,
        `DENEXT_TRUST_PROXY=${raw}`,
      );
    });
  }
});

Deno.test("resolveServerOptions: the config wins over the env var", () => {
  withEnv({
    DENEXT_CANONICAL_ORIGIN: "https://env.example",
    DENEXT_TRUST_PROXY: "1",
    DENEXT_REQUEST_TIMEOUT_MS: "5",
    DENEXT_MAX_CONCURRENCY: "5",
  }, () => {
    const r = resolveServerOptions({
      canonicalOrigin: "https://config.example",
      trustForwardedHeaders: false,
      requestTimeout: 1000,
      maxConcurrency: 10,
    });
    assertEquals(r.canonicalOrigin, "https://config.example");
    assertEquals(r.trustForwardedHeaders, false);
    assertEquals(r.requestTimeout, 1000);
    assertEquals(r.maxConcurrency, 10);
  });
});

Deno.test("resolveServerOptions: a malformed env value is ignored with one warning, never a boot failure", () => {
  const original = console.warn;
  const warned: string[] = [];
  console.warn = (...args: unknown[]) => warned.push(args.map(String).join(" "));
  try {
    withEnv({
      ...SERVER_ENV,
      DENEXT_CANONICAL_ORIGIN: "example.com/app",
      DENEXT_REQUEST_TIMEOUT_MS: "soon",
      DENEXT_MAX_CONCURRENCY: "0",
    }, () => {
      const r = resolveServerOptions({});
      assertEquals(r.canonicalOrigin, undefined);
      assertEquals(r.requestTimeout, undefined);
      assertEquals(r.maxConcurrency, undefined);
    });
  } finally {
    console.warn = original;
  }
  assertEquals(warned.length, 3);
  assertStringIncludes(warned[0], 'DENEXT_CANONICAL_ORIGIN="example.com/app"');
  assertStringIncludes(warned[1], 'DENEXT_REQUEST_TIMEOUT_MS="soon"');
  assertStringIncludes(warned[2], 'DENEXT_MAX_CONCURRENCY="0"');
});

Deno.test("isOrigin: scheme + host (+ port) only", () => {
  assert(isOrigin("https://example.com"));
  assert(isOrigin("http://localhost:3000"));
  assert(!isOrigin("https://example.com/"));
  assert(!isOrigin("https://example.com/app"));
  assert(!isOrigin("https://user:pw@example.com"));
  assert(!isOrigin("https://example.com?x=1"));
  assert(!isOrigin("example.com"));
  assert(!isOrigin("ws://example.com"));
});
