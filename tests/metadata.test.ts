import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import { type HeadCollector, renderToString } from "../src/jsx/render-to-string.ts";
import { renderPage } from "../src/server/render-page.ts";
import {
  type Robots,
  serializeRobots,
  serializeSitemap,
  serveMetadataFile,
  type Sitemap,
} from "../src/server/metadata-files.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { PageMatch } from "../src/router/match.ts";

// ---- In-tree metadata hoisting --------------------------------------------

Deno.test("renderToString hoists title/meta/link when a collector is given", async () => {
  const head: HeadCollector = { tags: [] };
  const html = await renderToString(
    h("div", null, [
      h("title", null, "Page Title"),
      h("meta", { name: "description", content: "hello" }),
      h("link", { rel: "canonical", href: "/x" }),
      h("p", null, "body"),
    ]),
    { head },
  );
  // Hoisted tags are removed from the body.
  assertEquals(html, "<div><p>body</p></div>");
  assertEquals(head.title, "Page Title");
  assertEquals(head.tags.length, 2);
  assertStringIncludes(head.tags.join(""), `<meta name="description" content="hello">`);
  assertStringIncludes(head.tags.join(""), `<link rel="canonical" href="/x">`);
});

Deno.test("renderToString renders metadata inline without a collector (backwards compat)", async () => {
  const html = await renderToString(h("title", null, "T"));
  assertEquals(html, "<title>T</title>");
});

Deno.test("renderPage folds in-tree metadata into the page metadata", async () => {
  const modules: Record<string, unknown> = {
    "page.tsx": {
      default: () =>
        h("main", null, [
          h("title", null, "From Tree"),
          h("meta", { property: "og:type", content: "article" }),
          h("h1", null, "hi"),
        ]),
      metadata: { title: "From Export" },
    },
  };
  const match: PageMatch = {
    route: {
      kind: "page",
      pattern: parsePattern("x"),
      routePath: "/x",
      filePath: "page.tsx",
      layoutChain: [],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
      templateChain: [],
    },
    params: {},
  };
  const { html, metadata } = await renderPage(
    match,
    new Request("http://x/x"),
    (fp) => Promise.resolve(modules[fp]),
  );
  // In-tree <title> wins over the metadata export.
  assertEquals(metadata.title, "From Tree");
  assertStringIncludes(metadata.head ?? "", `property="og:type"`);
  // The hoisted tags are gone from the body.
  assert(!html.includes("<title>"));
});

// ---- Sitemap / robots serialization ---------------------------------------

Deno.test("serializeSitemap emits a valid urlset", () => {
  const sm: Sitemap = [
    { url: "https://x.com/", priority: 1, changeFrequency: "daily" },
    { url: "https://x.com/about", lastModified: "2026-01-01" },
  ];
  const xml = serializeSitemap(sm);
  assertStringIncludes(xml, `<?xml version="1.0" encoding="UTF-8"?>`);
  assertStringIncludes(xml, "<loc>https://x.com/</loc>");
  assertStringIncludes(xml, "<changefreq>daily</changefreq>");
  assertStringIncludes(xml, "<lastmod>2026-01-01</lastmod>");
});

Deno.test("serializeRobots emits rules + sitemap", () => {
  const robots: Robots = {
    rules: { userAgent: "*", allow: "/", disallow: ["/admin", "/private"] },
    sitemap: "https://x.com/sitemap.xml",
  };
  const txt = serializeRobots(robots);
  assertStringIncludes(txt, "User-Agent: *");
  assertStringIncludes(txt, "Allow: /");
  assertStringIncludes(txt, "Disallow: /admin");
  assertStringIncludes(txt, "Disallow: /private");
  assertStringIncludes(txt, "Sitemap: https://x.com/sitemap.xml");
});

// ---- serveMetadataFile -----------------------------------------------------

function baseManifest(over: Partial<RouteManifest>): RouteManifest {
  return {
    pages: [],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
    ...over,
  };
}

Deno.test("serveMetadataFile serves sitemap.xml and robots.txt", async () => {
  const modules: Record<string, unknown> = {
    "sitemap.ts": { default: () => [{ url: "https://x.com/" }] },
    "robots.ts": { default: () => ({ rules: { userAgent: "*", allow: "/" } }) },
  };
  const manifest = baseManifest({ sitemap: "sitemap.ts", robots: "robots.ts" });
  const load = (fp: string) => Promise.resolve(modules[fp]);

  const sm = await serveMetadataFile(manifest, "/sitemap.xml", load);
  assert(sm);
  assertStringIncludes(sm!.headers.get("content-type") ?? "", "application/xml");
  assertStringIncludes(await sm!.text(), "<loc>https://x.com/</loc>");

  const rb = await serveMetadataFile(manifest, "/robots.txt", load);
  assert(rb);
  assertStringIncludes(await rb!.text(), "User-Agent: *");

  // A path with no matching file returns null.
  assertEquals(await serveMetadataFile(manifest, "/nope", load), null);
});

Deno.test("serveMetadataFile serves a favicon file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_favicon_" });
  const favPath = join(dir, "favicon.ico");
  await Deno.writeFile(favPath, new Uint8Array([0, 1, 2, 3]));
  try {
    const manifest = baseManifest({ favicon: favPath });
    const res = await serveMetadataFile(manifest, "/favicon.ico", () => Promise.resolve({}));
    assert(res);
    assertEquals(res!.headers.get("content-type"), "image/x-icon");
    assertEquals(new Uint8Array(await res!.arrayBuffer()), new Uint8Array([0, 1, 2, 3]));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
