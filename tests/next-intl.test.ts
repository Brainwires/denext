// next-intl compat: ICU messages, client hooks (via SSR), server getters,
// locale-aware navigation, and locale-routing middleware.

import { assert, assertEquals } from "@std/assert";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  createTranslator,
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
import {
  createLocalizedPathnamesNavigation,
  createNavigation,
} from "../src/compat/next-intl/navigation.ts";
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

Deno.test("ICU: number `::` skeletons map to Intl.NumberFormat (zero data)", () => {
  assertEquals(formatIcu("{n, number, ::.00}", { n: 3.14159 }, "en"), "3.14");
  assertEquals(formatIcu("{n, number, ::.##}", { n: 3.5 }, "en"), "3.5");
  assertEquals(formatIcu("{n, number, ::percent}", { n: 0.25 }, "en"), "25%");
  assertEquals(formatIcu("{n, number, ::compact-short}", { n: 12345 }, "en"), "12K");
  assertEquals(formatIcu("{n, number, ::currency/EUR}", { n: 9.5 }, "en"), "€9.50");
  assertEquals(formatIcu("{n, number, ::sign-always}", { n: 5 }, "en"), "+5");
  assertEquals(formatIcu("{n, number, ::group-off}", { n: 12345 }, "en"), "12345");
  // The legacy single-token currency skeleton still works.
  assertEquals(formatIcu("{n, number, ::currency/USD}", { n: 1234.5 }, "en"), "$1,234.50");
  // An unknown token is ignored gracefully (no throw), not fatal.
  assertEquals(formatIcu("{n, number, ::bogus-token}", { n: 42 }, "en"), "42");
});

Deno.test("ICU: date `::` field skeletons map to Intl.DateTimeFormat options", () => {
  // Timezone-robust: assert the skeleton→options mapping matches a direct Intl call
  // (both use the same ambient time zone), rather than pinning absolute output.
  const d = new Date(Date.UTC(2026, 7, 26, 14, 5, 9));
  assertEquals(
    formatIcu("{d, date, ::yMMMd}", { d }, "en"),
    new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric" }).format(d),
  );
  assertEquals(
    formatIcu("{t, time, ::Hm}", { t: d }, "en"),
    new Intl.DateTimeFormat("en", { hour: "numeric", hour12: false, minute: "numeric" }).format(d),
  );
  // The named buckets still work.
  assertEquals(
    formatIcu("{d, date, long}", { d }, "en"),
    new Intl.DateTimeFormat("en", { dateStyle: "long" }).format(d),
  );
});

Deno.test("ICU: `duration` formats whole seconds as H:MM:SS (Intl.DurationFormat, zero data)", () => {
  assertEquals(formatIcu("{s, duration}", { s: 3723 }, "en"), "1:02:03");
  assertEquals(formatIcu("{s, duration}", { s: 125 }, "en"), "0:02:05");
  assertEquals(formatIcu("{s, duration}", { s: 45 }, "en"), "0:00:45");
  assertEquals(formatIcu("{s, duration}", { s: -65 }, "en"), "-0:01:05");
  assertEquals(formatIcu("{s, duration}", {}, "en"), ""); // missing → empty, not "NaN"
});

