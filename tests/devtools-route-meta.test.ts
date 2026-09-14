// DevTools metadata on the BUNDLED App Router dev path (`DENEXT_DEV_UNBUNDLED=0`).
//
// That path has no per-module transform, so the generated route entry carries the metadata
// itself: `routeDevMeta` (`dev-server/route-meta.ts`) renders a `__dnxMeta(…)` call per
// tracked declaration of each route-structural file, the default export keyed `#default` —
// the SAME id the entry's `registerFamily` uses — cached by mtime on the dev state. Asserted
// here: the ids and positions, anonymous defaults, the cache, the kill switch and size cap,
// the unbundled entry's byte-identity, a real `deno bundle` through the dev server, and the
// SPA follow-up (`.ts` hook modules are instrumented; the production plugin is unchanged).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type * as esbuild from "esbuild";
import { join, toFileUrl } from "@std/path";
import { generateRouteEntry } from "../src/build/bundle.ts";
import { routeDevMeta } from "../src/build/dev-server/route-meta.ts";
import { createDevState } from "../src/build/dev-server/state.ts";
import { getManifest } from "../src/build/dev-server/manifest.ts";
import { getRouteBundle } from "../src/build/dev-server/bundles.ts";
import { resolveProject } from "../src/build/paths.ts";
import type { ProjectPaths } from "../src/build/paths.ts";
import { spaRefreshPlugin } from "../src/build/spa-refresh-plugin.ts";
import { spaSourceTransformPlugin } from "../src/build/spa-compiler-plugin.ts";
import { type ParsedModule, parseModule } from "../src/build/swc-ast.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { PageRoute } from "../src/router/manifest.ts";
import { defaultLoader } from "../src/server/mod.ts";

const PAGE = `import { useState } from "denext";
export default function Page() {
  const [count, setCount] = useState(0);
  return <p onClick={() => setCount(count + 1)}>{count}</p>;
}
`;
const LAYOUT = `import { useRef } from "denext";
export default function RootLayout({ children }: { children: unknown }) {
  const shell = useRef(null);
  return <div ref={shell}>{children}</div>;
}
`;
const LOADING = `export default () => { const id = useId(); return <p id={id}>…</p>; };\n`;
const ERROR =
  `"use client";\nexport default function () { const [e] = useState(null); return e; }\n`;
const TEMPLATE = `export default function template({ children }: { children: unknown }) {
  return children;
}
`;

/** A route over real files in `dir`: page, layout, template, loading, error. */
interface Fixture {
  dir: string;
  route: PageRoute;
  url: (rel: string) => string;
}

async function fixture(): Promise<Fixture> {
  const dir = await Deno.makeTempDir({ prefix: "denext-route-meta-" });
  const files: Record<string, string> = {
    "page.tsx": PAGE,
    "layout.tsx": LAYOUT,
    "loading.tsx": LOADING,
    "error.tsx": ERROR,
    "template.tsx": TEMPLATE,
  };
  for (const [name, src] of Object.entries(files)) await Deno.writeTextFile(join(dir, name), src);
  const route: PageRoute = {
    kind: "page",
    pattern: parsePattern(""),
    routePath: "/",
    filePath: join(dir, "page.tsx"),
    layoutChain: [join(dir, "layout.tsx")],
    templateChain: [join(dir, "template.tsx")],
    loading: join(dir, "loading.tsx"),
    error: join(dir, "error.tsx"),
    notFound: null,
    forbidden: null,
    unauthorized: null,
  };
  return { dir, route, url: (rel) => toFileUrl(join(dir, rel)).href };
}

/** Run `fn` over a fresh fixture, removing it afterwards. */
async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await fixture();
  try {
    await fn(f);
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
}

/** A parser that counts its calls (the cache-hit probe). */
function countingParse(): {
  parse: (s: string) => Promise<ParsedModule | null>;
  calls: () => number;
} {
  let n = 0;
  return {
    parse: (s) => {
      n++;
      return parseModule(s);
    },
    calls: () => n,
  };
}

const freshCache = () => ({
  routeMetaCache: new Map<string, { mtimeMs: number; footer: string }>(),
});

/** The ids a source passes to `re`'s first capture group. */
const idsOf = (src: string, re: RegExp): string[] => [...src.matchAll(re)].map((m) => m[1]);

