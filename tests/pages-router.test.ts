import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import { Head } from "../packages/pages-router/head.ts";
import { scanPagesDir } from "../packages/pages-router/src/scan.ts";
import { createPagesHandler } from "../packages/pages-router/src/handler.ts";
import { type ClientBundler, PAGES_PREFIX } from "../packages/pages-router/src/client-bundle.ts";
import type { PageCache } from "../src/server/mod.ts";
import type { PagesScan } from "../packages/pages-router/src/scan.ts";
import { pagesRouter } from "../packages/pages-router/mod.ts";
import { applyPlugins, getPluginRequestHandler, resetPlugins } from "../src/plugin/mod.ts";

// --- scanning ---------------------------------------------------------------

async function writeTree(files: string[]): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_pages_" });
  for (const rel of files) {
    const full = join(dir, rel);
    await Deno.mkdir(join(full, ".."), { recursive: true });
    await Deno.writeTextFile(full, "export default function () {}\n");
  }
  return dir;
}

Deno.test("scanPagesDir maps files to routes (index, nested, dynamic, api, specials)", async () => {
  const dir = await writeTree([
    "index.tsx",
    "about.tsx",
    "blog/index.tsx",
    "blog/new.tsx",
    "blog/[slug].tsx",
    "docs/[...path].tsx",
    "api/hello.ts",
    "_app.tsx",
    "_document.tsx",
    "404.tsx",
  ]);
  try {
    const scan = await scanPagesDir(dir);
    const paths = scan.pages.map((p) => p.routePath).sort();
    assertEquals(paths, ["/", "/about", "/blog", "/blog/[slug]", "/blog/new", "/docs/[...path]"]);
    assertEquals(scan.api.map((p) => p.routePath), ["/api/hello"]);
    assert(scan.app?.endsWith("_app.tsx"), "detects _app");
    assert(scan.document?.endsWith("_document.tsx"), "detects _document");
    assert(scan.notFound?.endsWith("404.tsx"), "detects 404");
    // Most-specific first: static /blog/new before dynamic /blog/[slug] (both match
    // the path /blog/new, so the static one must be tried first).
    const idxNew = scan.pages.findIndex((p) => p.routePath === "/blog/new");
    const idxSlug = scan.pages.findIndex((p) => p.routePath === "/blog/[slug]");
    assert(idxNew < idxSlug, "static route sorts before dynamic sibling");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- handler + SSR ----------------------------------------------------------

/** A synthetic scan + in-memory module loader for handler tests (no fs/TSX). */
function makeHandler(
  scan: PagesScan,
  modules: Record<string, unknown>,
) {
  return createPagesHandler({
    getScan: () => scan,
    load: (filePath) => {
      if (!(filePath in modules)) throw new Error(`no module ${filePath}`);
      return Promise.resolve(modules[filePath]);
    },
  });
}

function pageEntry(routePath: string, pattern: string, filePath: string) {
  // Lazy import of parsePattern via the same public path the package uses.
  return { routePath, filePath, isApi: false, pattern: parse(pattern) };
}

// Local parse to build patterns without importing internals twice.
import { parsePattern } from "../src/router/segments.ts";
function parse(p: string) {
  return parsePattern(p);
}

const EMPTY_SPECIALS = {
  app: null,
  document: null,
  error: null,
  notFound: null,
  serverError: null,
};

Deno.test("handler renders a matched page to an HTML document with __NEXT_DATA__", async () => {
  const scan: PagesScan = {
    ...EMPTY_SPECIALS,
    pages: [pageEntry("/blog/[slug]", "blog/[slug]", "blog-slug.tsx")],
    api: [],
  };
  const handle = makeHandler(scan, {
    "blog-slug.tsx": {
      default: (props: { slug?: string }) => h("article", null, `Post: ${props.slug ?? "?"}`),
    },
  });

  const res = await handle(new Request("http://localhost/blog/hello?ref=x"));
  assert(res, "expected a response");
  assertEquals(res!.status, 200);
  assertEquals(res!.headers.get("content-type"), "text/html; charset=utf-8");
  const body = await res!.text();
  assertStringIncludes(body, "<!DOCTYPE html>");
  assertStringIncludes(body, '<div id="__next"><article>Post: ?</article></div>');
  assertStringIncludes(body, 'id="__NEXT_DATA__"');
  assertStringIncludes(body, '"page":"/blog/[slug]"');
  assertStringIncludes(body, '"slug":"hello"');
  assertStringIncludes(body, '"ref":"x"');
});

Deno.test("handler runs getServerSideProps and passes props to the page", async () => {
  const scan: PagesScan = {
    ...EMPTY_SPECIALS,
    pages: [pageEntry("/blog/[slug]", "blog/[slug]", "gssp.tsx")],
    api: [],
  };
  const handle = makeHandler(scan, {
    "gssp.tsx": {
      getServerSideProps: (ctx: { params: { slug: string } }) =>
        Promise.resolve({ props: { title: `Post ${ctx.params.slug}` } }),
      default: (props: { title?: string }) => h("h1", null, props.title ?? "none"),
    },
  });

  const res = await handle(new Request("http://localhost/blog/world"));
  const body = await res!.text();
  assertStringIncludes(body, "<h1>Post world</h1>");
  assertStringIncludes(body, '"isServer":true');
});

Deno.test("getServerSideProps can set cookies/headers via context.res", async () => {
  const scan: PagesScan = {
    ...EMPTY_SPECIALS,
    pages: [pageEntry("/", "", "home.tsx")],
    api: [],
  };
  const handle = makeHandler(scan, {
    "home.tsx": {
      getServerSideProps: (ctx: {
        res: { setHeader(n: string, v: string | string[]): void };
        locales?: string[];
      }) => {
        ctx.res.setHeader("Set-Cookie", ["a=1; Path=/", "b=2; Path=/"]);
        ctx.res.setHeader("Cache-Control", "private, max-age=30");
        return Promise.resolve({ props: {} });
      },
      default: () => h("p", null, "ok"),
    },
  });

  const res = await handle(new Request("http://localhost/"));
  assertEquals(res!.status, 200);
  assertEquals(res!.headers.get("cache-control"), "private, max-age=30");
  const cookies = res!.headers.getSetCookie();
  assertEquals(cookies, ["a=1; Path=/", "b=2; Path=/"]);
  // The HTML body is still served (headers didn't replace the content type).
  assertEquals(res!.headers.get("content-type"), "text/html; charset=utf-8");
});

Deno.test("getServerSideProps context exposes locales/defaultLocale", async () => {
  const scan: PagesScan = {
    ...EMPTY_SPECIALS,
    pages: [pageEntry("/", "", "home.tsx")],
    api: [],
  };
  let seen: { locales?: string[]; defaultLocale?: string } = {};
  const handle = createPagesHandler({
    getScan: () => scan,
    load: () =>
      Promise.resolve({
        getServerSideProps: (ctx: { locales?: string[]; defaultLocale?: string }) => {
          seen = { locales: ctx.locales, defaultLocale: ctx.defaultLocale };
          return Promise.resolve({ props: {} });
        },
        default: () => h("p", null, "ok"),
      }),
    i18n: { locales: ["en", "fr"], defaultLocale: "en" },
  });
  await handle(new Request("http://localhost/"));
  assertEquals(seen, { locales: ["en", "fr"], defaultLocale: "en" });
});

Deno.test("handler wraps the page in _app", async () => {
  const scan: PagesScan = {
    ...EMPTY_SPECIALS,
    app: "app.tsx",
    pages: [pageEntry("/", "", "home.tsx")],
    api: [],
  };
  const handle = makeHandler(scan, {
    "home.tsx": { default: () => h("span", null, "page") },
    "app.tsx": {
      // deno-lint-ignore no-explicit-any
      default: (props: { Component: any; pageProps: any }) =>
        h("main", { class: "app" }, h(props.Component, props.pageProps)),
    },
  });

  const res = await handle(new Request("http://localhost/"));
  const body = await res!.text();
  assertStringIncludes(body, '<main class="app"><span>page</span></main>');
});

Deno.test("custom _document wraps the page (Html/Head/Main/NextScript)", async () => {
  const { Html, Head, Main, NextScript } = await import(
    "../packages/pages-router/src/document.ts"
  );
  const scan: PagesScan = {
    ...EMPTY_SPECIALS,
    document: "doc.tsx",
    pages: [pageEntry("/", "", "home.tsx")],
    api: [],
  };
  const handle = makeHandler(scan, {
    "home.tsx": { default: () => h("p", null, "hi") },
    "doc.tsx": {
      default: () =>
        h(
          Html,
          { lang: "fr" },
          h(Head, null, h("meta", { name: "custom", content: "1" })),
          h("body", { class: "doc" }, h(Main, null), h(NextScript, null)),
        ),
    },
  });
  const res = await handle(new Request("http://localhost/"));
  const body = await res!.text();
  assertStringIncludes(body, "<!DOCTYPE html>");
  assertStringIncludes(body, '<html lang="fr">');
  assertStringIncludes(body, '<meta name="custom" content="1">');
  assertStringIncludes(body, '<body class="doc">');
  assertStringIncludes(body, '<div id="__next"><p>hi</p></div>');
  assertStringIncludes(body, 'id="__NEXT_DATA__"');
});

Deno.test("handler returns null for an unmatched path (falls through to core)", async () => {
  const scan: PagesScan = { ...EMPTY_SPECIALS, pages: [pageEntry("/", "", "home.tsx")], api: [] };
  const handle = makeHandler(scan, { "home.tsx": { default: () => h("div", null, "x") } });
  const res = await handle(new Request("http://localhost/does-not-exist"));
  assertEquals(res, null);
});

Deno.test("API route: GET handler returns JSON", async () => {
  const scan: PagesScan = {
    ...EMPTY_SPECIALS,
    pages: [],
    api: [{
      routePath: "/api/user/[id]",
      pattern: parse("api/user/[id]"),
      filePath: "u.ts",
      isApi: true,
    }],
  };
  const handle = makeHandler(scan, {
    "u.ts": {
      // deno-lint-ignore no-explicit-any
      default: (req: any, res: any) => res.status(200).json({ id: req.query.id, m: req.method }),
    },
  });
  const res = await handle(new Request("http://localhost/api/user/42"));
  assertEquals(res!.status, 200);
  assertEquals(res!.headers.get("content-type"), "application/json");
  assertEquals(await res!.json(), { id: "42", m: "GET" });
});

Deno.test("API route: POST parses a JSON body", async () => {
  const scan: PagesScan = {
    ...EMPTY_SPECIALS,
    pages: [],
    api: [{ routePath: "/api/echo", pattern: parse("api/echo"), filePath: "e.ts", isApi: true }],
  };
  const handle = makeHandler(scan, {
    "e.ts": {
      // deno-lint-ignore no-explicit-any
      default: (req: any, res: any) => res.json({ got: req.body, method: req.method }),
    },
  });
  const res = await handle(
    new Request("http://localhost/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    }),
  );
  assertEquals(res!.status, 200);
  assertEquals(await res!.json(), { got: { a: 1 }, method: "POST" });
});

Deno.test("useRouter reflects the matched route during SSR", async () => {
  const { useRouter } = await import("../packages/pages-router/router.ts");
  const scan: PagesScan = {
    ...EMPTY_SPECIALS,
    pages: [pageEntry("/blog/[slug]", "blog/[slug]", "u.tsx")],
    api: [],
  };
  const handle = makeHandler(scan, {
    "u.tsx": {
      default: function Page() {
        const r = useRouter();
        return h("div", null, `${r.pathname}|${r.asPath}|${r.query.slug}`);
      },
    },
  });
  const res = await handle(new Request("http://localhost/blog/x?tab=2"));
  const body = await res!.text();
  assertStringIncludes(body, "<div>/blog/[slug]|/blog/x?tab=2|x</div>");
});

Deno.test("Link renders an anchor to href", async () => {
  const { Link } = await import("../packages/pages-router/link.ts");
  const scan: PagesScan = { ...EMPTY_SPECIALS, pages: [pageEntry("/", "", "l.tsx")], api: [] };
  const handle = makeHandler(scan, {
    "l.tsx": { default: () => h(Link, { href: "/about", className: "nav" }, "About") },
  });
  const res = await handle(new Request("http://localhost/"));
  assertStringIncludes(await res!.text(), '<a href="/about" class="nav">About</a>');
});

Deno.test("getStaticPaths fallback:false → 404 for an unlisted param", async () => {
  const scan: PagesScan = {
    ...EMPTY_SPECIALS,
    pages: [pageEntry("/p/[id]", "p/[id]", "sp.tsx")],
    api: [],
  };
  const handle = makeHandler(scan, {
    "sp.tsx": {
      getStaticPaths: () => Promise.resolve({ paths: [{ params: { id: "1" } }], fallback: false }),
      getStaticProps: (ctx: { params: { id: string } }) =>
        Promise.resolve({ props: { id: ctx.params.id } }),
      default: (props: { id?: string }) => h("div", null, props.id ?? "?"),
    },
  });
  assertEquals((await handle(new Request("http://localhost/p/999")))!.status, 404);
  const ok = await handle(new Request("http://localhost/p/1"));
  assertEquals(ok!.status, 200);
  assertStringIncludes(await ok!.text(), "<div>1</div>");
});

Deno.test("getServerSideProps redirect → 307/308", async () => {
  const scan: PagesScan = { ...EMPTY_SPECIALS, pages: [pageEntry("/", "", "r.tsx")], api: [] };
  const handle = makeHandler(scan, {
    "r.tsx": {
      getServerSideProps: () =>
        Promise.resolve({ redirect: { destination: "/login", permanent: false } }),
      default: () => h("div", null, "never"),
    },
  });
  const res = await handle(new Request("http://localhost/"));
  assertEquals(res!.status, 307);
  assertEquals(res!.headers.get("location"), "/login");
});

// --- next/head --------------------------------------------------------------

Deno.test("next/head hoists <title>/<meta> into the document head (SSR)", async () => {
  const scan: PagesScan = { ...EMPTY_SPECIALS, pages: [pageEntry("/", "", "h.tsx")], api: [] };
  const handle = makeHandler(scan, {
    "h.tsx": {
      default: () =>
        h(
          "main",
          null,
          h(
            Head,
            null,
            h("title", null, "My Title"),
            h("meta", { name: "description", content: "hi" }),
          ),
          h("p", null, "body"),
        ),
    },
  });
  const body = await (await handle(new Request("http://localhost/")))!.text();
  assertStringIncludes(body, "<title>My Title</title>");
  assertStringIncludes(body, '<meta name="description" content="hi">');
  // Body has the page content; the head tags were hoisted out of it.
  assertStringIncludes(body, "<main><p>body</p></main>");
});

// --- error pages (_error / 404 / 500) ---------------------------------------

Deno.test("custom 404 renders for an unmatched page-like path", async () => {
  const scan: PagesScan = {
    ...EMPTY_SPECIALS,
    notFound: "404.tsx",
    pages: [pageEntry("/", "", "home.tsx")],
    api: [],
  };
  const handle = makeHandler(scan, {
    "home.tsx": { default: () => h("div", null, "home") },
    "404.tsx": { default: () => h("h1", null, "Custom Not Found") },
  });
  const res = await handle(new Request("http://localhost/missing"));
  assert(res, "expected a 404 response");
  assertEquals(res!.status, 404);
  assertStringIncludes(await res!.text(), "<h1>Custom Not Found</h1>");
});

Deno.test("unmatched asset path (has extension) falls through to core (null)", async () => {
  const scan: PagesScan = {
    ...EMPTY_SPECIALS,
    notFound: "404.tsx",
    pages: [pageEntry("/", "", "home.tsx")],
    api: [],
  };
  const handle = makeHandler(scan, {
    "home.tsx": { default: () => h("div", null, "home") },
    "404.tsx": { default: () => h("h1", null, "nope") },
  });
  // A `public/` asset request must not be shadowed by the custom 404.
  assertEquals(await handle(new Request("http://localhost/favicon.ico")), null);
});

Deno.test("getServerSideProps notFound renders the custom 404", async () => {
  const scan: PagesScan = {
    ...EMPTY_SPECIALS,
    notFound: "404.tsx",
    pages: [pageEntry("/p/[id]", "p/[id]", "p.tsx")],
    api: [],
  };
  const handle = makeHandler(scan, {
    "p.tsx": {
      getServerSideProps: () => Promise.resolve({ notFound: true }),
      default: () => h("div", null, "never"),
    },
    "404.tsx": { default: () => h("h1", null, "Gone") },
  });
  const res = await handle(new Request("http://localhost/p/7"));
  assertEquals(res!.status, 404);
  assertStringIncludes(await res!.text(), "<h1>Gone</h1>");
});

Deno.test("a thrown render error renders the custom 500", async () => {
  const scan: PagesScan = {
    ...EMPTY_SPECIALS,
    serverError: "500.tsx",
    pages: [pageEntry("/", "", "boom.tsx")],
    api: [],
  };
  const handle = makeHandler(scan, {
    "boom.tsx": {
      default: () => {
        throw new Error("kaboom");
      },
    },
    "500.tsx": { default: () => h("h1", null, "Server Error") },
  });
  const res = await handle(new Request("http://localhost/"));
  assertEquals(res!.status, 500);
  assertStringIncludes(await res!.text(), "<h1>Server Error</h1>");
});

Deno.test("_error catch-all receives statusCode", async () => {
  const scan: PagesScan = {
    ...EMPTY_SPECIALS,
    error: "_error.tsx",
    pages: [pageEntry("/", "", "home.tsx")],
    api: [],
  };
  const handle = makeHandler(scan, {
    "home.tsx": { default: () => h("div", null, "home") },
    "_error.tsx": {
      default: (props: { statusCode?: number }) => h("h1", null, `E${props.statusCode}`),
    },
  });
  const res = await handle(new Request("http://localhost/nope"));
  assertEquals(res!.status, 404);
  assertStringIncludes(await res!.text(), "<h1>E404</h1>");
});

// --- resilience: the handler must never throw out to core -------------------

Deno.test("API handler that sets an error status then throws keeps that status (no 500)", async () => {
  const scan: PagesScan = {
    ...EMPTY_SPECIALS,
    pages: [],
    api: [{ routePath: "/api/x", pattern: parse("api/x"), filePath: "x.ts", isApi: true }],
  };
  const handle = makeHandler(scan, {
    "x.ts": {
      // deno-lint-ignore no-explicit-any
      default: (_req: any, res: any) => {
        res.status(400);
        throw new Error("validation failed");
      },
    },
  });
  const res = await handle(new Request("http://localhost/api/x", { method: "POST" }));
  assertEquals(res!.status, 400); // the handler's status is honored, not swallowed as 500
});

Deno.test("data request whose getServerSideProps throws returns a JSON 500 (not a throw)", async () => {
  const scan: PagesScan = { ...EMPTY_SPECIALS, pages: [pageEntry("/", "", "p.tsx")], api: [] };
  const handle = makeHandler(scan, {
    "p.tsx": {
      getServerSideProps: () => {
        throw new Error("db down");
      },
      default: () => h("div", null, "x"),
    },
  });
  const res = await handle(
    new Request("http://localhost/", { headers: { "x-denext-pages-data": "1" } }),
  );
  assertEquals(res!.status, 500);
  assertEquals(res!.headers.get("content-type"), "application/json");
});

Deno.test("a bundling failure on a /_denext/pages/*.js request returns 500, not a throw", async () => {
  const badBundler: ClientBundler = {
    urlFor: () => Promise.resolve(null),
    cssUrlFor: () => Promise.resolve(null),
    serve: () => {
      throw new Error("deno bundle failed");
    },
    prebuild: () => Promise.resolve({ entryByRoute: new Map(), cssByRoute: new Map() }),
  };
  const scan: PagesScan = { ...EMPTY_SPECIALS, pages: [pageEntry("/", "", "h.tsx")], api: [] };
  const handle = createPagesHandler({
    getScan: () => scan,
    load: () => Promise.resolve({ default: () => h("div", null, "x") }),
    bundler: badBundler,
  });
  const res = await handle(new Request(`http://localhost${PAGES_PREFIX}index.js`));
  assertEquals(res!.status, 500);
});

Deno.test("an unexpected handler error (getScan throws) 500s a page but not an asset", async () => {
  const handle = createPagesHandler({
    getScan: () => {
      throw new Error("scan failed");
    },
    load: () => Promise.resolve({}),
  });
  // A page-like path surfaces the failure as 500…
  assertEquals((await handle(new Request("http://localhost/whatever")))!.status, 500);
  // …but an asset request falls through (null) so core can still static-serve it,
  // i.e. a broken plugin never takes down `public/` files.
  assertEquals(await handle(new Request("http://localhost/logo.png")), null);
  assertEquals(await handle(new Request("http://localhost/_denext/x")), null);
});

// --- ISR resilience + no cache poisoning ------------------------------------

Deno.test("ISR: a cache read failure still serves the prerendered file (no 500)", async () => {
  const staticDir = await Deno.makeTempDir({ prefix: "denext_isr_" });
  const dir = join(staticDir, "ssg", "a");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, "index.html"), "<!DOCTYPE html><body>PRERENDERED</body>");
  await Deno.writeTextFile(
    join(dir, "props.json"),
    JSON.stringify({ page: "/ssg/[id]", pageProps: {}, revalidate: 60 }),
  );
  const badCache = {
    get: () => Promise.reject(new Error("cache backend down")),
    set: () => Promise.resolve(),
    revalidatePath: () => Promise.resolve(),
    revalidateTag: () => Promise.resolve(),
  } as unknown as PageCache;
  try {
    const scan: PagesScan = {
      ...EMPTY_SPECIALS,
      pages: [pageEntry("/ssg/[id]", "ssg/[id]", "s.tsx")],
      api: [],
    };
    const handle = createPagesHandler({
      getScan: () => scan,
      load: () => Promise.resolve({ default: () => h("div", null, "live") }),
      staticDir,
      pageCache: badCache,
    });
    const res = await handle(new Request("http://localhost/ssg/a"));
    assertEquals(res!.status, 200);
    assertStringIncludes(await res!.text(), "PRERENDERED");
  } finally {
    await Deno.remove(staticDir, { recursive: true });
  }
});

Deno.test("ISR: a stale regen that redirects does NOT poison the cache with a 200 body", async () => {
  const staticDir = await Deno.makeTempDir({ prefix: "denext_isr2_" });
  const dir = join(staticDir, "ssg", "a");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, "index.html"), "<!DOCTYPE html><body>STALE</body>");
  await Deno.writeTextFile(
    join(dir, "props.json"),
    JSON.stringify({ page: "/ssg/[id]", pageProps: {}, revalidate: 60 }),
  );
  // In-memory cache pre-seeded STALE (staleAt in the past) so the request triggers regen.
  const store = new Map<string, { body: string; staleAt?: number; status: number }>();
  store.set("pr:/ssg/a", { body: "STALE", staleAt: Date.now() - 1000, status: 200 });
  const cache = {
    // deno-lint-ignore no-explicit-any
    get: (k: string) => Promise.resolve(store.get(k) as any),
    // deno-lint-ignore no-explicit-any
    set: (k: string, v: any) => {
      store.set(k, v);
      return Promise.resolve();
    },
    revalidatePath: () => Promise.resolve(),
    revalidateTag: () => Promise.resolve(),
  } as unknown as PageCache;
  try {
    const scan: PagesScan = {
      ...EMPTY_SPECIALS,
      pages: [pageEntry("/ssg/[id]", "ssg/[id]", "s.tsx")],
      api: [],
    };
    const handle = createPagesHandler({
      getScan: () => scan,
      load: () =>
        Promise.resolve({
          // The data source now redirects — the regen must not cache a blank 200.
          getStaticProps: () =>
            Promise.resolve({ redirect: { destination: "/login", permanent: false } }),
          default: () => h("div", null, "live"),
        }),
      staticDir,
      pageCache: cache,
    });
    const res = await handle(new Request("http://localhost/ssg/a"));
    assertEquals(res!.status, 200);
    assertStringIncludes(await res!.text(), "STALE"); // served stale, correct
    // Let the background regen run, then assert the cache still holds the stale body
    // (bumped staleAt) — never an empty 200 redirect body.
    await new Promise((r) => setTimeout(r, 30));
    const after = store.get("pr:/ssg/a")!;
    assertEquals(after.status, 200);
    assertStringIncludes(after.body, "STALE");
    assert((after.staleAt ?? 0) > Date.now(), "staleAt should be bumped forward (back-off)");
  } finally {
    await Deno.remove(staticDir, { recursive: true });
  }
});