Deno.test("ICU: `spellout` and `ordinal` (first-party English speller, zero data)", () => {
  assertEquals(formatIcu("{n, spellout}", { n: 0 }, "en"), "zero");
  assertEquals(formatIcu("{n, spellout}", { n: 123 }, "en"), "one hundred twenty-three");
  assertEquals(formatIcu("{n, spellout}", { n: 1000021 }, "en"), "one million twenty-one");
  assertEquals(formatIcu("{n, spellout}", { n: -42 }, "en"), "minus forty-two");
  assertEquals(formatIcu("{n, spellout}", { n: 3.14 }, "en"), "three point one four");
  // Ordinal indicators over the locale-aware ordinal category.
  assertEquals(formatIcu("{n, ordinal} place", { n: 1 }, "en"), "1st place");
  assertEquals(formatIcu("{n, ordinal}", { n: 2 }, "en"), "2nd");
  assertEquals(formatIcu("{n, ordinal}", { n: 3 }, "en"), "3rd");
  assertEquals(formatIcu("{n, ordinal}", { n: 11 }, "en"), "11th");
  assertEquals(formatIcu("{n, ordinal}", { n: 22 }, "en"), "22nd");
  // Non-English falls back to the localized numeral (no per-language spelling yet).
  assertEquals(formatIcu("{n, spellout}", { n: 123 }, "fr"), "123");
  // Missing value → empty, not "NaN".
  assertEquals(formatIcu("{n, spellout}", {}, "en"), "");
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

Deno.test("localized pathnames: getPathname translates per locale (+ params)", () => {
  const nav = createLocalizedPathnamesNavigation({
    locales: ["en", "de"],
    defaultLocale: "en",
    localePrefix: "always",
    pathnames: {
      "/about": { en: "/about", de: "/ueber-uns" },
      "/blog/[slug]": { en: "/blog/[slug]", de: "/artikel/[slug]" },
    },
  });
  assertEquals(nav.getPathname({ href: "/about", locale: "de" }), "/de/ueber-uns");
  assertEquals(nav.getPathname({ href: "/about", locale: "en" }), "/en/about");
  // The object-href form interpolates params into the translated dynamic segment.
  assertEquals(
    nav.getPathname({ href: { pathname: "/blog/[slug]", params: { slug: "x" } }, locale: "de" }),
    "/de/artikel/x",
  );
  // An unmapped path passes through untranslated.
  assertEquals(nav.getPathname({ href: "/other", locale: "de" }), "/de/other");
});

Deno.test("localized pathnames: Link translates the href for the active locale (SSR)", async () => {
  const nav = createLocalizedPathnamesNavigation({
    locales: ["en", "de"],
    defaultLocale: "en",
    localePrefix: "always",
    pathnames: { "/about": { en: "/about", de: "/ueber-uns" } },
  });
  const html = await renderToString(
    h(NextIntlClientProvider as Any, {
      locale: "de",
      messages: {},
      children: h(nav.Link as Any, { href: "/about" }, "Über uns"),
    }),
  );
  assert(html.includes('href="/de/ueber-uns"'), html);
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
  const res = mw(new Request("https://x.test/about"), {
    url: new URL("https://x.test/about"),
    waitUntil: () => {},
  }) as
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
    waitUntil: () => {},
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
    waitUntil: () => {},
  }) as Response;
  assert((res.headers.get("x-middleware-rewrite") ?? "").endsWith("/en/about"));
});

// ---- t.rich / t.markup (rich-text and markup message rendering) ------------

Deno.test("t.markup applies string tag handlers over ICU text", () => {
  const t = createTranslator({
    locale: "en",
    messages: { note: "Read <b>{count, plural, one {# rule} other {# rules}}</b> now" },
  });
  const s = t.markup("note", { count: 2, b: (c) => `<strong>${c}</strong>` });
  assertEquals(s, "Read <strong>2 rules</strong> now");
});

Deno.test("t.rich embeds nodes from tag handlers (SSR)", async () => {
  const t = createTranslator({
    locale: "en",
    messages: { cta: "Please <link>sign in</link> to continue" },
  });
  const node = t.rich("cta", { link: (chunks) => h("a", { href: "/login" }, chunks) });
  const html = await renderToString(h("p", null, node));
  assert(html.includes('<a href="/login">sign in</a>'), html);
  assert(html.includes("Please "), html);
  assert(html.includes(" to continue"), html);
});

Deno.test("t.rich handles nested tags and a self-closing tag (SSR)", async () => {
  const t = createTranslator({
    locale: "en",
    messages: { m: "A <b>bold <i>and italic</i></b><br/>end" },
  });
  const node = t.rich("m", {
    b: (c) => h("b", null, c),
    i: (c) => h("i", null, c),
    br: () => h("br", null),
  });
  const html = await renderToString(h("p", null, node));
  assert(html.includes("<b>bold <i>and italic</i></b>"), html);
  assert(html.includes("<br"), html);
});

Deno.test("t.rich with a missing tag handler renders the children inline (SSR)", async () => {
  const t = createTranslator({ locale: "en", messages: { m: "x <b>y</b> z" } });
  const html = await renderToString(h("p", null, t.rich("m", {})));
  assert(html.includes("x y z"), html);
});

Deno.test("t.rich/t.markup fall back to the key for a missing message", () => {
  const t = createTranslator({ locale: "en", messages: {} });
  assertEquals(t.markup("missing", {}), "missing");
});
