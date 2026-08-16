import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { bundleRoute, generateRouteEntry } from "../src/build/bundle.ts";
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
    forbidden: null,
    unauthorized: null,
    templateChain: [],
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
    forbidden: null,
    unauthorized: null,
    templateChain: [],
  };
  const entry = generateRouteEntry(route);
  assertStringIncludes(entry, "import Page from");
  assertEquals(entry.includes("Layout0"), false);
  assertStringIncludes(entry, "h(Page,");
});

Deno.test("dev bundles carry an inline source map; production bundles do not", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_srcmap_" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: {
          "denext": new URL("../mod.ts", import.meta.url).href,
          "denext/jsx-runtime": new URL("../src/jsx/jsx-runtime.ts", import.meta.url).href,
          "denext/client": new URL("../src/client/mod.ts", import.meta.url).href,
        },
      }),
    );
    const pagePath = join(dir, "page.tsx");
    await Deno.writeTextFile(
      pagePath,
      `export default function Page() { return <div>SRCMAP_MARKER</div>; }\n`,
    );
    const route: PageRoute = {
      kind: "page",
      pattern: parsePattern(""),
      routePath: "/",
      filePath: pagePath,
      layoutChain: [],
      templateChain: [],
      loading: null,
      error: null,
      notFound: null,
      unauthorized: null,
      forbidden: null,
    };
    const configPath = join(dir, "deno.json");

    // Dev build → inline source map embedded in the entry.
    const dev = await bundleRoute(route, { configPath, dev: true });
    assertStringIncludes(
      dev.files.get(dev.entry)!,
      "sourceMappingURL=data:application/json",
      "a dev bundle must embed an inline source map",
    );

    // Production build (minified, no dev flag) → no source map.
    const prod = await bundleRoute(route, { configPath, minify: true });
    assert(
      !prod.files.get(prod.entry)!.includes("sourceMappingURL="),
      "a production bundle must not carry a source map",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
