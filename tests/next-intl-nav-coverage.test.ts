// Coverage for the next-intl compat entry points: navigation.ts (locale-aware
// Link / router / redirect / getPathname), server.ts (getLocale/getMessages/
// getTimeZone/getNow/getTranslations/getFormatter + request-config loader), and
// the index.ts re-exports (createTranslator / createFormatter / hasLocale, etc.).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  createLocalizedPathnamesNavigation,
  createNavigation,
  createSharedPathnamesNavigation,
} from "../src/compat/next-intl/navigation.ts";
import { defineRouting } from "../src/compat/next-intl/routing.ts";
import {
  getFormatter,
  getLocale,
  getMessages,
  getNow,
  getRequestConfig,
  getTimeZone,
  getTranslations,
  setRequestLocale,
  unstable_setRequestLocale,
} from "../src/compat/next-intl/server.ts";
import {
  createFormatter,
  createTranslator,
  NextIntlClientProvider,
} from "../src/compat/next-intl/index.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { RedirectError } from "../src/runtime/error-boundary.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

// ---- navigation.ts: getPathname prefix modes -------------------------------

Deno.test("getPathname: never mode passes hrefs through unprefixed", () => {
  const nav = createNavigation({
    locales: ["en", "fr"],
    defaultLocale: "en",
    localePrefix: "never",
  });
  assertEquals(nav.getPathname({ href: "/about", locale: "fr" }), "/about");
});

Deno.test("getPathname: the root path '/' prefixes to '/<locale>'", () => {
  const nav = createNavigation({
    locales: ["en", "fr"],
    defaultLocale: "en",
    localePrefix: "always",
  });
  assertEquals(nav.getPathname({ href: "/", locale: "fr" }), "/fr");
  // With no explicit locale it uses the default locale.
  assertEquals(nav.getPathname({ href: "/", locale: undefined }), "/en");
});

Deno.test("getPathname accepts an already-resolved routing object", () => {
  const routing = defineRouting({
    locales: ["en", "de"],
    defaultLocale: "en",
    localePrefix: "as-needed",
  });
  const nav = createNavigation(routing);
  assertEquals(nav.getPathname({ href: "/x", locale: "en" }), "/x");
  assertEquals(nav.getPathname({ href: "/x", locale: "de" }), "/de/x");
});

Deno.test("getPathname: string pathnames entry + missing-locale fallback", () => {
  const nav = createLocalizedPathnamesNavigation({
    locales: ["en", "de"],
    defaultLocale: "en",
    localePrefix: "always",
    pathnames: {
      "/about": "/about-page", // plain string entry (same path for all locales)
      "/x": { en: "/ex" }, // object missing "de" -> falls back to internal
    },
  } as Any);
  assertEquals(nav.getPathname({ href: "/about", locale: "en" }), "/en/about-page");
  assertEquals(nav.getPathname({ href: "/x", locale: "de" }), "/de/x");
});

Deno.test("getPathname interpolates catch-all params into a translated segment", () => {
  const nav = createLocalizedPathnamesNavigation({
    locales: ["en", "de"],
    defaultLocale: "en",
    localePrefix: "always",
    pathnames: {
      "/blog/[...slug]": { en: "/blog/[...slug]", de: "/artikel/[...slug]" },
    },
  });
  assertEquals(
    nav.getPathname({
      href: { pathname: "/blog/[...slug]", params: { slug: "a/b" } },
      locale: "de",
    }),
    "/de/artikel/a/b",
  );
});

Deno.test("createNavigation() with no config passes hrefs through (never mode)", () => {
  const nav = createNavigation();
  assertEquals(nav.getPathname({ href: "/anything" }), "/anything");
});

Deno.test("legacy aliases are the createNavigation factory", () => {
  assertEquals(createSharedPathnamesNavigation, createNavigation);
  assertEquals(createLocalizedPathnamesNavigation, createNavigation);
});

// ---- navigation.ts: redirect / permanentRedirect ---------------------------

Deno.test("redirect throws a RedirectError with the locale-prefixed target (string + object)", () => {
  const nav = createNavigation({
    locales: ["en", "fr"],
    defaultLocale: "en",
    localePrefix: "always",
  });
  // String target + explicit locale arg.
  let err: unknown;
  try {
    nav.redirect("/about", "fr");
  } catch (e) {
    err = e;
  }
  assert(err instanceof RedirectError);
  assertEquals((err as RedirectError).url, "/fr/about");
  assertEquals((err as RedirectError).status, 307);

  // Object target carrying its own locale.
  let err2: unknown;
  try {
    nav.redirect({ href: "/about", locale: "en" });
  } catch (e) {
    err2 = e;
  }
  assertEquals((err2 as RedirectError).url, "/en/about");

  // Object target with no locale -> the default locale.
  let err3: unknown;
  try {
    nav.redirect({ href: "/contact" });
  } catch (e) {
    err3 = e;
  }
  assertEquals((err3 as RedirectError).url, "/en/contact");
});

