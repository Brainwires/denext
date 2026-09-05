import { assertEquals, assertStringIncludes } from "@std/assert";
import { assert } from "@std/assert";
import { renderDocument } from "../src/server/document.ts";
import { mergeMetadata, mergeViewport, renderPage } from "../src/server/render-page.ts";
import type { Metadata } from "../src/server/types.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNodeChild } from "../src/jsx/types.ts";
import {
  collapseHeadTags,
  type HeadCollector,
  headDedupKey,
  renderToString,
} from "../src/jsx/render-to-string.ts";
import { renderShell } from "../src/jsx/render-to-stream.ts";
import { renderFlightShell } from "../src/jsx/render-to-flight-stream.ts";
import Head from "../src/compat/next/head.ts";
import { Children } from "../src/compat/react.ts";
import type { PageMatch } from "../src/router/match.ts";
import { parsePattern } from "../src/router/segments.ts";

function head(
  metadata: Metadata,
  viewport?: Parameters<typeof renderDocument>[0]["viewport"],
): string {
  const doc = renderDocument({ bodyHtml: "", metadata, viewport });
  return doc.slice(doc.indexOf("<head>"), doc.indexOf("</head>"));
}

Deno.test("twitter card tags are emitted", () => {
  const h = head({
    twitter: { card: "summary_large_image", site: "@denext", title: "Hi", images: "/t.png" },
  });
  assertStringIncludes(h, `<meta name="twitter:card" content="summary_large_image">`);
  assertStringIncludes(h, `<meta name="twitter:site" content="@denext">`);
  assertStringIncludes(h, `<meta name="twitter:image" content="/t.png">`);
});

Deno.test("structured icons emit icon/shortcut/apple links", () => {
  const h = head({ icons: { icon: "/i.png", shortcut: "/s.ico", apple: ["/a1.png", "/a2.png"] } });
  assertStringIncludes(h, `<link rel="icon" href="/i.png">`);
  assertStringIncludes(h, `<link rel="shortcut icon" href="/s.ico">`);
  assertStringIncludes(h, `<link rel="apple-touch-icon" href="/a1.png">`);
  assertStringIncludes(h, `<link rel="apple-touch-icon" href="/a2.png">`);
});

Deno.test("L6: metadata.head is injected raw and warns only in dev", () => {
  // The raw <head> escape hatch is emitted verbatim (no escaping).
  const h = head({ head: '<link rel="preconnect" href="https://cdn.example">' });
  assertStringIncludes(h, '<link rel="preconnect" href="https://cdn.example">');

  const g = globalThis as { __denextDev?: boolean };
  const prevDev = g.__denextDev;
  const origWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
  try {
    // Prod (default): silent even though the sink is used.
    g.__denextDev = false;
    head({ head: "<meta name=x>" });
    assert(warnings.length === 0, "no warning in prod");

    // Dev: warns that the sink is unescaped.
    g.__denextDev = true;
    head({ head: "<meta name=x>" });
    assert(warnings.some((w) => w.includes("metadata.head")), "dev warns about raw head");

    // De-duplicated by content: the SAME head warns once per process (not per render),
    // so a static head doesn't spam the dev console on every request.
    warnings.length = 0;
    head({ head: "<meta name=denext-dedup-unique>" });
    head({ head: "<meta name=denext-dedup-unique>" });
    assertEquals(warnings.length, 1, "same head content warns once, not per render");
    // A DIFFERENT head still warns (a head interpolating changing data is the risk).
    head({ head: "<meta name=denext-dedup-other>" });
    assertEquals(warnings.length, 2, "a distinct head body warns again");

    // Dev but the sink is unused: no warning.
    warnings.length = 0;
    head({ title: "hi" });
    assert(warnings.length === 0, "no warning when metadata.head is absent");
  } finally {
    console.warn = origWarn;
    if (prevDev === undefined) delete g.__denextDev;
    else g.__denextDev = prevDev;
  }
});

Deno.test("robots object serializes to a directive string + googlebot", () => {
  const h = head({ robots: { index: false, follow: true, noarchive: true, googleBot: "noindex" } });
  assertStringIncludes(h, `<meta name="robots" content="noindex, follow, noarchive">`);
  assertStringIncludes(h, `<meta name="googlebot" content="noindex">`);
});

Deno.test("metadataBase resolves relative og/twitter images to absolute", () => {
  const h = head({
    metadataBase: "https://example.com",
    openGraph: { images: "/og.png" },
    twitter: { images: "/tw.png" },
  });
  assertStringIncludes(h, `content="https://example.com/og.png"`);
  assertStringIncludes(h, `content="https://example.com/tw.png"`);
});

