import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { generateRouteEntry } from "../src/build/bundle.ts";
import { routeId } from "../src/build/paths.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { PageRoute } from "../src/router/manifest.ts";

Deno.test("routeId produces stable, filesystem-safe ids", () => {
  assertEquals(routeId("/"), "index");
  assertEquals(routeId("/about"), "about");
  assertEquals(routeId("/blog/[slug]"), "blog___slug_");
  assertEquals(routeId("/docs/[...path]"), "docs__catchall_path_");
});

Deno.test("generateRouteEntry imports page + layouts and hydrates", () => {
  const route: PageRoute = {
    kind: "page",
    pattern: parsePattern("blog/[slug]"),
    routePath: "/blog/[slug]",
    filePath: "/app/blog/[slug]/page.tsx",
    layoutChain: ["/app/layout.tsx", "/app/blog/layout.tsx"],
      loading: null,
      error: null,
      notFound: null,
  };
  const entry = generateRouteEntry(route);

  assertStringIncludes(entry, 'from "denext/client"');
  assertStringIncludes(entry, "startClient");
  assertStringIncludes(entry, "import Page from");
  assertStringIncludes(entry, "page.tsx");
  assertStringIncludes(entry, "import Layout0 from");
  assertStringIncludes(entry, "import Layout1 from");
  // Wraps innermost (Layout1) before outermost (Layout0).
  const l1 = entry.indexOf("h(Layout1,");
  const l0 = entry.indexOf("h(Layout0,");
  assertEquals(l1 < l0 && l1 !== -1, true);
  assertStringIncludes(entry, "startClient(el, tree)");
});

Deno.test("generateRouteEntry works with no layouts", () => {
  const route: PageRoute = {
    kind: "page",
    pattern: parsePattern("about"),
    routePath: "/about",
    filePath: "/app/about/page.tsx",
    layoutChain: [],
      loading: null,
      error: null,
      notFound: null,
  };
  const entry = generateRouteEntry(route);
  assertStringIncludes(entry, "import Page from");
  assertEquals(entry.includes("Layout0"), false);
  assertStringIncludes(entry, "h(Page,");
});
