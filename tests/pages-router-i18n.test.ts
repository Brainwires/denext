// Tests for Pages Router i18n locale routing: a `/{locale}` prefix is peeled off
// before matching, the active locale flows into data fetching + __NEXT_DATA__ + the
// router, and <Link locale> prefixes the href. Client-side locale tracking on soft
// nav is covered by the browser e2e.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { parsePattern } from "../src/router/segments.ts";
import { createPagesHandler } from "../packages/pages-router/src/handler.ts";
import type { PagesScan } from "../packages/pages-router/src/scan.ts";
import { createServerRouter } from "../packages/pages-router/router.ts";
import { Link } from "../packages/pages-router/link.ts";

const EMPTY_SPECIALS = {
  app: null,
  document: null,
  error: null,
  notFound: null,
  serverError: null,
};
const I18N = { locales: ["en", "fr"], defaultLocale: "en" };

function pageEntry(routePath: string, pattern: string, filePath: string) {
  return { routePath, filePath, isApi: false, pattern: parsePattern(pattern) };
}

function aboutHandler() {
  const scan: PagesScan = {
    ...EMPTY_SPECIALS,
    pages: [pageEntry("/about", "about", "about.tsx")],
    api: [],
  };
  return createPagesHandler({
    getScan: () => scan,
    load: () =>
      Promise.resolve({
        // deno-lint-ignore no-explicit-any
        getServerSideProps: (ctx: any) => ({ props: { echoed: ctx.locale } }),
        default: () => h("div", null, "about"),
      }),
    i18n: I18N,
  });
}

Deno.test("a locale-prefixed path matches the stripped route and passes the locale to gSSP", async () => {
  const json = await (await aboutHandler()(
    new Request("http://localhost/fr/about", { headers: { "x-denext-pages-data": "1" } }),
  ))!.json();
  assertEquals(json.page, "/about"); // matched against the stripped path
  assertEquals(json.pageProps.echoed, "fr"); // ctx.locale reached getServerSideProps
  assertEquals(json.locale, "fr");
  assertEquals(json.locales, ["en", "fr"]);
  assertEquals(json.defaultLocale, "en");
});

Deno.test("an unprefixed path resolves to the default locale", async () => {
  const json = await (await aboutHandler()(
    new Request("http://localhost/about", { headers: { "x-denext-pages-data": "1" } }),
  ))!.json();
  assertEquals(json.page, "/about");
  assertEquals(json.pageProps.echoed, "en");
  assertEquals(json.locale, "en");
});

Deno.test("__NEXT_DATA__ carries the active locale for hydration", async () => {
  const body = await (await aboutHandler()(new Request("http://localhost/fr/about")))!.text();
  assertStringIncludes(body, '"locale":"fr"');
  assertStringIncludes(body, '"defaultLocale":"en"');
});

Deno.test("createServerRouter exposes locale / locales / defaultLocale", () => {
  const router = createServerRouter({
    route: "/about",
    query: {},
    asPath: "/fr/about",
    locale: "fr",
    locales: ["en", "fr"],
    defaultLocale: "en",
  });
  assertEquals(router.locale, "fr");
  assertEquals(router.locales, ["en", "fr"]);
  assertEquals(router.defaultLocale, "en");
});

Deno.test("Link locale prefixes an app-absolute href", async () => {
  const scan: PagesScan = { ...EMPTY_SPECIALS, pages: [pageEntry("/", "", "l.tsx")], api: [] };
  const handle = createPagesHandler({
    getScan: () => scan,
    load: () => Promise.resolve({ default: () => h(Link, { href: "/about", locale: "fr" }, "Go") }),
    i18n: I18N,
  });
  const body = await (await handle(new Request("http://localhost/")))!.text();
  assertStringIncludes(body, 'href="/fr/about"');
});
