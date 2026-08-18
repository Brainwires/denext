// Unit tests for the Pages Router client-hydration machinery: entry-source
// generation, the route-id slug, the soft-navigation data endpoint, client
// bundle serving (including the prod read-from-disk path), and basePath. These
// avoid the real `deno bundle` shell-out — the full pipeline is exercised by the
// browser e2e (tests/e2e/pages-router.e2e.test.ts).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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

// --- data endpoint + script injection (fake bundler) ------------------------

const fakeBundler: ClientBundler = {
  urlFor: (routePath) =>
    Promise.resolve(routePath === "/" ? `${PAGES_PREFIX}index.js` : `${PAGES_PREFIX}blog.js`),
  serve: (pathname) =>
    Promise.resolve(
      pathname === `${PAGES_PREFIX}index.js`
        ? new Response("//code", { headers: { "content-type": "text/javascript" } })
        : null,
    ),
  prebuild: () => Promise.resolve(),
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