// --- full plugin integration (pagesRouter → applyPlugins → claim-hook) -------

Deno.test("pagesRouter plugin end-to-end: config → applyPlugins → renders a page", async () => {
  resetPlugins();
  const root = await Deno.makeTempDir({ prefix: "denext_pr_e2e_" });
  const pagesDir = join(root, "pages");
  await Deno.mkdir(join(pagesDir, "blog"), { recursive: true });
  // Files exist so scanPagesDir finds them; their contents are irrelevant because
  // the test loader serves modules from memory by absolute path.
  await Deno.writeTextFile(join(pagesDir, "index.tsx"), "export default function(){}\n");
  await Deno.writeTextFile(join(pagesDir, "blog", "[slug].tsx"), "export default function(){}\n");
  try {
    const modules: Record<string, unknown> = {
      [join(pagesDir, "index.tsx")]: { default: () => h("h1", null, "Home") },
      [join(pagesDir, "blog", "[slug].tsx")]: {
        getServerSideProps: (ctx: { params: { slug: string } }) =>
          Promise.resolve({ props: { slug: ctx.params.slug } }),
        default: (props: { slug?: string }) => h("article", null, `Post ${props.slug}`),
      },
    };
    await applyPlugins({
      projectRoot: root,
      appDir: join(root, "app"),
      config: { plugins: [pagesRouter()] },
      mode: "prod",
      load: (filePath) => {
        if (!(filePath in modules)) throw new Error(`no module ${filePath}`);
        return Promise.resolve(modules[filePath]);
      },
    });

    const handle = getPluginRequestHandler();
    assert(handle, "plugin registered a request handler");

    const home = await handle!(new Request("http://localhost/"));
    assertEquals(home!.status, 200);
    assertStringIncludes(await home!.text(), '<div id="__next"><h1>Home</h1></div>');

    const post = await handle!(new Request("http://localhost/blog/deno"));
    assertStringIncludes(await post!.text(), "<article>Post deno</article>");

    // Unmatched → null so the core router falls through.
    const miss = await handle!(new Request("http://localhost/nope/nope/nope"));
    assertEquals(miss, null);
  } finally {
    resetPlugins();
    await Deno.remove(root, { recursive: true });
  }
});
