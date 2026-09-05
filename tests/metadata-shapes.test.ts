// Next.js-shaped Metadata (2.0): `images`, URL metadataBase, keyword strings, theme-color
// descriptors, icon descriptors, the manifest link and the long tail of fields;
// generateMetadata(props, parent); generateImageMetadata variants; static metadata files;
// nested images under dynamic segments; alt.txt sidecars; sitemap escaping.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderHeadContent } from "../src/server/document.ts";
import { renderPage } from "../src/server/render-page.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import { serializeSitemap, serveMetadataFile } from "../src/server/metadata-files.ts";
import type { Metadata, PageProps, ResolvingMetadata } from "../src/server/types.ts";
import type { PageMatch } from "../src/router/match.ts";

Deno.test("head: Next-shaped fields render", () => {
  const md: Metadata = {
    metadataBase: new URL("https://ex.com"),
    keywords: "a, b",
    applicationName: "App",
    manifest: "/manifest.webmanifest",
    openGraph: {
      images: [{ url: "/og.png", width: 1200, height: 630, alt: "cover", type: "image/png" }],
      locale: "en_US",
      publishedTime: "2026-01-01",
      tags: ["x", "y"],
    },
    twitter: { card: "summary", images: "/tw.png" },
    icons: {
      icon: [{ url: "/i32.png", sizes: "32x32", type: "image/png" }, "/plain.ico"],
      other: [{ rel: "mask-icon", url: "/mask.svg", color: "#000" }],
    },
    alternates: {
      types: { "application/rss+xml": "/feed.xml" },
      media: { "only screen and (max-width: 600px)": "/m" },
    },
    other: { "x-custom": ["1", "2"] },
    appleWebApp: { title: "App", statusBarStyle: "black" },
    formatDetection: { telephone: false },
    itemProp: { name: "App" },
    appLinks: { ios: { url: "app://x", appStoreId: 1 } },
  };
  const head = renderHeadContent(md, {
    themeColor: [{ media: "(prefers-color-scheme: dark)", color: "#000" }],
    viewportFit: "cover",
  });
  for (
    const expected of [
      `<meta name="keywords" content="a, b">`,
      `<meta name="application-name" content="App">`,
      `<link rel="manifest" href="/manifest.webmanifest">`,
      `<meta property="og:image" content="https://ex.com/og.png">`,
      `<meta property="og:image:type" content="image/png">`,
      `<meta property="og:locale" content="en_US">`,
      `<meta property="article:published_time" content="2026-01-01">`,
      `<meta property="article:tag" content="y">`,
      `<meta name="twitter:image" content="https://ex.com/tw.png">`,
      `<link rel="icon" href="/i32.png" sizes="32x32" type="image/png">`,
      `<link rel="icon" href="/plain.ico">`,
      `<link rel="mask-icon" href="/mask.svg" color="#000">`,
      `<link rel="alternate" type="application/rss+xml" href="https://ex.com/feed.xml">`,
      `<link rel="alternate" media="only screen and (max-width: 600px)" href="https://ex.com/m">`,
      `<meta name="x-custom" content="1"><meta name="x-custom" content="2">`,
      `<meta name="apple-mobile-web-app-title" content="App">`,
      `<meta name="format-detection" content="telephone=no">`,
      `<meta itemprop="name" content="App">`,
      `<meta property="al:ios:app_store_id" content="1">`,
      `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000">`,
      `viewport-fit=cover`,
    ]
  ) assertStringIncludes(head, expected);
});

Deno.test("generateMetadata(props, parent): the page and a nested layout see the parents' merged metadata", async () => {
  const modules: Record<string, unknown> = {
    "layout.tsx": {
      default: (p: { children: unknown }) => h("div", null, p.children as never),
      metadata: { openGraph: { images: ["/root.png"] }, title: "Root" },
    },
    "a/layout.tsx": {
      default: (p: { children: unknown }) => h("section", null, p.children as never),
      generateMetadata: async (_p: PageProps, parent: ResolvingMetadata) => ({
        description: `parent-title:${String((await parent).title)}`,
      }),
    },
    "a/page.tsx": {
      default: () => h("h1", null, "x"),
      generateMetadata: async (_p: PageProps, parent: ResolvingMetadata) => {
        const prev = (await parent).openGraph?.images;
        return { openGraph: { images: [...(Array.isArray(prev) ? prev : []), "/page.png"] } };
      },
    },
  };
  const load = (fp: string) => Promise.resolve(modules[fp]);
  const req = new Request("http://x/a");
  const match: PageMatch = {
    route: {
      kind: "page",
      pattern: parsePattern("a"),
      routePath: "/a",
      filePath: "a/page.tsx",
      layoutChain: ["layout.tsx", "a/layout.tsx"],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
      templateChain: [],
    },
    params: {},
  };
  const out = await runWithContext(createRequestContext(req), () => renderPage(match, req, load));
  assertEquals(out.metadata.openGraph?.images, ["/root.png", "/page.png"]);
  assertEquals(out.metadata.description, "parent-title:Root");
});

