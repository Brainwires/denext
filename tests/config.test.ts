import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { compilePattern, fillDestination, matchPattern } from "../src/server/config.ts";
import { createApp } from "../src/server/app.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { Link } from "../src/client/navigation.ts";

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
