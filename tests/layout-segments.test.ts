import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { scanRoutes } from "../src/router/manifest.ts";
import { matchPage } from "../src/router/match.ts";
import { renderPage } from "../src/server/render-page.ts";
import { defaultLoader } from "../src/server/mod.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, setDocument } from "../src/client/reconciler.ts";
import { useSelectedLayoutSegment, useSelectedLayoutSegments } from "../src/client/navigation.ts";
import { provideLayoutSegments } from "../src/runtime/layout-segments.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";

function url(rel: string): string {
  return new URL(rel, import.meta.url).href;
}

// A layout that renders its layout-relative segments into a labelled marker.
function layout(id: string): string {
  return `import { h } from "${url("../src/jsx/jsx-runtime.ts")}";\n` +
    `import { useSelectedLayoutSegments } from "${url("../src/client/navigation.ts")}";\n` +
    `export default function L(p){\n` +
    `  const segs = useSelectedLayoutSegments();\n` +
    `  return h('div', null, [h('span', { id: ${
      JSON.stringify(id)
    } }, segs.join(',')), p.children]);\n` +
    `}\n`;
}

async function app(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_seg_" });
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    await Deno.mkdir(join(full, ".."), { recursive: true });
    await Deno.writeTextFile(full, contents);
  }
  return dir;
}

Deno.test("layoutDepths records each layout's URL segment depth", async () => {
  const dir = await app({
    "layout.tsx": layout("root"),
    "a/layout.tsx": layout("a"),
    "a/b/layout.tsx": layout("ab"),
    "a/b/[c]/page.tsx": `import { h } from "${url("../src/jsx/jsx-runtime.ts")}";\n` +
      "export default function(){ return h('main', null, 'PAGE'); }\n",
  });
  try {
    const m = await scanRoutes(dir);
    const route = m.pages.find((p) => p.routePath === "/a/b/[c]")!;
    // Root at depth 0, /a layout at depth 1, /a/b layout at depth 2.
    assertEquals(route.layoutDepths, [0, 1, 2]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("useSelectedLayoutSegments is layout-relative during SSR", async () => {
  const dir = await app({
    "layout.tsx": layout("root"),
    "a/layout.tsx": layout("a"),
    "a/b/layout.tsx": layout("ab"),
    "a/b/[c]/page.tsx": `import { h } from "${url("../src/jsx/jsx-runtime.ts")}";\n` +
      "export default function(){ return h('main', null, 'PAGE'); }\n",
  });
  try {
    const m = await scanRoutes(dir);
    const match = matchPage(m, "/a/b/c")!;
    const { html } = await renderPage(match, new Request("http://x/a/b/c"), defaultLoader);

    // Each layout sees only the segments below its own level.
    assertStringIncludes(html, `<span id="root">a,b,c</span>`);
    assertStringIncludes(html, `<span id="a">b,c</span>`);
    assertStringIncludes(html, `<span id="ab">c</span>`);
    assertStringIncludes(html, "PAGE");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("route groups do not add to layout segment depth", async () => {
  const dir = await app({
    "layout.tsx": layout("root"),
    "(marketing)/layout.tsx": layout("mkt"),
    "(marketing)/pricing/page.tsx": `import { h } from "${url("../src/jsx/jsx-runtime.ts")}";\n` +
      "export default function(){ return h('main', null, 'PRICING'); }\n",
  });
  try {
    const m = await scanRoutes(dir);
    const route = m.pages.find((p) => p.routePath === "/pricing")!;
    // The route-group layout consumes no URL segment: still depth 0.
    assertEquals(route.layoutDepths, [0, 0]);

    const match = matchPage(m, "/pricing")!;
    const { html } = await renderPage(match, new Request("http://x/pricing"), defaultLoader);
    // Both root and marketing layouts see the full path (nothing consumed above).
    assertStringIncludes(html, `<span id="root">pricing</span>`);
    assertStringIncludes(html, `<span id="mkt">pricing</span>`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

Deno.test("useSelectedLayoutSegment(s) slice from the provider depth on the client", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  function Probe(): VNode {
    const segs = useSelectedLayoutSegments();
    const first = useSelectedLayoutSegment();
    return h("i", null, `${segs.join(",")}|${first ?? "null"}`);
  }

  const root = createRoot(asEl(container));
  // A layout at depth 1 over pathname /a/b/c should see ["b","c"].
  root.render(provideLayoutSegments({ pathname: "/a/b/c", depth: 1 }, h(Probe, null)));
  assertEquals(container.innerHTML, "<i>b,c|b</i>");
  root.unmount();
});

Deno.test("no provider means app-root-relative segments on the client", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  function Probe(): VNode {
    return h("i", null, useSelectedLayoutSegments().join(","));
  }

  const root = createRoot(asEl(container));
  // The default context is { pathname: "/", depth: 0 } → no segments.
  root.render(h(Probe, null));
  assertEquals(container.innerHTML, "<i></i>");
  root.unmount();
});