Deno.test("routeDevMeta: page AND layout carry `#default` metadata with line, column and hook names", async () => {
  await withFixture(async ({ route, url }) => {
    const footer = await routeDevMeta(freshCache(), route);
    assertStringIncludes(
      footer,
      `__dnxMeta("${url("page.tsx")}#default", {"name":"Page","line":2,"column":25,` +
        `"hooks":[{"hook":"useState","name":"count","line":3}]});`,
    );
    assertStringIncludes(
      footer,
      `__dnxMeta("${url("layout.tsx")}#default", {"name":"RootLayout","line":2,"column":25,` +
        `"hooks":[{"hook":"useRef","name":"shell","line":3}]});`,
    );
    // The named records ride along (a same-module breadcrumb joins on them) …
    assertStringIncludes(footer, `__dnxMeta("${url("page.tsx")}#Page",`);
    // … and every file's calls share ONE import.
    assertEquals(footer.match(/^import /gm)?.length, 1);
    assert(
      footer.startsWith(
        `import { registerComponentMeta as __dnxMeta } from "denext/client-runtime";\n`,
      ),
    );
  });
});

Deno.test("routeDevMeta: an anonymous or lowercase default export is keyed `#default`, named after the file", async () => {
  await withFixture(async ({ route, url }) => {
    const footer = await routeDevMeta(freshCache(), route);
    assertStringIncludes(
      footer,
      `__dnxMeta("${url("loading.tsx")}#default", {"name":"loading","line":1,"column":16,` +
        `"hooks":[{"hook":"useId","name":"id","line":1}]});`,
    );
    assertStringIncludes(
      footer,
      `__dnxMeta("${url("error.tsx")}#default", {"name":"error","line":2,"column":16,` +
        `"hooks":[{"hook":"useState","name":"e","line":2}]});`,
    );
    assertStringIncludes(
      footer,
      `__dnxMeta("${
        url("template.tsx")
      }#default", {"name":"template","line":1,"column":25,"hooks":[]});`,
    );
  });
});