Deno.test("og:image descriptor emits width/height/alt", () => {
  const h = head({
    openGraph: { images: { url: "/o.png", width: 1200, height: 630, alt: "cover" } },
  });
  assertStringIncludes(h, `<meta property="og:image" content="/o.png">`);
  assertStringIncludes(h, `<meta property="og:image:width" content="1200">`);
  assertStringIncludes(h, `<meta property="og:image:alt" content="cover">`);
});

Deno.test("alternates emit canonical + hreflang links", () => {
  const h = head({
    alternates: { canonical: "https://x.com/", languages: { "en-US": "https://x.com/en" } },
  });
  assertStringIncludes(h, `<link rel="canonical" href="https://x.com/">`);
  assertStringIncludes(h, `<link rel="alternate" hreflang="en-US" href="https://x.com/en">`);
});

Deno.test("jsonLd emits one application/ld+json script per object", () => {
  const h = head({
    jsonLd: [
      { "@context": "https://schema.org", "@type": "Organization", name: "Acme" },
      { "@context": "https://schema.org", "@type": "WebSite", name: "Acme Site" },
    ],
  });
  const scripts = h.match(/<script type="application\/ld\+json">/g) ?? [];
  assertEquals(scripts.length, 2);
  assertStringIncludes(h, `"@type":"Organization"`);
  assertStringIncludes(h, `"@type":"WebSite"`);
});

Deno.test("jsonLd accepts a single object (not just an array)", () => {
  const h = head({
    jsonLd: { "@context": "https://schema.org", "@type": "Article", headline: "Hi" },
  });
  const scripts = h.match(/<script type="application\/ld\+json">/g) ?? [];
  assertEquals(scripts.length, 1);
  assertStringIncludes(h, `"headline":"Hi"`);
});

Deno.test("jsonLd payload is escaped so it cannot break out of the script", () => {
  // A hostile string containing </script>, angle brackets, ampersand, and the
  // U+2028/U+2029 line separators must not terminate the element or the JS parse.
  const evil = "</script><img src=x onerror=alert(1)> &\u2028\u2029 end";
  const h = head({ jsonLd: { "@type": "Thing", name: evil } });
  // No literal breakout sequence survives.
  assert(!h.includes("</script><img"), "must not contain a raw </script> breakout");
  assert(!h.includes("<img src=x"), "raw < must be escaped");
  assertStringIncludes(h, "\\u003c");
  assertStringIncludes(h, "\\u2028");
  // The payload between the tags is still valid JSON once unescaped, and round-trips.
  const body = h.slice(
    h.indexOf(`application/ld+json">`) + `application/ld+json">`.length,
    h.indexOf("</script>"),
  );
  // \uXXXX escapes are valid JSON string escapes, so JSON.parse restores the original.
  const parsed = JSON.parse(body) as { name: string };
  assertEquals(parsed.name, evil);
});

Deno.test("jsonLd from layout + page accumulate (both emitted)", () => {
  const merged = mergeMetadata([
    { jsonLd: { "@type": "Organization", name: "Acme" } },
    { jsonLd: { "@type": "Article", headline: "Post" } },
  ]);
  assert(Array.isArray(merged.jsonLd) && merged.jsonLd.length === 2);
  const h = head(merged);
  assertStringIncludes(h, `"@type":"Organization"`);
  assertStringIncludes(h, `"@type":"Article"`);
});

Deno.test("generateViewport output builds the viewport + theme-color tags", () => {
  const h = head({}, {
    width: "device-width",
    initialScale: 1,
    maximumScale: 2,
    userScalable: false,
    themeColor: "#000",
    colorScheme: "dark",
  });
  assertStringIncludes(
    h,
    `<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=2, user-scalable=no">`,
  );
  assertStringIncludes(h, `<meta name="theme-color" content="#000">`);
  assertStringIncludes(h, `<meta name="color-scheme" content="dark">`);
});

Deno.test("mergeMetadata + mergeViewport override left-to-right", () => {
  const merged = mergeMetadata([
    { title: "layout", twitter: { site: "@a" } },
    { title: "page", twitter: { creator: "@b" } },
  ]);
  assert(merged.title === "page");
  assert(merged.twitter?.site === "@a" && merged.twitter?.creator === "@b");
  const v = mergeViewport([{ themeColor: "#fff", initialScale: 1 }, { themeColor: "#000" }]);
  assert(v.themeColor === "#000" && v.initialScale === 1);
});

