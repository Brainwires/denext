import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { scanRoutes } from "../src/router/manifest.ts";

/**
 * Golden snapshot of the scanned manifest for a fixture covering every built-in
 * file convention. This locks scanner output so the convention-registry refactor
 * (and any future convention change) provably preserves behavior.
 */
const FIXTURE = [
  "layout.tsx",
  "template.tsx",
  "page.tsx",
  "loading.tsx",
  "error.tsx",
  "not-found.tsx",
  "global-error.tsx",
  "forbidden.tsx",
  "unauthorized.tsx",
  "about/page.tsx",
  "dashboard/layout.tsx",
  "dashboard/loading.tsx",
  "dashboard/page.tsx",
  "dashboard/settings/page.tsx",
  "blog/layout.tsx",
  "blog/template.tsx",
  "blog/[slug]/page.tsx",
  "docs/[...path]/page.tsx",
  "shop/[[...filters]]/page.tsx",
  "(marketing)/pricing/page.tsx",
  "api/health/route.ts",
  "api/users/[id]/route.ts",
];

const EXPECTED = {
  pages: [
    {
      routePath: "/dashboard/settings",
      filePath: "dashboard/settings/page.tsx",
      layoutChain: ["layout.tsx", "dashboard/layout.tsx"],
      templateChain: ["template.tsx"],
      loading: "dashboard/loading.tsx",
      error: "error.tsx",
      notFound: "not-found.tsx",
      forbidden: "forbidden.tsx",
      unauthorized: "unauthorized.tsx",
    },
    {
      routePath: "/blog/[slug]",
      filePath: "blog/[slug]/page.tsx",
      layoutChain: ["layout.tsx", "blog/layout.tsx"],
      templateChain: ["template.tsx", "blog/template.tsx"],
      loading: "loading.tsx",
      error: "error.tsx",
      notFound: "not-found.tsx",
      forbidden: "forbidden.tsx",
      unauthorized: "unauthorized.tsx",
    },
    {
      routePath: "/docs/[...path]",
      filePath: "docs/[...path]/page.tsx",
      layoutChain: ["layout.tsx"],
      templateChain: ["template.tsx"],
      loading: "loading.tsx",
      error: "error.tsx",
      notFound: "not-found.tsx",
      forbidden: "forbidden.tsx",
      unauthorized: "unauthorized.tsx",
    },
    {
      routePath: "/shop/[[...filters]]",
      filePath: "shop/[[...filters]]/page.tsx",
      layoutChain: ["layout.tsx"],
      templateChain: ["template.tsx"],
      loading: "loading.tsx",
      error: "error.tsx",
      notFound: "not-found.tsx",
      forbidden: "forbidden.tsx",
      unauthorized: "unauthorized.tsx",
    },
    {
      routePath: "/about",
      filePath: "about/page.tsx",
      layoutChain: ["layout.tsx"],
      templateChain: ["template.tsx"],
      loading: "loading.tsx",
      error: "error.tsx",
      notFound: "not-found.tsx",
      forbidden: "forbidden.tsx",
      unauthorized: "unauthorized.tsx",
    },
    {
      routePath: "/pricing",
      filePath: "(marketing)/pricing/page.tsx",
      layoutChain: ["layout.tsx"],
      templateChain: ["template.tsx"],
      loading: "loading.tsx",
      error: "error.tsx",
      notFound: "not-found.tsx",
      forbidden: "forbidden.tsx",
      unauthorized: "unauthorized.tsx",
    },
    {
      routePath: "/dashboard",
      filePath: "dashboard/page.tsx",
      layoutChain: ["layout.tsx", "dashboard/layout.tsx"],
      templateChain: ["template.tsx"],
      loading: "dashboard/loading.tsx",
      error: "error.tsx",
      notFound: "not-found.tsx",
      forbidden: "forbidden.tsx",
      unauthorized: "unauthorized.tsx",
    },
    {
      routePath: "/",
      filePath: "page.tsx",
      layoutChain: ["layout.tsx"],
      templateChain: ["template.tsx"],
      loading: "loading.tsx",
      error: "error.tsx",
      notFound: "not-found.tsx",
      forbidden: "forbidden.tsx",
      unauthorized: "unauthorized.tsx",
    },
  ],
  api: [
    { routePath: "/api/users/[id]", filePath: "api/users/[id]/route.ts" },
    { routePath: "/api/health", filePath: "api/health/route.ts" },
  ],
  rootLayout: "layout.tsx",
  rootNotFound: "not-found.tsx",
  rootGlobalError: "global-error.tsx",
};

Deno.test("scanRoutes golden manifest (all conventions)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_golden_" });
  try {
    for (const rel of FIXTURE) {
      const full = join(dir, rel);
      await Deno.mkdir(join(full, ".."), { recursive: true });
      await Deno.writeTextFile(full, "export default function () {}\n");
    }
    const m = await scanRoutes(dir);
    const rel = (p: string | null) => (p == null ? null : p.slice(dir.length + 1));
    const relArr = (a: string[]) => a.map((p) => rel(p)!);

    // Compare order-independently by routePath: relative order among
    // equal-specificity routes depends on the platform's directory-read order,
    // which is not a routing guarantee (non-overlapping paths).
    const byPath = <T extends { routePath: string }>(xs: T[]) =>
      [...xs].sort((a, b) => a.routePath.localeCompare(b.routePath));

    const norm = {
      pages: byPath(m.pages.map((p) => ({
        routePath: p.routePath,
        filePath: rel(p.filePath),
        layoutChain: relArr(p.layoutChain),
        templateChain: relArr(p.templateChain),
        loading: rel(p.loading),
        error: rel(p.error),
        notFound: rel(p.notFound),
        forbidden: rel(p.forbidden),
        unauthorized: rel(p.unauthorized),
      }))),
      api: byPath(m.api.map((a) => ({ routePath: a.routePath, filePath: rel(a.filePath) }))),
      rootLayout: rel(m.rootLayout),
      rootNotFound: rel(m.rootNotFound),
      rootGlobalError: rel(m.rootGlobalError),
    };

    assertEquals(norm, {
      ...EXPECTED,
      pages: byPath(EXPECTED.pages),
      api: byPath(EXPECTED.api),
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
