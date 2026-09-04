// Unit tests for the Pages Router client-hydration machinery: entry-source
// generation, the route-id slug, the soft-navigation data endpoint, client
// bundle serving (including the prod read-from-disk path), and basePath. These
// avoid the real `deno bundle` shell-out — the full pipeline is exercised by the
// browser e2e (tests/e2e/pages-router.e2e.test.ts).

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import { parsePattern } from "../src/router/segments.ts";
import { createPagesHandler } from "../packages/pages-router/src/handler.ts";
import type { PagesScan } from "../packages/pages-router/src/scan.ts";
import { generateClientEntry, routeId } from "../packages/pages-router/src/client-entry.ts";
import {
  type ClientBundler,
  createClientBundler,
  PAGES_PREFIX,
} from "../packages/pages-router/src/client-bundle.ts";
import { prerenderStaticPages } from "../packages/pages-router/src/ssg.ts";

const EMPTY_SPECIALS = {
  app: null,
  document: null,
  error: null,
  notFound: null,
  serverError: null,
};

function pageEntry(routePath: string, pattern: string, filePath: string) {
  return { routePath, filePath, isApi: false, pattern: parsePattern(pattern) };
}

// --- routeId ----------------------------------------------------------------

Deno.test("routeId slugifies route paths deterministically", () => {
  assertEquals(routeId("/"), "index");
  assertEquals(routeId("/about"), "about");
  assertEquals(routeId("/blog/[slug]"), "blog___slug_");
  assertEquals(routeId("/docs/[...path]"), "docs__catchall_path");
  assertEquals(routeId("/shop/[[...opt]]"), "shop__optcatchall_opt");
});

// --- generateClientEntry ----------------------------------------------------

Deno.test("generateClientEntry emits a hydration entry importing the page default", () => {
  const src = generateClientEntry({
    routePath: "/blog/[slug]",
    pageFile: "/abs/pages/blog/[slug].tsx",
    appFile: "/abs/pages/_app.tsx",
  });
  assertStringIncludes(
    src,
    'import { bootstrapPages, registerPage } from "@denext/pages-router/client-runtime"',
  );
  assertStringIncludes(src, "import Page from ");
  assertStringIncludes(src, "blog/[slug].tsx");
  assertStringIncludes(src, "import App from ");
  assertStringIncludes(src, '_app.tsx"');
  assertStringIncludes(src, 'registerPage("/blog/[slug]", Page)');
  assertStringIncludes(src, "bootstrapPages({ App })");
});

Deno.test("generateClientEntry uses a null _app when the project has none", () => {
  const src = generateClientEntry({ routePath: "/", pageFile: "/abs/pages/index.tsx" });
  assertStringIncludes(src, "const App = null;");
  assert(!src.includes("import App from"), "must not import a missing _app");
});

Deno.test("generateClientEntry emits the Fast Refresh runtime in dev, omits it in prod", () => {
  const dev = generateClientEntry({
    routePath: "/",
    pageFile: "/abs/pages/index.tsx",
    appFile: "/abs/pages/_app.tsx",
    dev: true,
  });
  assertStringIncludes(
    dev,
    'import { enableFastRefresh, registerFamily } from "@denext/denext/client-runtime"',
  );
  assertStringIncludes(dev, "registerFamily(Page,");
  assertStringIncludes(dev, "registerFamily(App,");
  assertStringIncludes(dev, "enableFastRefresh();");

  const prod = generateClientEntry({ routePath: "/", pageFile: "/abs/pages/index.tsx" });
  assert(!prod.includes("enableFastRefresh"), "prod entry must not carry the refresh runtime");
  assert(!prod.includes("registerFamily"), "prod entry must not register families");
});

// --- data endpoint + script injection (fake bundler) ------------------------

const fakeBundler: ClientBundler = {
  urlFor: (routePath) =>
    Promise.resolve(routePath === "/" ? `${PAGES_PREFIX}index.js` : `${PAGES_PREFIX}blog.js`),
  cssUrlFor: () => Promise.resolve(null),
  serve: (pathname) =>
    Promise.resolve(
      pathname === `${PAGES_PREFIX}index.js`
        ? new Response("//code", { headers: { "content-type": "text/javascript" } })
        : null,
    ),
  prebuild: () => Promise.resolve({ entryByRoute: new Map(), cssByRoute: new Map() }),
};

