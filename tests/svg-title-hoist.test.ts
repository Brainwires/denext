// An `<svg>`'s `<title>` is the drawing's accessible name, not the document's: React hoists
// nothing from inside an `<svg>`. A page with an inline icon that carries a `<title>` kept that
// title as the document title (found migrating Fresh's website, whose home page has one).

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import { type HeadCollector, renderToString } from "../src/jsx/render-to-string.ts";
import { renderToHtmlFlight } from "../src/jsx/render-to-html-flight.ts";
import { prerenderToShell } from "../src/jsx/render-to-ppr.ts";
import { createTestApp, createTestClient } from "../src/testing/mod.ts";

const page = () =>
  h(
    "div",
    null,
    h("title", null, "Page title"),
    h("svg", { viewBox: "0 0 1 1" }, h("title", null, "Arrow icon"), h("path", { d: "M0 0" })),
  );

const SVG = '<svg viewBox="0 0 1 1"><title>Arrow icon</title><path d="M0 0"></path></svg>';

Deno.test("renderToString keeps an svg <title> in place and hoists the page's", async () => {
  const head: HeadCollector = { tags: [] };
  const html = await renderToString(page(), { head });
  assertEquals(head.title, "Page title");
  assertStringIncludes(html, SVG);
});

Deno.test("renderToHtmlFlight and the PPR shell keep an svg <title> in place", async () => {
  const head: HeadCollector = { tags: [] };
  const { html } = await renderToHtmlFlight(page(), { head });
  assertEquals(head.title, "Page title");
  assertStringIncludes(html, SVG);
  const shellHead: HeadCollector = { tags: [] };
  const { shell } = await prerenderToShell(page(), { head: shellHead });
  assertEquals(shellHead.title, "Page title");
  assertStringIncludes(shell, SVG);
});

Deno.test("a page whose only <title> is an icon's keeps its own document title", async () => {
  const JSX = new URL("../src/jsx/jsx-runtime.ts", import.meta.url).href;
  const dir = await Deno.makeTempDir({ prefix: "denext_svg_title_" });
  try {
    await Deno.mkdir(join(dir, "app"));
    await Deno.writeTextFile(
      join(dir, "app/layout.ts"),
      `import { h } from "${JSX}";
export const metadata = { title: "Site" };
export default function Root({ children }) { return h("main", null, children); }`,
    );
    await Deno.writeTextFile(
      join(dir, "app/page.ts"),
      `import { h } from "${JSX}";
export default function Home() {
  return h("svg", null, h("title", null, "Arrow icon"), h("path", { d: "M0 0" }));
}`,
    );
    const res = await createTestClient(await createTestApp(dir)).get("/");
    assertStringIncludes(res.text, "<title>Site</title>");
    assertStringIncludes(res.text, "<svg><title>Arrow icon</title>");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