Deno.test("metadata files: static robots.txt / sitemap.xml / manifest.json and a nested dynamic-segment image", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "page.tsx"), "export default () => null;");
    await Deno.writeTextFile(join(dir, "robots.txt"), "User-agent: *\nAllow: /\n");
    await Deno.writeTextFile(join(dir, "sitemap.xml"), "<urlset/>");
    await Deno.writeTextFile(join(dir, "manifest.json"), '{"name":"x"}');
    await Deno.writeTextFile(join(dir, "opengraph-image.png"), "PNG");
    await Deno.writeTextFile(join(dir, "opengraph-image.alt.txt"), "Site cover");
    await Deno.mkdir(join(dir, "blog", "[slug]"), { recursive: true });
    await Deno.writeTextFile(join(dir, "blog", "[slug]", "page.tsx"), "export default () => null;");
    await Deno.writeTextFile(
      join(dir, "blog", "[slug]", "opengraph-image.tsx"),
      "export default () => null;",
    );
    const m = await scanRoutes(dir);
    assert(
      m.robots?.endsWith("robots.txt") && m.sitemap?.endsWith("sitemap.xml"),
      "static files detected",
    );
    assert(m.webManifest?.endsWith("manifest.json"));
    assert(
      m.openGraphImage?.endsWith("opengraph-image.png"),
      "static og image detected at the root",
    );
    assertEquals(
      m.imageRoutes?.has("/blog/[slug]/opengraph-image"),
      true,
      "nested dynamic image registered",
    );
    const blog = m.pages.find((p) => p.routePath === "/blog/[slug]");
    assertEquals(blog?.openGraphImage, "/blog/[slug]/opengraph-image");

    const load = (fp: string) =>
      Promise.resolve(
        fp.endsWith("opengraph-image.tsx")
          ? {
            generateImageMetadata: ({ params }: { params: Record<string, unknown> }) => [
              { id: "small", alt: `${params.slug}-s`, contentType: "image/png" },
              { id: "large", alt: `${params.slug}-l` },
            ],
            default: ({ params, id }: { params: Record<string, unknown>; id?: string }) =>
              new Response(`${params.slug}:${id}`),
          }
          : {},
      );
    const robots = await serveMetadataFile(m, "/robots.txt", load);
    assertStringIncludes(await robots!.text(), "User-agent");
    assertStringIncludes(robots!.headers.get("content-type")!, "text/plain");
    const sm = await serveMetadataFile(m, "/sitemap.xml", load);
    assertEquals(await sm!.text(), "<urlset/>");
    const wm = await serveMetadataFile(m, "/manifest.webmanifest", load);
    assertStringIncludes(wm!.headers.get("content-type")!, "manifest+json");
    // Nested dynamic-segment image with generateImageMetadata variants.
    const first = await serveMetadataFile(m, "/blog/hello/opengraph-image", load);
    assertEquals(await first!.text(), "hello:small");
    const large = await serveMetadataFile(m, "/blog/hello/opengraph-image/large", load);
    assertEquals(await large!.text(), "hello:large");
    assertEquals(await serveMetadataFile(m, "/blog/hello/opengraph-image/nope", load), null);
    assertStringIncludes(first!.headers.get("content-type")!, "image/png");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sitemap: changeFrequency is escaped like every other field", () => {
  const xml = serializeSitemap([{ url: "https://x/", changeFrequency: "<bad>" as never }]);
  assertStringIncludes(xml, "<changefreq>&lt;bad&gt;</changefreq>");
});