Deno.test("HTML render injects the hydration <script> when a bundler is present", async () => {
  const scan: PagesScan = { ...EMPTY_SPECIALS, pages: [pageEntry("/", "", "home.tsx")], api: [] };
  const handle = createPagesHandler({
    getScan: () => scan,
    load: () => Promise.resolve({ default: () => h("h1", null, "Home") }),
    bundler: fakeBundler,
  });
  const body = await (await handle(new Request("http://localhost/")))!.text();
  assertStringIncludes(body, `<script type="module" src="${PAGES_PREFIX}index.js"></script>`);
  assertStringIncludes(body, 'id="__NEXT_DATA__"');
});

Deno.test("data request (x-denext-pages-data) returns JSON props + entryUrl, not HTML", async () => {
  const scan: PagesScan = {
    ...EMPTY_SPECIALS,
    pages: [pageEntry("/blog/[slug]", "blog/[slug]", "blog.tsx")],
    api: [],
  };
  const handle = createPagesHandler({
    getScan: () => scan,
    load: () =>
      Promise.resolve({
        getServerSideProps: (ctx: { params: { slug: string } }) =>
          Promise.resolve({ props: { title: `Post ${ctx.params.slug}` } }),
        default: () => h("article", null, "x"),
      }),
    bundler: fakeBundler,
  });
  const res = await handle(
    new Request("http://localhost/blog/hello?ref=1", { headers: { "x-denext-pages-data": "1" } }),
  );
  assertEquals(res!.headers.get("content-type"), "application/json");
  const json = await res!.json();
  assertEquals(json.page, "/blog/[slug]");
  assertEquals(json.entryUrl, `${PAGES_PREFIX}blog.js`);
  assertEquals(json.pageProps, { title: "Post hello" });
  assertEquals(json.query, { slug: "hello", ref: "1" });
  assertEquals(json.isServer, true);
});

Deno.test("data response includes cssUrl so soft nav can inject the route stylesheet", async () => {
  const bundler: ClientBundler = {
    urlFor: () => Promise.resolve(`${PAGES_PREFIX}p.js`),
    cssUrlFor: () => Promise.resolve(`${PAGES_PREFIX}p.css`),
    serve: () => Promise.resolve(null),
    prebuild: () => Promise.resolve({ entryByRoute: new Map(), cssByRoute: new Map() }),
  };
  const scan: PagesScan = { ...EMPTY_SPECIALS, pages: [pageEntry("/", "", "p.tsx")], api: [] };
  const handle = createPagesHandler({
    getScan: () => scan,
    load: () => Promise.resolve({ default: () => h("div", null, "x") }),
    bundler,
  });
  const json = await (await handle(
    new Request("http://localhost/", { headers: { "x-denext-pages-data": "1" } }),
  ))!.json();
  assertEquals(json.entryUrl, `${PAGES_PREFIX}p.js`);
  assertEquals(json.cssUrl, `${PAGES_PREFIX}p.css`);
});

Deno.test("data request surfaces redirect / notFound as JSON (for client-side handling)", async () => {
  const scan: PagesScan = { ...EMPTY_SPECIALS, pages: [pageEntry("/", "", "r.tsx")], api: [] };
  const redirectHandle = createPagesHandler({
    getScan: () => scan,
    load: () =>
      Promise.resolve({
        getServerSideProps: () =>
          Promise.resolve({ redirect: { destination: "/login", permanent: false } }),
        default: () => h("div", null, "never"),
      }),
    bundler: fakeBundler,
  });
  const res = await redirectHandle(
    new Request("http://localhost/", { headers: { "x-denext-pages-data": "1" } }),
  );
  assertEquals(await res!.json(), { redirect: { destination: "/login" } });
});

Deno.test("bundler serves /_denext/pages/*.js via the claim-hook", async () => {
  const scan: PagesScan = { ...EMPTY_SPECIALS, pages: [pageEntry("/", "", "home.tsx")], api: [] };
  const handle = createPagesHandler({
    getScan: () => scan,
    load: () => Promise.resolve({ default: () => h("div", null, "x") }),
    bundler: fakeBundler,
  });
  const ok = await handle(new Request(`http://localhost${PAGES_PREFIX}index.js`));
  assertEquals(ok!.status, 200);
  assertEquals(await ok!.text(), "//code");
  // A bundle path the bundler doesn't recognize falls through (null → core 404).
  const miss = await handle(new Request(`http://localhost${PAGES_PREFIX}missing.js`));
  assertEquals(miss, null);
});

// --- basePath ---------------------------------------------------------------