Deno.test("bundled dev entry: every registerFamily id has a __dnxMeta record, emitted after the registrations", async () => {
  await withFixture(async ({ route }) => {
    const devMetaFooter = await routeDevMeta(freshCache(), route);
    const entry = generateRouteEntry(route, { dev: true, devMetaFooter });
    const families = idsOf(entry, /registerFamily\(\w+, "([^"]+)"\)/g);
    const metas = new Set(idsOf(entry, /__dnxMeta\("([^"]+)"/g));
    assertEquals(families.length, 5, "page, layout, template, loading, error");
    for (const id of families) assert(metas.has(id), `no metadata for family ${id}`);
    const lastFamily = entry.lastIndexOf("registerFamily(");
    assert(entry.indexOf("__dnxMeta(") > lastFamily, "the sidecar follows the registrations");
    assert(entry.indexOf("__dnxMeta(") < entry.indexOf("async function main"));
    assert(await parseModule(entry), "the entry (with its mid-module import) still parses");
  });
});

Deno.test("routeDevMeta: an mtime hit skips the re-parse; an edit (new mtime) refreshes that file only", async () => {
  await withFixture(async ({ route, dir }) => {
    const st = freshCache();
    const probe = countingParse();
    const first = await routeDevMeta(st, route, probe.parse);
    assertEquals(probe.calls(), 5);
    assertEquals(await routeDevMeta(st, route, probe.parse), first, "cache hit: same bytes");
    assertEquals(probe.calls(), 5, "cache hit: nothing re-parsed");

    const page = join(dir, "page.tsx");
    await Deno.writeTextFile(page, PAGE.replace("const [count", "const [total"));
    await Deno.utime(page, new Date(), new Date(Date.now() + 60_000)); // a distinct mtime
    const edited = await routeDevMeta(st, route, probe.parse);
    assertEquals(probe.calls(), 6, "only the edited file is re-parsed");
    assertStringIncludes(edited, `"name":"total"`);
    assert(!edited.includes(`"name":"count"`));
  });
});

Deno.test("routeDevMeta: DENEXT_DEV_META=0 emits no footer and parses nothing", async () => {
  await withFixture(async ({ route }) => {
    const probe = countingParse();
    Deno.env.set("DENEXT_DEV_META", "0");
    try {
      assertEquals(await routeDevMeta(freshCache(), route, probe.parse), "");
      assertEquals(probe.calls(), 0);
    } finally {
      Deno.env.delete("DENEXT_DEV_META");
    }
    const entry = generateRouteEntry(route, { dev: true, devMetaFooter: "" });
    assert(!entry.includes("__dnxMeta"), "an empty footer adds nothing to the entry");
  });
});

Deno.test("routeDevMeta: a file over the 16 KB cap contributes nothing; the others still do", async () => {
  await withFixture(async ({ route, url, dir }) => {
    const many = Array.from(
      { length: 400 },
      (_, i) =>
        `export function Component${i}() { const [value${i}] = useState(0); return value${i}; }`,
    ).join("\n");
    await Deno.writeTextFile(join(dir, "page.tsx"), `${many}\nexport default Component0;\n`);
    const footer = await routeDevMeta(freshCache(), route);
    assert(!footer.includes(url("page.tsx")), "the oversized page emits no metadata");
    assertStringIncludes(footer, `__dnxMeta("${url("layout.tsx")}#default",`);
  });
});

Deno.test("routeDevMeta: an unparseable or missing route file never fails the build", async () => {
  await withFixture(async ({ route, url, dir }) => {
    await Deno.writeTextFile(join(dir, "page.tsx"), `export default function ( { const = ; <<<`);
    await Deno.remove(join(dir, "loading.tsx"));
    const footer = await routeDevMeta(freshCache(), route);
    assert(!footer.includes(url("page.tsx")) && !footer.includes(url("loading.tsx")));
    assertStringIncludes(footer, `__dnxMeta("${url("layout.tsx")}#default",`);
  });
});

/** The pre-refactor unbundled (per-module) entry for `/about` — captured before D1. */
const UNBUNDLED_GOLDEN = [
  "// denext generated route entry — do not edit.",
  'import { startClient, provideLayoutSegments } from "denext/client-runtime";',
  'import { Suspense, ErrorBoundary } from "denext/client";',
  'import { h } from "denext/jsx-runtime";',
  'import { installClassSupport } from "denext/class-runtime";',
  'import { installActivitySupport } from "denext/client-runtime";',
  'import { installViewTransitionSupport } from "denext/client-runtime";',
  'import { enablePerModuleRefresh } from "denext/client-runtime";',
  'import { installDevtools } from "denext/devtools";',
  'import Page from "file:///app/about/page.tsx";',
  'import Layout0 from "file:///app/layout.tsx";',
  "enablePerModuleRefresh();",
  "installDevtools();",
  "installClassSupport();",
  "installActivitySupport();",
  "installViewTransitionSupport();",
  "",
  "async function main() {",
  '  const el = document.getElementById("__denext");',
  '  const dataEl = document.getElementById("__denext_data");',
  "  if (!el) return;",
  "  const data = dataEl",
  '    ? JSON.parse(dataEl.textContent || "{}")',
  '    : { params: {}, searchParams: "" };',
  '  const sp = new URLSearchParams(data.searchParams || "");',
  "  let tree = h(Page, { params: data.params, searchParams: sp });",
  "  tree = h(Layout0, { children: tree, params: data.params });",
  "  tree = provideLayoutSegments({ pathname: location.pathname, depth: 0 }, tree);",
  "",
  "  try {",
  "    startClient(el, tree);",
  "  } catch (err) {",
  "    if (window.__denextRefreshing) location.reload();",
  '    else console.warn("denext: skipping hydration for this route:", err && err.message);',
  "  }",
  "}",
  "",
  "main();",
  "",
].join("\n");

Deno.test("unbundled (per-module) entry is byte-identical to its pre-D1 output, footer or not", () => {
  const route: PageRoute = {
    kind: "page",
    pattern: parsePattern("about"),
    routePath: "/about",
    filePath: "/app/about/page.tsx",
    layoutChain: ["/app/layout.tsx"],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
    templateChain: [],
  };
  const opts = {
    dev: true,
    perModule: true,
    classRuntime: "eager" as const,
    usesActivity: true,
    usesViewTransition: true,
  };
  assertEquals(generateRouteEntry(route, opts), UNBUNDLED_GOLDEN);
  const withFooter = generateRouteEntry(route, { ...opts, devMetaFooter: `__dnxMeta("x", {});\n` });
  assertEquals(withFooter, UNBUNDLED_GOLDEN, "per-module footers own the metadata there");
});

Deno.test({
  name: "dev server bundled path: /_denext/route.js carries the page's `#default` metadata",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-route-meta-dev-" });
  const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: {
          "denext": abs("mod.ts"),
          "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
          "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
          "denext/server": abs("src/server/mod.ts"),
          "denext/client": abs("src/client/mod.ts"),
        },
      }),
    );
    await Deno.mkdir(join(dir, "app"), { recursive: true });
    await Deno.mkdir(join(dir, ".denext"), { recursive: true });
    await Deno.writeTextFile(join(dir, "app", "page.tsx"), PAGE);
    await Deno.writeTextFile(join(dir, "app", "layout.tsx"), LAYOUT);
    const st = createDevState({ paths: await resolveProject(dir), unbundled: false });
    st.load = defaultLoader;
    const route = (await getManifest(st)).pages.find((p) => p.routePath === "/");
    assert(route, "the fixture has a / page");
    const js = await getRouteBundle(st, route);
    const pageId = `${toFileUrl(join(dir, "app", "page.tsx")).href}#default`;
    assert(js.split(JSON.stringify(pageId)).length - 1 >= 2, "registered AND described");
    assert(/registerComponentMeta\w*\(/.test(js), "the registry call survives bundling");
    assert(/"?name"?:\s*"count"/.test(js), "the hook name reaches the bundle");
    assertEquals(st.routeMetaCache.size, 2, "page + layout cached by path");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Drive an esbuild plugin's single `onLoad`, keeping the filter it registered. */
function onLoadOf(plugin: esbuild.Plugin): {
  filter: RegExp;
  load: (args: { path: string }) => Promise<esbuild.OnLoadResult | null | undefined>;
} {
  let filter: RegExp | undefined;
  let load: ((args: { path: string }) => Promise<esbuild.OnLoadResult | null>) | undefined;
  plugin.setup(
    {
      onLoad: (opts: { filter: RegExp }, cb: typeof load) => {
        filter = opts.filter;
        load = cb;
      },
      onResolve: () => {},
    } as unknown as esbuild.PluginBuild,
  );
  assert(filter && load, "the plugin registered no onLoad");
  return { filter, load };
}

Deno.test("SPA dev: a `.ts` custom-hook module is instrumented (ts loader) with its metadata", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-spa-ts-meta-" });
  try {
    const hooks = join(dir, "useCart.ts");
    await Deno.writeTextFile(
      hooks,
      `import { useState } from "denext";\nexport function useCart() {\n  const [items, setItems] = useState<string[]>([]);\n  return { items, setItems };\n}\n`,
    );
    const { filter, load } = onLoadOf(spaRefreshPlugin(dir));
    assert(filter.test(hooks) && filter.test("a.tsx") && filter.test("a.jsx"));
    const out = await load({ path: hooks });
    assertEquals(out?.loader, "ts", "a .ts module keeps the ts loader (no JSX parse)");
    assertStringIncludes(
      String(out?.contents),
      `__dnxMeta("${toFileUrl(hooks).href}#useCart", {"name":"useCart","line":2,"column":17,` +
        `"hooks":[{"hook":"useState","name":"items","line":3}]});`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("production SPA source-transform plugin keeps its .tsx/.jsx-only filter", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-spa-prod-filter-" });
  try {
    const plugin = spaSourceTransformPlugin(
      dir,
      { experimental: { features: { SOMETHING: true } } } as ProjectPaths["config"],
    );
    assert(plugin, "the feature fold is enabled for this fixture config");
    const { filter, load } = onLoadOf(plugin);
    assertEquals(filter.source, String.raw`\.(tsx|jsx)$`);
    assert(!filter.test("useCart.ts"), "a .ts module is never claimed by the production plugin");
    const file = join(dir, "App.tsx");
    await Deno.writeTextFile(file, `export function App() { return <p />; }\n`);
    assertEquals((await load({ path: file }))?.loader, "tsx");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