// ---- next/head de-duplication: `key` + charSet/viewport singletons ------------------
//
// Hoisted <meta>/<link> collapse by identity when the head is emitted (last wins), the way
// next/head's `unique()` does: a shared `key`, a second `charSet`, or a second unkeyed
// `name="viewport"`. Keyless distinct tags never collapse. Covered on the sync string path
// (renderToString), the streaming HTML shell (renderShell), and the streaming Flight shell
// (renderFlightShell) — each pushes into the collector through a different host renderer.

/** The collapsed head tags of `tree` on the sync string renderer. */
async function syncTags(tree: VNodeChild): Promise<string> {
  const head: HeadCollector = { tags: [] };
  await renderToString(tree, { head });
  return collapseHeadTags(head.tags);
}

/** The collapsed head tags of `tree` on the streaming HTML shell renderer. */
async function streamTags(tree: VNodeChild): Promise<string> {
  const head: HeadCollector = { tags: [] };
  await renderShell(tree, head);
  return collapseHeadTags(head.tags);
}

/** The collapsed head tags of `tree` on the streaming Flight (dual) shell renderer. */
async function flightTags(tree: VNodeChild): Promise<string> {
  const head: HeadCollector = { tags: [] };
  await renderFlightShell(tree, false, head);
  return collapseHeadTags(head.tags);
}

const renderers = { sync: syncTags, stream: streamTags, flight: flightTags };

/** Occurrences of `needle` in `hay`. */
function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

