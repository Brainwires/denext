// Tests for legacy `getInitialProps` (page-level and `_app`-level). denext runs it
// server-side for both the initial render and soft-nav data requests, so these
// exercise it through the data endpoint and the HTML render.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { parsePattern } from "../src/router/segments.ts";
import { createPagesHandler } from "../packages/pages-router/src/handler.ts";
import type { PagesScan } from "../packages/pages-router/src/scan.ts";

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

// deno-lint-ignore no-explicit-any
type Gip = (ctx: any) => Record<string, unknown> | Promise<Record<string, unknown>>;
function withGip(component: unknown, gip: Gip): unknown {
  (component as { getInitialProps?: Gip }).getInitialProps = gip;
  return component;
}

Deno.test("page getInitialProps supplies pageProps with the Next ctx shape", async () => {
  const Page = withGip(
    () => h("div", null, "x"),
    (ctx) => ({
      id: ctx.params.id,
      q: ctx.query.q,
      pathname: ctx.pathname,
      asPath: ctx.asPath,
      hasReq: !!ctx.req,
    }),
  );
  const scan: PagesScan = {
    ...EMPTY_SPECIALS,
    pages: [pageEntry("/p/[id]", "p/[id]", "p.tsx")],
    api: [],
  };
  const handle = createPagesHandler({
    getScan: () => scan,
    load: () => Promise.resolve({ default: Page }),
  });
  const res = await handle(
    new Request("http://localhost/p/hello?q=1", { headers: { "x-denext-pages-data": "1" } }),
  );
  const json = await res!.json();
  assertEquals(json.pageProps, {
    id: "hello",
    q: "1",
    pathname: "/p/[id]", // the route PATTERN, not the concrete path (Next parity)
    asPath: "/p/hello?q=1",
    hasReq: true,
  });
  assertEquals(json.isServer, true); // getInitialProps makes the route dynamic
});

Deno.test("page getInitialProps props render into the SSR HTML", async () => {
  const Page = withGip(
    (props: { title?: string }) => h("h1", null, props.title ?? "none"),
    () => ({ title: "from-gip" }),
  );
  const scan: PagesScan = { ...EMPTY_SPECIALS, pages: [pageEntry("/", "", "p.tsx")], api: [] };
  const handle = createPagesHandler({
    getScan: () => scan,
    load: () => Promise.resolve({ default: Page }),
  });
  const body = await (await handle(new Request("http://localhost/")))!.text();
  assertStringIncludes(body, "<h1>from-gip</h1>");
});

Deno.test("_app getInitialProps owns the flow and supplies pageProps", async () => {
  const Page = withGip(() => h("div", null, "x"), () => ({ fromPage: true }));
  // A custom _app.getInitialProps that does NOT call the page's — its pageProps win,
  // and the page's own getInitialProps must not be used (Next behavior).
  const App = withGip(
    (p: { Component: unknown; pageProps: Record<string, unknown> }) =>
      h(p.Component as never, p.pageProps),
    () => ({ pageProps: { fromApp: true } }),
  );
  const scan: PagesScan = {
    ...EMPTY_SPECIALS,
    app: "_app.tsx",
    pages: [pageEntry("/", "", "p.tsx")],
    api: [],
  };
  const handle = createPagesHandler({
    getScan: () => scan,
    load: (file) => Promise.resolve(file === "_app.tsx" ? { default: App } : { default: Page }),
  });
  const json = await (await handle(
    new Request("http://localhost/", { headers: { "x-denext-pages-data": "1" } }),
  ))!.json();
  assertEquals(json.pageProps, { fromApp: true });
});

Deno.test("a page with no data method still yields empty props (static)", async () => {
  const scan: PagesScan = { ...EMPTY_SPECIALS, pages: [pageEntry("/", "", "p.tsx")], api: [] };
  const handle = createPagesHandler({
    getScan: () => scan,
    load: () => Promise.resolve({ default: () => h("div", null, "x") }),
  });
  const json = await (await handle(
    new Request("http://localhost/", { headers: { "x-denext-pages-data": "1" } }),
  ))!.json();
  assertEquals(json.pageProps, {});
  assertEquals(json.isServer, false);
});
