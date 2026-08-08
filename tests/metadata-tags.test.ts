import { assertStringIncludes } from "@std/assert";
import { assert } from "@std/assert";
import { renderDocument } from "../src/server/document.ts";
import { mergeMetadata, mergeViewport } from "../src/server/render-page.ts";
import type { Metadata } from "../src/server/types.ts";

function head(
  metadata: Metadata,
  viewport?: Parameters<typeof renderDocument>[0]["viewport"],
): string {
  const doc = renderDocument({ bodyHtml: "", metadata, viewport });
  return doc.slice(doc.indexOf("<head>"), doc.indexOf("</head>"));
}

Deno.test("twitter card tags are emitted", () => {
  const h = head({
    twitter: { card: "summary_large_image", site: "@denext", title: "Hi", image: "/t.png" },
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

Deno.test("robots object serializes to a directive string + googlebot", () => {
  const h = head({ robots: { index: false, follow: true, noarchive: true, googleBot: "noindex" } });
  assertStringIncludes(h, `<meta name="robots" content="noindex, follow, noarchive">`);
  assertStringIncludes(h, `<meta name="googlebot" content="noindex">`);
});

Deno.test("metadataBase resolves relative og/twitter images to absolute", () => {
  const h = head({
    metadataBase: "https://example.com",
    openGraph: { image: "/og.png" },
    twitter: { image: "/tw.png" },
  });
  assertStringIncludes(h, `content="https://example.com/og.png"`);
  assertStringIncludes(h, `content="https://example.com/tw.png"`);
});

Deno.test("og:image descriptor emits width/height/alt", () => {
  const h = head({
    openGraph: { image: { url: "/o.png", width: 1200, height: 630, alt: "cover" } },
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
