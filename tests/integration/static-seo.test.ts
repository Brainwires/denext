import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { renderDocument } from "../../src/server/document.ts";
import { mergeMetadata } from "../../src/server/render-page.ts";
import { createApp } from "../../src/server/app.ts";
import { parsePattern } from "../../src/router/segments.ts";
import { staticExport } from "../../src/build/export.ts";
import { h } from "../../src/jsx/jsx-runtime.ts";
import type { RouteManifest } from "../../src/router/manifest.ts";
import type { Metadata, PageProps } from "../../src/server/types.ts";

Deno.test("document renders expanded metadata (keywords/robots/canonical/og/icon)", () => {
  const meta: Metadata = {
    title: "T",
    keywords: ["deno", "ssr"],
    robots: "noindex",
    canonical: "https://x.dev/p",
    icon: "/favicon.svg",
    openGraph: { title: "OG", images: "https://x.dev/og.png", type: "website" },
  };
  const doc = renderDocument({ bodyHtml: "<p>hi</p>", metadata: meta });
  assertStringIncludes(doc, '<meta name="keywords" content="deno, ssr">');
  assertStringIncludes(doc, '<meta name="robots" content="noindex">');
  assertStringIncludes(doc, '<link rel="canonical" href="https://x.dev/p">');
  assertStringIncludes(doc, '<link rel="icon" href="/favicon.svg">');
  assertStringIncludes(doc, '<meta property="og:title" content="OG">');
  assertStringIncludes(doc, '<meta property="og:image" content="https://x.dev/og.png">');
});

Deno.test("mergeMetadata deep-merges openGraph and overrides scalars", () => {
  const merged = mergeMetadata([
    { title: "A", openGraph: { siteName: "site", title: "a" } },
    { title: "B", openGraph: { title: "b" } },
  ]);
  assertEquals(merged.title, "B");
  assertEquals(merged.openGraph?.title, "b");
  assertEquals(merged.openGraph?.siteName, "site");
});

Deno.test("generateMetadata is used to produce page metadata", async () => {
  const manifest: RouteManifest = {
    pages: [{
      kind: "page",
      pattern: parsePattern("p"),
      routePath: "/p",
      filePath: "p.tsx",
      layoutChain: [],
      templateChain: [],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
    }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
  const app = createApp({
    getManifest: () => manifest,
    load: () =>
      Promise.resolve({
        default: (_p: PageProps) => h("h1", null, "P"),
        generateMetadata: (p: PageProps) => ({
          title: `gen:${p.searchParams.q ?? ""}`,
        }),
      }),
  });
  const res = await app(new Request("http://localhost/p?q=hi"));
  assertStringIncludes(await res.text(), "<title>gen:hi</title>");
});

Deno.test("staticExport renders static + dynamic (generateStaticParams) pages", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_export_" });
  try {
    // Minimal standalone denext app that maps `denext` to this repo.
    const root = new URL("../../", import.meta.url).pathname; // tests/integration/ -> repo root
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: {
          "denext": `${root}mod.ts`,
          "denext/jsx-runtime": `${root}src/jsx/jsx-runtime.ts`,
          "denext/server": `${root}src/server/mod.ts`,
          "denext/client": `${root}src/client/mod.ts`,
        },
      }),
    );
    await Deno.mkdir(join(dir, "app", "post", "[id]"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "app", "page.tsx"),
      `export default function Home(){ return <h1>Home</h1>; }\n`,
    );
    await Deno.writeTextFile(
      join(dir, "app", "post", "[id]", "page.tsx"),
      `export default function Post({ params }){ return <h1>Post {params.id}</h1>; }\n` +
        `export function generateStaticParams(){ return [{ id: "1" }, { id: "2" }]; }\n`,
    );

    const result = await staticExport(dir);
    assertEquals(result.pages, 3); // home + post/1 + post/2
    assertEquals(result.skipped.length, 0);

    const home = await Deno.readTextFile(join(result.outDir, "index.html"));
    assertStringIncludes(home, "<h1>Home</h1>");
    const post1 = await Deno.readTextFile(join(result.outDir, "post", "1", "index.html"));
    assertStringIncludes(post1, "<h1>Post 1</h1>");
    const post2 = await Deno.readTextFile(join(result.outDir, "post", "2", "index.html"));
    assertStringIncludes(post2, "<h1>Post 2</h1>");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