Deno.test("permanentRedirect issues a 308 to the prefixed target", () => {
  const nav = createNavigation({
    locales: ["en", "fr"],
    defaultLocale: "en",
    localePrefix: "always",
  });
  let err: unknown;
  try {
    nav.permanentRedirect("/about", "fr");
  } catch (e) {
    err = e;
  }
  assert(err instanceof RedirectError);
  assertEquals((err as RedirectError).url, "/fr/about");
});

// ---- navigation.ts: Link / usePathname / useRouter (SSR, in-provider) -------

Deno.test("Link honors an explicit locale prop over the active locale (SSR)", async () => {
  const nav = createNavigation({
    locales: ["en", "fr"],
    defaultLocale: "en",
    localePrefix: "always",
  });
  const html = await renderToString(
    h(NextIntlClientProvider as Any, {
      locale: "en",
      messages: {},
      // active locale is "en" but the Link asks for "fr".
      children: h(nav.Link as Any, { href: "/about", locale: "fr" }, "About"),
    }),
  );
  assertStringIncludes(html, 'href="/fr/about"');
});

Deno.test("usePathname + useRouter run inside a provider and return sane shapes (SSR)", async () => {
  const nav = createNavigation({
    locales: ["en", "fr"],
    defaultLocale: "en",
    localePrefix: "always",
  });
  function Probe() {
    const path = nav.usePathname();
    const router = nav.useRouter();
    return h("span", null, `${typeof path}:${typeof router.push}:${typeof router.replace}`);
  }
  const html = await renderToString(
    h(NextIntlClientProvider as Any, {
      locale: "fr",
      messages: {},
      children: h(Probe, null),
    }),
  );
  assertStringIncludes(html, "string:function:function");
});

// ---- server.ts: the no-loader defaults (run before any loader registration) -

Deno.test("server getters return safe defaults with no request-config loader", async () => {
  // No getRequestConfig has been called in this file yet: getLocale falls back to
  // "en", messages to {}, timeZone to undefined, now to a Date.
  assertEquals(await getLocale(), "en");
  assertEquals(await getMessages(), {});
  assertEquals(await getTimeZone(), undefined);
  assert((await getNow()) instanceof Date);
});

// ---- server.ts: with a registered loader -----------------------------------

Deno.test("getRequestConfig returns the loader unchanged and feeds the getters", async () => {
  const now = new Date("2026-01-02T03:04:05Z");
  const loader = ({ locale }: { locale?: string }) => ({
    locale: locale ?? "en",
    messages: { greetings: { hi: "Hi {name}" } },
    timeZone: "UTC",
    now,
  });
  const returned = getRequestConfig(loader);
  assertEquals(returned, loader);

  // getTranslations with a string arg (namespace) + explicit locale.
  const tNs = await getTranslations({ locale: "en", namespace: "greetings" });
  assertEquals(tNs("hi", { name: "Ada" }), "Hi Ada");
  // getTranslations with a bare namespace string.
  const tStr = await getTranslations("greetings");
  assertEquals(tStr("hi", { name: "Bo" }), "Hi Bo");
  // getTranslations with no argument -> root translator.
  const tRoot = await getTranslations();
  assertEquals(tRoot("greetings.hi", { name: "Cy" }), "Hi Cy");

  // getFormatter uses the configured timeZone and formats numbers/lists.
  const f = await getFormatter({ locale: "en" });
  assertEquals(f.number(1234.5, { minimumFractionDigits: 1 }), "1,234.5");
  assertEquals(f.list(["a", "b"]), "a and b");
  assertEquals(
    f.dateTime(now, { hour: "2-digit", minute: "2-digit", hour12: false }),
    new Intl.DateTimeFormat("en", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now),
  );

  // getMessages / getTimeZone / getNow read through the loader.
  assertEquals(await getMessages({ locale: "en" }), { greetings: { hi: "Hi {name}" } });
  assertEquals(await getTimeZone(), "UTC");
  assertEquals(await getNow(), now);
});

Deno.test("setRequestLocale scopes the active locale to the request context", async () => {
  getRequestConfig(({ locale }) => ({
    locale: locale ?? "en",
    messages: { greet: `hello-${locale}` } as Any,
  }));
  const result = await runWithContext(
    createRequestContext(new Request("https://x.test/de")),
    async () => {
      setRequestLocale("de");
      return await getLocale();
    },
  );
  assertEquals(result, "de");
  // The alias points at the same function.
  assertEquals(unstable_setRequestLocale, setRequestLocale);
});

// ---- index.ts re-exports ----------------------------------------------------

Deno.test("createTranslator / createFormatter build helpers outside React", () => {
  const t = createTranslator({
    locale: "en",
    namespace: "app",
    messages: { app: { title: "Welcome {who}" } },
  });
  assertEquals(t("title", { who: "there" }), "Welcome there");

  const f = createFormatter({ locale: "en", timeZone: "UTC" });
  assertEquals(f.number(0.5, { style: "percent" }), "50%");
  // relativeTime falls back to the config "now" when no reference is passed.
  const past = new Date(Date.now() - 3600_000);
  assertStringIncludes(f.relativeTime(past), "hour");
});
