import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { scanRoutes } from "../src/router/manifest.ts";
import { matchApi, matchPage } from "../src/router/match.ts";

/** Build a throwaway app dir tree for scanning, return its path + a cleanup fn. */
async function buildAppTree(
  files: string[],
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_app_" });
  for (const rel of files) {
    const full = join(dir, rel);
    await Deno.mkdir(join(full, ".."), { recursive: true });
    await Deno.writeTextFile(full, "export default function () {}\n");
  }
  return { dir, cleanup: () => Deno.remove(dir, { recursive: true }) };
}

Deno.test("scans pages, layouts, and api routes into a manifest", async () => {
  const { dir, cleanup } = await buildAppTree([
    "layout.tsx",
    "page.tsx",
    "about/page.tsx",
    "blog/layout.tsx",
    "blog/[slug]/page.tsx",
    "docs/[...path]/page.tsx",
    "api/health/route.ts",
    "(marketing)/pricing/page.tsx",
  ]);
  try {
    const manifest = await scanRoutes(dir);

    // Pages: /, /about, /blog/[slug], /docs/[...path], /pricing
    const paths = manifest.pages.map((p) => p.routePath).sort();
    assertEquals(paths, [
      "/",
      "/about",
      "/blog/[slug]",
      "/docs/[...path]",
      "/pricing",
    ]);

    // Root layout applies to the home page.
    const home = manifest.pages.find((p) => p.routePath === "/");
    assertExists(home);
    assertEquals(home.layoutChain.length, 1);

    // Blog page inherits root + blog layouts (2 deep).
    const blog = manifest.pages.find((p) => p.routePath === "/blog/[slug]");
    assertExists(blog);
    assertEquals(blog.layoutChain.length, 2);

    // Route group "(marketing)" does not appear in the URL.
    assertExists(manifest.pages.find((p) => p.routePath === "/pricing"));

    // API route present.
    assertEquals(manifest.api.length, 1);
    assertEquals(manifest.api[0].routePath, "/api/health");
  } finally {
    await cleanup();
  }
});

Deno.test("matchPage resolves params and prefers static over dynamic", async () => {
  const { dir, cleanup } = await buildAppTree([
    "blog/[slug]/page.tsx",
    "blog/featured/page.tsx",
  ]);
  try {
    const manifest = await scanRoutes(dir);

    const dynamic = matchPage(manifest, "/blog/hello");
    assertExists(dynamic);
    assertEquals(dynamic.params, { slug: "hello" });

    // "/blog/featured" must hit the static route, not the dynamic one.
    const stat = matchPage(manifest, "/blog/featured");
    assertExists(stat);
    assertEquals(stat.route.routePath, "/blog/featured");
    assertEquals(stat.params, {});
  } finally {
    await cleanup();
  }
});

Deno.test("matchApi resolves an API route", async () => {
  const { dir, cleanup } = await buildAppTree(["api/users/[id]/route.ts"]);
  try {
    const manifest = await scanRoutes(dir);
    const m = matchApi(manifest, "/api/users/42");
    assertExists(m);
    assertEquals(m.params, { id: "42" });
  } finally {
    await cleanup();
  }
});
