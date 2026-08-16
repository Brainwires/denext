// next-intl compat: ICU messages, client hooks (via SSR), server getters,
// locale-aware navigation, and locale-routing middleware.

import { assert, assertEquals } from "@std/assert";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  NextIntlClientProvider,
  useFormatter,
  useLocale,
  useTranslations,
} from "../src/compat/next-intl/index.ts";
import {
  getFormatter,
  getLocale,
  getRequestConfig,
  getTranslations,
  setRequestLocale,
} from "../src/compat/next-intl/server.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { formatIcu } from "../src/compat/next-intl/icu.ts";
import { createNavigation } from "../src/compat/next-intl/navigation.ts";
import { createMiddleware } from "../src/compat/next-intl/middleware.ts";
import type { Middleware } from "../src/server/mod.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const messages = {
  home: {
    greeting: "Hi {name}",
    items: "{count, plural, one {# item} other {# items}}",
  },
};

Deno.test("useTranslations resolves namespaced ICU messages (SSR)", async () => {
  function Greeting() {
    const t = useTranslations("home");
    return h("p", null, `${t("greeting", { name: "Ada" })} | ${t("items", { count: 2 })}`);
  }
  const html = await renderToString(
    h(NextIntlClientProvider as Any, { locale: "en", messages, children: h(Greeting, null) }),
  );
  assert(html.includes("Hi Ada | 2 items"), html);
});

Deno.test("useLocale + useFormatter (SSR)", async () => {
  function Money() {
    const locale = useLocale();
    const f = useFormatter();
    return h("span", null, `${locale}:${f.number(1234.5, { minimumFractionDigits: 1 })}`);
  }
  const html = await renderToString(
    h(NextIntlClientProvider as Any, { locale: "en", messages: {}, children: h(Money, null) }),
  );
  assert(html.includes("en:1,234.5"), html);
});

Deno.test("missing provider throws a clear error", async () => {
  function Bad() {
    useTranslations();
    return h("i", null);
  }
  let msg = "";
  try {
    await renderToString(h(Bad, null));
  } catch (e) {
    msg = (e as Error).message;
  }
  assert(msg.includes("NextIntlClientProvider"), msg);
});

Deno.test("server getTranslations + getFormatter via getRequestConfig", async () => {
  getRequestConfig(({ locale }) => ({
    locale: locale ?? "en",
    messages: { a: { hello: "X {v}" } },
  }));
  const t = await getTranslations({ locale: "en", namespace: "a" });
  assertEquals(t("hello", { v: "Y" }), "X Y");
  const f = await getFormatter({ locale: "en" });
  assertEquals(f.number(1000), "1,000");
});

Deno.test("ICU: # threads into a nested select; missing values are graceful (L2)", () => {
  // `#` inside a select nested in a plural must resolve to the plural's count.
  const msg = "{count, plural, other {saw # ({g, select, m {# males} other {#}})}}";
  assertEquals(formatIcu(msg, { count: 3, g: "m" }, "en"), "saw 3 (3 males)");
  // Missing values render empty (not "NaN") / fall back to the `other` branch.
  assertEquals(formatIcu("{n, number}", {}, "en"), "");
  assertEquals(formatIcu("{c, plural, one {one} other {many}}", {}, "en"), "many");
});

Deno.test("ICU: apostrophe escaping (''; quoted braces/#) — React/ICU parity", () => {
  // "''" → a literal apostrophe; a lone apostrophe before a letter stays literal.
  assertEquals(formatIcu("it''s {v}", { v: "here" }, "en"), "it's here");
  assertEquals(formatIcu("it's {v}", { v: "here" }, "en"), "it's here");
  // Quoted braces render literally instead of being parsed as an argument.
  assertEquals(formatIcu("'{'not an arg'}'", {}, "en"), "{not an arg}");
  assertEquals(formatIcu("show '{'{v}'}'", { v: "x" }, "en"), "show {x}");
  // A quoted "#" inside a plural is a literal "#", not the count.
  assertEquals(
    formatIcu("{c, plural, other {# item'#'tag}}", { c: 2 }, "en"),
    "2 item#tag",
  );
});

Deno.test("server locale is request-isolated under concurrency (H2)", async () => {
  getRequestConfig(({ locale }) => ({
    locale: locale ?? "en",
    messages: { g: { hi: `hi-${locale}` } },
  }));
  // Two concurrent "requests" set different locales; each must see only its own.
  const runReq = (locale: string) =>
    runWithContext(createRequestContext(new Request(`https://x/${locale}`)), async () => {
      setRequestLocale(locale);
      await Promise.resolve(); // yield so the two flows interleave
      const loc = await getLocale();
      const t = await getTranslations("g");
      return `${loc}:${t("hi")}`;
    });
  const [a, b] = await Promise.all([runReq("en"), runReq("fr")]);
  assertEquals(a, "en:hi-en");
  assertEquals(b, "fr:hi-fr");
});

Deno.test("navigation getPathname prefixes per localePrefix mode", () => {
  const always = createNavigation({
    locales: ["en", "fr"],
    defaultLocale: "en",
    localePrefix: "always",
  });
  assertEquals(always.getPathname({ href: "/about", locale: "fr" }), "/fr/about");
  assertEquals(always.getPathname({ href: "/about", locale: "en" }), "/en/about");

  const asNeeded = createNavigation({
    locales: ["en", "fr"],
    defaultLocale: "en",
    localePrefix: "as-needed",
  });
  assertEquals(asNeeded.getPathname({ href: "/about", locale: "en" }), "/about");
  assertEquals(asNeeded.getPathname({ href: "/about", locale: "fr" }), "/fr/about");
});

Deno.test("navigation Link prefixes with the active locale (SSR)", async () => {
  const nav = createNavigation({
    locales: ["en", "fr"],
    defaultLocale: "en",
    localePrefix: "always",
  });
  const html = await renderToString(
    h(NextIntlClientProvider as Any, {
      locale: "fr",
      messages: {},
      children: h(nav.Link as Any, { href: "/about" }, "About"),
    }),
  );
  assert(html.includes('href="/fr/about"'), html);
});

Deno.test("middleware: always mode redirects an unprefixed path", () => {
  const mw = createMiddleware({
    locales: ["en", "fr"],
    defaultLocale: "en",
    localePrefix: "always",
  }) as Middleware;
  const res = mw(new Request("https://x.test/about"), { url: new URL("https://x.test/about") }) as
    | Response
    | undefined;
  assert(res instanceof Response);
  assertEquals(res.status, 307);
  assert((res.headers.get("location") ?? "").endsWith("/en/about"));
});

Deno.test("middleware: already-prefixed path continues with a cookie", () => {
  const mw = createMiddleware({
    locales: ["en", "fr"],
    defaultLocale: "en",
    localePrefix: "always",
  }) as Middleware;
  const res = mw(new Request("https://x.test/fr/x"), {
    url: new URL("https://x.test/fr/x"),
  }) as Response;
  assertEquals(res.headers.get("x-middleware-next"), "1");
  assert(res.headers.getSetCookie().some((c) => c.startsWith("NEXT_LOCALE=fr")));
});

Deno.test("middleware: as-needed rewrites the default locale internally", () => {
  const mw = createMiddleware({
    locales: ["en", "fr"],
    defaultLocale: "en",
    localePrefix: "as-needed",
  }) as Middleware;
  const res = mw(new Request("https://x.test/about"), {
    url: new URL("https://x.test/about"),
  }) as Response;
  assert((res.headers.get("x-middleware-rewrite") ?? "").endsWith("/en/about"));
});
