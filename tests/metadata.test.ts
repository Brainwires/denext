import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  collapseHeadTags,
  type HeadCollector,
  renderToString,
} from "../src/jsx/render-to-string.ts";
import { renderPage } from "../src/server/render-page.ts";
import {
  type OpenGraphImageResult,
  type Robots,
  serializeRobots,
  serializeSitemap,
  serializeSitemapIndex,
  serveMetadataFile,
  type Sitemap,
  type SitemapModule,
} from "../src/server/metadata-files.ts";
import type { PageRoute, RouteManifest } from "../src/router/manifest.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { PageMatch } from "../src/router/match.ts";
import { createApp } from "../src/server/app.ts";
import type { PageProps } from "../src/server/types.ts";

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
  const tags = collapseHeadTags(head.tags);
  assertStringIncludes(tags, `<meta name="description" content="hello">`);
  assertStringIncludes(tags, `<link rel="canonical" href="/x">`);
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

Deno.test("renderPage runs layout generateMetadata and merges outer→inner (page wins)", async () => {
  const modules: Record<string, unknown> = {
    "layout.tsx": {
      default: (p: { children: unknown }) => h("div", null, p.children as never),
      generateMetadata: (props: { searchParams: Record<string, unknown> }) => ({
        title: `Layout ${props.searchParams.q ?? "?"}`,
        description: "from layout",
      }),
    },
    "page.tsx": {
      default: () => h("h1", null, "hi"),
      metadata: { title: "Page Title" }, // page's own metadata wins over the layout's
    },
  };
  const match: PageMatch = {
    route: {
      kind: "page",
      pattern: parsePattern("x"),
      routePath: "/x",
      filePath: "page.tsx",
      layoutChain: ["layout.tsx"],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
      templateChain: [],
    },
    params: {},
  };
  const { metadata } = await renderPage(
    match,
    new Request("http://x/x?q=hello"),
    (fp) => Promise.resolve(modules[fp]),
  );
  // Layout generateMetadata ran (saw searchParams) and contributed description;
  // the page's own title wins over the layout's.
  assertEquals(metadata.title, "Page Title");
  assertEquals(metadata.description, "from layout");
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

Deno.test("serveMetadataFile serves an SVG opengraph-image", async () => {
  const svg = h(
    "svg",
    { xmlns: "http://www.w3.org/2000/svg", width: 1200, height: 630 },
    [h("title", null, "Card"), h("rect", { width: 1200, height: 630, fill: "black" })],
  );
  const manifest = baseManifest({ openGraphImage: "opengraph-image.tsx" });
  const load = (_fp: string) => Promise.resolve({ default: (): OpenGraphImageResult => svg });

  const res = await serveMetadataFile(manifest, "/opengraph-image", load);
  assert(res);
  assertStringIncludes(res!.headers.get("content-type") ?? "", "image/svg+xml");
  const body = await res!.text();
  assertStringIncludes(body, "<?xml");
  assertStringIncludes(body, '<svg xmlns="http://www.w3.org/2000/svg"');
  // An in-SVG <title> is preserved inline (not hoisted into a document head).
  assertStringIncludes(body, "<title>Card</title>");
  assertStringIncludes(body, '<rect width="1200" height="630" fill="black">');
});

Deno.test("serveMetadataFile serves bring-your-own-bytes as image/png", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71]); // PNG magic
  const manifest = baseManifest({ openGraphImage: "opengraph-image.ts" });
  const load = (_fp: string) => Promise.resolve({ default: (): OpenGraphImageResult => bytes });

  const res = await serveMetadataFile(manifest, "/opengraph-image", load);
  assert(res);
  assertEquals(res!.headers.get("content-type"), "image/png");
  assertEquals(new Uint8Array(await res!.arrayBuffer()), bytes);
});

Deno.test("serveMetadataFile returns a raw Response verbatim", async () => {
  const manifest = baseManifest({ openGraphImage: "opengraph-image.ts" });
  const load = (_fp: string) =>
    Promise.resolve({
      default: (): OpenGraphImageResult =>
        new Response("GIF89a", { headers: { "content-type": "image/gif" } }),
    });

  const res = await serveMetadataFile(manifest, "/opengraph-image", load);
  assert(res);
  assertEquals(res!.headers.get("content-type"), "image/gif");
  assertEquals(await res!.text(), "GIF89a");
});