Deno.test("basePath is stripped for matching and prepended to the hydration script", async () => {
  const scan: PagesScan = { ...EMPTY_SPECIALS, pages: [pageEntry("/", "", "home.tsx")], api: [] };
  const handle = createPagesHandler({
    getScan: () => scan,
    load: () => Promise.resolve({ default: () => h("h1", null, "Home") }),
    bundler: fakeBundler,
    basePath: "/app",
  });
  const body = await (await handle(new Request("http://localhost/app/")))!.text();
  assertStringIncludes(body, `src="/app${PAGES_PREFIX}index.js"`);
  assertStringIncludes(body, '"basePath":"/app"');
});

// --- SSG (prerender + serve) ------------------------------------------------

Deno.test("prerenderStaticPages writes index.html + props.json per static path", async () => {
  const outDir = await Deno.makeTempDir({ prefix: "denext_ssg_" });
  try {
    const scan: PagesScan = {
      ...EMPTY_SPECIALS,
      pages: [pageEntry("/ssg/[id]", "ssg/[id]", "s.tsx")],
      api: [],
    };
    const modules: Record<string, unknown> = {
      "s.tsx": {
        getStaticPaths: () =>
          Promise.resolve({ paths: [{ params: { id: "a" } }], fallback: false }),
        getStaticProps: (ctx: { params: { id: string } }) =>
          Promise.resolve({ props: { id: ctx.params.id }, revalidate: 30 }),
        default: (p: { id?: string }) => h("h1", null, `id ${p.id}`),
      },
    };
    const { prerendered } = await prerenderStaticPages({
      scan,
      load: (f) => Promise.resolve(modules[f]),
      outDir,
      bundleUrlFor: () => `${PAGES_PREFIX}e.js`,
      cssUrlFor: () => null,
    });
    assertEquals(prerendered, ["/ssg/a"]);
    const htmlOut = await Deno.readTextFile(join(outDir, "pages-static", "ssg", "a", "index.html"));
    assertStringIncludes(htmlOut, "<h1>id a</h1>");
    assertStringIncludes(htmlOut, `src="${PAGES_PREFIX}e.js"`);
    const props = JSON.parse(
      await Deno.readTextFile(join(outDir, "pages-static", "ssg", "a", "props.json")),
    );
    assertEquals(props.pageProps, { id: "a" });
    assertEquals(props.revalidate, 30);
    assertEquals(props.entryUrl, `${PAGES_PREFIX}e.js`);
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test("prerenderStaticPages threads the default locale into getStaticProps + __NEXT_DATA__", async () => {
  const outDir = await Deno.makeTempDir({ prefix: "denext_ssg_i18n_" });
  try {
    const scan: PagesScan = {
      ...EMPTY_SPECIALS,
      pages: [pageEntry("/about", "about", "a.tsx")],
      api: [],
    };
    const modules: Record<string, unknown> = {
      "a.tsx": {
        // context.locale must be the real default locale, not `undefined`.
        getStaticProps: (ctx: { locale?: string }) =>
          Promise.resolve({ props: { loc: ctx.locale ?? "MISSING" } }),
        default: (p: { loc?: string }) => h("h1", null, `loc ${p.loc}`),
      },
    };
    await prerenderStaticPages({
      scan,
      load: (f) => Promise.resolve(modules[f]),
      outDir,
      bundleUrlFor: () => `${PAGES_PREFIX}e.js`,
      cssUrlFor: () => null,
      i18n: { locales: ["en", "fr"], defaultLocale: "en" },
    });
    const htmlOut = await Deno.readTextFile(join(outDir, "pages-static", "about", "index.html"));
    assertStringIncludes(htmlOut, "<h1>loc en</h1>"); // ctx.locale === "en", not undefined
    const props = JSON.parse(
      await Deno.readTextFile(join(outDir, "pages-static", "about", "props.json")),
    );
    assertEquals(props.locale, "en");
    assertEquals(props.locales, ["en", "fr"]);
    assertEquals(props.defaultLocale, "en");
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test("prerenderStaticPages handles catch-all array params → a nested path", async () => {
  const outDir = await Deno.makeTempDir({ prefix: "denext_ssg_cat_" });
  try {
    const scan: PagesScan = {
      ...EMPTY_SPECIALS,
      pages: [pageEntry("/blog/[...slug]", "blog/[...slug]", "c.tsx")],
      api: [],
    };
    const modules: Record<string, unknown> = {
      "c.tsx": {
        // Next.js convention: a catch-all path is an array of segments.
        getStaticPaths: () =>
          Promise.resolve({ paths: [{ params: { slug: ["a", "b"] } }], fallback: false }),
        getStaticProps: (ctx: { params: { slug: string[] } }) =>
          Promise.resolve({ props: { slug: ctx.params.slug } }),
        default: () => h("div", null, "post"),
      },
    };
    const { prerendered } = await prerenderStaticPages({
      scan,
      load: (f) => Promise.resolve(modules[f]),
      outDir,
      bundleUrlFor: () => null,
      cssUrlFor: () => null,
    });
    assertEquals(prerendered, ["/blog/a/b"]); // NOT "/blog/a,b"
    await Deno.stat(join(outDir, "pages-static", "blog", "a", "b", "index.html"));
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test("prerenderStaticPages rejects an unsafe getStaticPaths path (no escape)", async () => {
  const outDir = await Deno.makeTempDir({ prefix: "denext_ssg_bad_" });
  try {
    const scan: PagesScan = {
      ...EMPTY_SPECIALS,
      pages: [pageEntry("/p/[id]", "p/[id]", "b.tsx")],
      api: [],
    };
    const modules: Record<string, unknown> = {
      "b.tsx": {
        getStaticPaths: () => Promise.resolve({ paths: ["/p/../../etc/passwd"], fallback: false }),
        getStaticProps: () => Promise.resolve({ props: {} }),
        default: () => h("div", null, "x"),
      },
    };
    await assertRejects(
      () =>
        prerenderStaticPages({
          scan,
          load: (f) => Promise.resolve(modules[f]),
          outDir,
          bundleUrlFor: () => null,
          cssUrlFor: () => null,
        }),
      Error,
      "unsafe path",
    );
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test("handler serves a prerendered SSG page from disk (not a live render)", async () => {
  const staticDir = await Deno.makeTempDir({ prefix: "denext_static_" });
  const dir = join(staticDir, "ssg", "a");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "index.html"),
    "<!DOCTYPE html><html><body>PRERENDERED</body></html>",
  );
  await Deno.writeTextFile(
    join(dir, "props.json"),
    JSON.stringify({ page: "/ssg/[id]", pageProps: { id: "a" }, entryUrl: `${PAGES_PREFIX}e.js` }),
  );
  try {
    const scan: PagesScan = {
      ...EMPTY_SPECIALS,
      pages: [pageEntry("/ssg/[id]", "ssg/[id]", "s.tsx")],
      api: [],
    };
    const handle = createPagesHandler({
      getScan: () => scan,
      load: () => Promise.resolve({ default: () => h("div", null, "LIVE") }),
      staticDir,
    });
    const html = await (await handle(new Request("http://localhost/ssg/a")))!.text();
    assertStringIncludes(html, "PRERENDERED");
    assert(!html.includes("LIVE"), "must serve the prerendered file, not a live render");
    // Data request → the props.json shape (entryUrl for the client to import).
    const data = await (await handle(
      new Request("http://localhost/ssg/a", { headers: { "x-denext-pages-data": "1" } }),
    ))!.json();
    assertEquals(data.entryUrl, `${PAGES_PREFIX}e.js`);
  } finally {
    await Deno.remove(staticDir, { recursive: true });
  }
});

// --- prod read-from-disk path (no deno bundle) ------------------------------

Deno.test("createClientBundler serves pre-built bundles from disk (prod path)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_pc_disk_" });
  const clientDir = join(dir, "pages-client");
  await Deno.mkdir(clientDir);
  await Deno.writeTextFile(join(clientDir, "index.js"), "/* built home */");
  await Deno.writeTextFile(
    join(clientDir, "manifest.json"),
    JSON.stringify({ entries: { "/": "index.js" } }),
  );
  try {
    const scan: PagesScan = { ...EMPTY_SPECIALS, pages: [pageEntry("/", "", "home.tsx")], api: [] };
    const bundler = createClientBundler({
      getScan: () => scan,
      configPath: join(dir, "deno.json"), // never read — disk manifest wins
      projectRoot: dir,
      dev: false,
      readDir: clientDir,
    });
    assertEquals(await bundler.urlFor("/"), `${PAGES_PREFIX}index.js`);
    const served = await bundler.serve(`${PAGES_PREFIX}index.js`);
    assertEquals(served!.status, 200);
    assertEquals(await served!.text(), "/* built home */");
    const miss = await bundler.serve(`${PAGES_PREFIX}nope.js`);
    assertEquals(miss!.status, 404);
    // Not one of ours → null.
    assertEquals(await bundler.serve("/other/x.js"), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
