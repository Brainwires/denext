// Tests for `<Link prefetch>` / `router.prefetch()`: the server "head" mode that
// returns a route's chunk URL WITHOUT running getServerSideProps, and the Link
// attribute that opts an anchor into the client viewport-prefetch observer. The
// IntersectionObserver-driven warming itself is covered by the browser e2e.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { parsePattern } from "../src/router/segments.ts";
import { createPagesHandler } from "../packages/pages-router/src/handler.ts";
import type { PagesScan } from "../packages/pages-router/src/scan.ts";
import { type ClientBundler, PAGES_PREFIX } from "../packages/pages-router/src/client-bundle.ts";
import { Link } from "../packages/pages-router/link.ts";

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

const bundler: ClientBundler = {
  urlFor: () => Promise.resolve(`${PAGES_PREFIX}p.js`),
  cssUrlFor: () => Promise.resolve(`${PAGES_PREFIX}p.css`),
  serve: () => Promise.resolve(null),
  prebuild: () => Promise.resolve({ entryByRoute: new Map(), cssByRoute: new Map() }),
};

Deno.test("prefetch request returns the chunk URL and never runs getServerSideProps", async () => {
  let gsspRan = false;
  const scan: PagesScan = { ...EMPTY_SPECIALS, pages: [pageEntry("/", "", "p.tsx")], api: [] };
  const handle = createPagesHandler({
    getScan: () => scan,
    load: () =>
      Promise.resolve({
        getServerSideProps: () => {
          gsspRan = true;
          throw new Error("prefetch must not run data fetching");
        },
        default: () => h("div", null, "x"),
      }),
    bundler,
  });
  const res = await handle(
    new Request("http://localhost/", { headers: { "x-denext-pages-prefetch": "1" } }),
  );
  assertEquals(res!.headers.get("content-type"), "application/json");
  const json = await res!.json();
  assertEquals(json, {
    page: "/",
    entryUrl: `${PAGES_PREFIX}p.js`,
    cssUrl: `${PAGES_PREFIX}p.css`,
    prefetch: true,
  });
  assert(!gsspRan, "getServerSideProps must not run for a prefetch request");
});

Deno.test("prefetch does not serve HTML or a prerendered page", async () => {
  const scan: PagesScan = { ...EMPTY_SPECIALS, pages: [pageEntry("/", "", "p.tsx")], api: [] };
  const handle = createPagesHandler({
    getScan: () => scan,
    load: () => Promise.resolve({ default: () => h("h1", null, "FULL PAGE") }),
    bundler,
  });
  const body = await (await handle(
    new Request("http://localhost/", { headers: { "x-denext-pages-prefetch": "1" } }),
  ))!.text();
  assert(!body.includes("FULL PAGE"), "prefetch must not render the page HTML");
  assertStringIncludes(body, '"prefetch":true');
});

Deno.test("Link prefetch renders the data-denext-prefetch opt-in attribute", async () => {
  const scan: PagesScan = { ...EMPTY_SPECIALS, pages: [pageEntry("/", "", "l.tsx")], api: [] };
  const handle = createPagesHandler({
    getScan: () => scan,
    load: () =>
      Promise.resolve({ default: () => h(Link, { href: "/next", prefetch: true }, "Go") }),
    bundler,
  });
  const body = await (await handle(new Request("http://localhost/")))!.text();
  assertStringIncludes(body, "data-denext-prefetch");
  assertStringIncludes(body, 'href="/next"');
});

Deno.test("Link without prefetch renders a plain anchor (no opt-in attribute)", async () => {
  const scan: PagesScan = { ...EMPTY_SPECIALS, pages: [pageEntry("/", "", "l.tsx")], api: [] };
  const handle = createPagesHandler({
    getScan: () => scan,
    load: () => Promise.resolve({ default: () => h(Link, { href: "/next" }, "Go") }),
    bundler,
  });
  const body = await (await handle(new Request("http://localhost/")))!.text();
  assert(!body.includes("data-denext-prefetch"), "a non-prefetch Link must stay a plain anchor");
  assertStringIncludes(body, 'href="/next"');
});

Deno.test("Link replace renders the data-denext-replace marker (client replaces history)", async () => {
  const scan: PagesScan = { ...EMPTY_SPECIALS, pages: [pageEntry("/", "", "l.tsx")], api: [] };
  const handle = createPagesHandler({
    getScan: () => scan,
    load: () => Promise.resolve({ default: () => h(Link, { href: "/next", replace: true }, "Go") }),
    bundler,
  });
  const body = await (await handle(new Request("http://localhost/")))!.text();
  assertStringIncludes(body, "data-denext-replace");
  assertStringIncludes(body, 'href="/next"');
});

Deno.test("Link without replace renders no replace marker", async () => {
  const scan: PagesScan = { ...EMPTY_SPECIALS, pages: [pageEntry("/", "", "l.tsx")], api: [] };
  const handle = createPagesHandler({
    getScan: () => scan,
    load: () => Promise.resolve({ default: () => h(Link, { href: "/next" }, "Go") }),
    bundler,
  });
  const body = await (await handle(new Request("http://localhost/")))!.text();
  assert(!body.includes("data-denext-replace"), "a non-replace Link must not carry the marker");
});