for (const [name, tags] of Object.entries(renderers)) {
  Deno.test(`next/head dedup (${name}): two <meta> with the same key → last wins`, async () => {
    const out = await tags(
      h("div", null, [
        h("meta", { key: "desc", name: "description", content: "layout" }),
        h("p", null, "body"),
        h("meta", { key: "desc", name: "description", content: "page" }),
      ]),
    );
    assertEquals(out, `<meta name="description" content="page">`);
    assertEquals(count(out, "<meta"), 1);
  });

  Deno.test(`next/head dedup (${name}): duplicate <meta charSet> collapses to one`, async () => {
    const out = await tags(
      h("div", null, [
        h("meta", { charSet: "utf-8" }),
        h("meta", { charset: "iso-8859-1" }),
      ]),
    );
    assertEquals(out, `<meta charset="iso-8859-1">`);
  });

  Deno.test(`next/head dedup (${name}): duplicate viewport → one (last wins)`, async () => {
    const out = await tags(
      h("div", null, [
        h("meta", { name: "viewport", content: "width=device-width" }),
        h("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
      ]),
    );
    assertEquals(
      out,
      `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    );
  });

  Deno.test(`next/head dedup (${name}): distinct keyless og:* tags all survive`, async () => {
    const out = await tags(
      h("div", null, [
        h("meta", { property: "og:image", content: "/a.png" }),
        h("meta", { property: "og:image", content: "/b.png" }),
        h("meta", { name: "description", content: "one" }),
        h("meta", { name: "description", content: "two" }),
        h("link", { rel: "stylesheet", href: "/a.css" }),
        h("link", { rel: "stylesheet", href: "/b.css" }),
      ]),
    );
    assertEquals(count(out, `property="og:image"`), 2);
    assertEquals(count(out, `name="description"`), 2);
    assertEquals(count(out, `rel="stylesheet"`), 2);
    assertStringIncludes(out, `href="/a.css"`);
    assertStringIncludes(out, `href="/b.css"`);
  });

  Deno.test(`next/head dedup (${name}): two <link> with the same key → one`, async () => {
    const out = await tags(
      h("div", null, [
        h("link", { key: "canon", rel: "canonical", href: "/old" }),
        h("link", { key: "canon", rel: "canonical", href: "/new" }),
      ]),
    );
    assertEquals(out, `<link rel="canonical" href="/new">`);
  });

  Deno.test(`next/head dedup (${name}): title still last-wins`, async () => {
    const head: HeadCollector = { tags: [] };
    const tree = h("div", null, [h("title", null, "First"), h("title", null, "Second")]);
    if (name === "sync") await renderToString(tree, { head });
    else if (name === "stream") await renderShell(tree, head);
    else await renderFlightShell(tree, false, head);
    assertEquals(head.title, "Second");
    assertEquals(head.tags.length, 0);
  });
}

Deno.test("next/head dedup: <Head> children from a layout and a page collapse by key", async () => {
  // The compat <Head> is a passthrough; dedup is generic at hoist time, so a page's
  // keyed tag replaces the layout's even across separate <Head> instances.
  const out = await syncTags(
    h("div", null, [
      h(Head, null, [
        h("meta", { key: "og", property: "og:title", content: "layout" }),
        h("meta", { charset: "utf-8" }),
      ]),
      h("main", null, "body"),
      h(Head, null, [
        h("meta", { key: "og", property: "og:title", content: "page" }),
        h("meta", { charset: "utf-8" }),
      ]),
    ]),
  );
  assertEquals(out, `<meta property="og:title" content="page"><meta charset="utf-8">`);
});

Deno.test("next/head dedup: the survivor keeps ITS position (later duplicate's slot)", async () => {
  const out = await syncTags(
    h("div", null, [
      h("meta", { key: "a", name: "x", content: "1" }),
      h("meta", { property: "og:type", content: "article" }),
      h("meta", { key: "a", name: "x", content: "2" }),
    ]),
  );
  assertEquals(
    out,
    `<meta property="og:type" content="article"><meta name="x" content="2">`,
  );
});

Deno.test("next/head dedup: a keyed viewport is identified by its key, not the singleton", () => {
  // next/head exempts keyed <meta name> tags from name-dedup; the key is the identity.
  assertEquals(headDedupKey("meta", { name: "viewport", key: "v1" }), "k:v1");
  assertEquals(headDedupKey("meta", { name: "viewport" }), "meta:viewport");
  assertEquals(headDedupKey("meta", { charSet: "utf-8", key: "c" }), "charset");
  assertEquals(headDedupKey("meta", { charset: "utf-8" }), "charset");
  assertEquals(headDedupKey("link", { rel: "icon", href: "/i.png" }), undefined);
  assertEquals(headDedupKey("link", { key: 0, rel: "icon" }), "k:0");
  assertEquals(headDedupKey("meta", { name: "description", content: "d" }), undefined);
  assertEquals(headDedupKey("meta", { property: "og:image", content: "/x" }), undefined);
});

Deno.test("next/head dedup: the key never leaks into the serialized tag", async () => {
  const out = await syncTags(h("meta", { key: "secret", name: "robots", content: "noindex" }));
  assertEquals(out, `<meta name="robots" content="noindex">`);
});

Deno.test("next/head dedup: collapseHeadTags is a plain join when nothing has an identity", () => {
  assertEquals(collapseHeadTags([]), "");
  assertEquals(collapseHeadTags([{ html: "<a>" }, { html: "<b>" }]), "<a><b>");
  assertEquals(
    collapseHeadTags([{ html: "<a>", dedup: "x" }, { html: "<b>" }, { html: "<c>", dedup: "x" }]),
    "<b><c>",
  );
});

Deno.test("renderPage: duplicate keyed/singleton head tags reach the document once", async () => {
  const modules: Record<string, unknown> = {
    "layout.tsx": {
      default: (p: { children: unknown }) =>
        h("div", null, [
          h("meta", { charSet: "utf-8" }),
          h("meta", { key: "desc", name: "description", content: "layout" }),
          h("meta", { name: "viewport", content: "width=device-width" }),
          p.children as VNodeChild,
        ]),
    },
    "page.tsx": {
      default: () =>
        h("main", null, [
          h("meta", { charSet: "utf-8" }),
          h("meta", { key: "desc", name: "description", content: "page" }),
          h("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
          h("meta", { property: "og:image", content: "/a.png" }),
          h("meta", { property: "og:image", content: "/b.png" }),
          h("h1", null, "hi"),
        ]),
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
  const { html, metadata } = await renderPage(
    match,
    new Request("http://x/x"),
    (fp) => Promise.resolve(modules[fp]),
  );
  const extra = metadata.head ?? "";
  assertEquals(count(extra.toLowerCase(), `charset="utf-8"`), 1);
  assertEquals(count(extra, `name="description"`), 1);
  assertStringIncludes(extra, `content="page"`);
  assert(!extra.includes(`content="layout"`), "the layout's keyed tag is replaced");
  assertEquals(count(extra, `name="viewport"`), 1);
  assertStringIncludes(extra, `initial-scale=1`);
  assertEquals(count(extra, `property="og:image"`), 2, "keyless distinct tags survive");
  assert(!html.includes("<meta"), "hoisted tags are gone from the body");
});

Deno.test("head dedup survives Children.map / cloneElement (the key lives on the element)", async () => {
  // `Children.map` hands back clones whose `key` is no longer in `props` — the dedup
  // identity must come from the element itself, or a page's override of a layout tag is lost.
  const Page = () =>
    h(
      "main",
      null,
      Children.map([h("meta", { key: "d", name: "description", content: "page" })], (c) => c),
    );
  const head: HeadCollector = { tags: [] };
  await renderShell(
    h("div", null, h("meta", { key: "d", name: "description", content: "layout" }), h(Page, null)),
    head,
  );
  const html = collapseHeadTags(head.tags);
  assertStringIncludes(html, 'content="page"');
  assert(!html.includes('content="layout"'), "the earlier duplicate is dropped");
});
