import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  compilePattern,
  type DenextConfig,
  fillDestination,
  matchPattern,
  resolveLive,
  resolveStreaming,
  safeRedirectLocation,
} from "../src/server/config.ts";
import { createApp } from "../src/server/app.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { Link } from "../src/client/navigation.ts";

Deno.test("resolveStreaming/resolveLive: top-level wins, legacy experimental.* still honored", () => {
  // Promoted top-level fields are the canonical home.
  assertEquals(resolveStreaming({ streaming: false }), false);
  const live = { allowAnonymous: true };
  assertEquals(resolveLive({ live }), live);

  // A config written before the promotion still works (back-compat) — the legacy
  // `experimental.streaming`/`experimental.live` is read when the top-level is absent.
  const legacy = {
    experimental: { streaming: false, live },
  } as unknown as DenextConfig;
  assertEquals(resolveStreaming(legacy), false);
  assertEquals(resolveLive(legacy), live);

  // Top-level takes precedence over a stale legacy value.
  const both = {
    streaming: true,
    experimental: { streaming: false },
  } as unknown as DenextConfig;
  assertEquals(resolveStreaming(both), true);

  // Neither set → undefined (the caller's default-on applies).
  assertEquals(resolveStreaming({}), undefined);
  assertEquals(resolveLive(null), undefined);
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