Deno.test("scanRoutes detects a root opengraph-image module", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_og_" });
  try {
    await Deno.writeTextFile(join(dir, "page.tsx"), "export default function(){}\n");
    await Deno.writeTextFile(join(dir, "opengraph-image.tsx"), "export default function(){}\n");
    const manifest = await scanRoutes(dir);
    assertStringIncludes(manifest.openGraphImage ?? "", "opengraph-image.tsx");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
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

// ---- Sitemap sharding + per-entry hreflang (Phase 3a) ----------------------

Deno.test("serializeSitemap emits xhtml:link alternates only when present", () => {
  const withAlts = serializeSitemap([
    {
      url: "https://x.com/",
      alternates: { languages: { en: "https://x.com/", fr: "https://x.com/fr" } },
    },
  ]);
  assertStringIncludes(withAlts, `xmlns:xhtml="http://www.w3.org/1999/xhtml"`);
  assertStringIncludes(
    withAlts,
    `<xhtml:link rel="alternate" hreflang="fr" href="https://x.com/fr"/>`,
  );
  // No alternates -> no xhtml namespace declared (keeps the common case clean).
  assertEquals(serializeSitemap([{ url: "https://x.com/" }]).includes("xmlns:xhtml"), false);
});

Deno.test("serializeSitemapIndex emits a sitemapindex", () => {
  const xml = serializeSitemapIndex([
    { url: "https://x.com/sitemap/0.xml" },
    { url: "https://x.com/sitemap/1.xml", lastModified: "2026-01-01" },
  ]);
  assertStringIncludes(xml, "<sitemapindex");
  assertStringIncludes(xml, "<loc>https://x.com/sitemap/0.xml</loc>");
  assertStringIncludes(xml, "<lastmod>2026-01-01</lastmod>");
});

Deno.test("generateSitemaps: /sitemap.xml is an index, /sitemap/{id}.xml a shard", async () => {
  const mod: SitemapModule = {
    generateSitemaps: () => [{ id: 0 }, { id: 1 }],
    default: ({ id } = { id: 0 }) => [{ url: `https://x.com/page-${id}` }],
  };
  const manifest = baseManifest({ sitemap: "sitemap.ts" });
  const load = () => Promise.resolve(mod);

  // The index lists absolute shard URLs (origin passed through).
  const idx = await serveMetadataFile(manifest, "/sitemap.xml", load, "https://x.com");
  assert(idx);
  const idxBody = await idx!.text();
  assertStringIncludes(idxBody, "<sitemapindex");
  assertStringIncludes(idxBody, "<loc>https://x.com/sitemap/0.xml</loc>");
  assertStringIncludes(idxBody, "<loc>https://x.com/sitemap/1.xml</loc>");

  // A shard resolves its id and renders that shard's entries.
  const shard = await serveMetadataFile(manifest, "/sitemap/1.xml", load, "https://x.com");
  assert(shard);
  assertStringIncludes(await shard!.text(), "<loc>https://x.com/page-1</loc>");

  // An id that generateSitemaps didn't enumerate 404s (null).
  assertEquals(await serveMetadataFile(manifest, "/sitemap/9.xml", load, "https://x.com"), null);
});

Deno.test("without generateSitemaps, a shard URL does not resolve", async () => {
  const manifest = baseManifest({ sitemap: "sitemap.ts" });
  const load = () => Promise.resolve({ default: () => [{ url: "https://x.com/" }] });
  // The plain /sitemap.xml still works.
  assert(await serveMetadataFile(manifest, "/sitemap.xml", load));
  // But /sitemap/0.xml is not a route when the module isn't sharded.
  assertEquals(await serveMetadataFile(manifest, "/sitemap/0.xml", load), null);
});

// ---- Nested per-route opengraph-image (Phase 3b) ---------------------------

Deno.test("scanRoutes records nested opengraph-image + inherits to dynamic children", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_nested_og_" });
  try {
    const page = "export default function(){}\n";
    // /blog has its own opengraph-image; /blog/[slug] inherits it; root page does not.
    await Deno.writeTextFile(join(dir, "page.tsx"), page);
    await Deno.mkdir(join(dir, "blog", "[slug]"), { recursive: true });
    await Deno.writeTextFile(join(dir, "blog", "page.tsx"), page);
    await Deno.writeTextFile(join(dir, "blog", "opengraph-image.tsx"), page);
    await Deno.writeTextFile(join(dir, "blog", "[slug]", "page.tsx"), page);

    const manifest = await scanRoutes(dir);
    // The nested image is registered at its served URL path.
    assertStringIncludes(
      manifest.imageRoutes?.get("/blog/opengraph-image") ?? "",
      "opengraph-image.tsx",
    );

    const blog = manifest.pages.find((p) => p.routePath === "/blog");
    const slug = manifest.pages.find((p) => p.routePath === "/blog/[slug]");
    const rootPage = manifest.pages.find((p) => p.routePath === "/");
    assertEquals(blog?.openGraphImage, "/blog/opengraph-image");
    // Inherited (nearest static ancestor) by the dynamic child.
    assertEquals(slug?.openGraphImage, "/blog/opengraph-image");
    // The root page has no nested image (falls back to manifest.openGraphImage).
    assertEquals(rootPage?.openGraphImage, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a matched page's nested opengraph-image is injected as an absolute og:image", async () => {
  const route: PageRoute = {
    kind: "page",
    pattern: parsePattern("blog"),
    routePath: "/blog",
    filePath: "blog/page.tsx",
    layoutChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
    templateChain: [],
    openGraphImage: "/blog/opengraph-image",
  };
  const manifest: RouteManifest = {
    pages: [route],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
  const app = createApp({
    getManifest: () => manifest,
    load: () => Promise.resolve({ default: (_p: PageProps) => h("h1", null, "blog") }),
    canonicalOrigin: "https://x.com",
  });
  const html = await (await app(new Request("https://x.com/blog"))).text();
  assertStringIncludes(
    html,
    `<meta property="og:image" content="https://x.com/blog/opengraph-image">`,
  );
});

Deno.test("serveMetadataFile serves a nested opengraph-image via imageRoutes", async () => {
  const manifest = baseManifest({
    imageRoutes: new Map([["/blog/opengraph-image", "blog/opengraph-image.tsx"]]),
  });
  const svg = h("svg", { xmlns: "http://www.w3.org/2000/svg" }, []);
  const load = () => Promise.resolve({ default: (): OpenGraphImageResult => svg });
  const res = await serveMetadataFile(manifest, "/blog/opengraph-image", load);
  assert(res);
  assertStringIncludes(res!.headers.get("content-type") ?? "", "image/svg+xml");
  // A URL not in the map is not a metadata file.
  assertEquals(await serveMetadataFile(manifest, "/other/opengraph-image", load), null);
});
