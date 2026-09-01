import { assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import {
  detectLocale,
  type I18nConfig,
  localeHref,
  localeMiddleware,
  parseAcceptLanguage,
  peelLocale,
} from "../src/server/i18n.ts";
import { createMiddlewareRunner } from "../src/server/middleware.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { PageProps } from "../src/server/types.ts";

const I18N: I18nConfig = { locales: ["en", "fr", "de"], defaultLocale: "en" };

Deno.test("peelLocale strips a configured locale prefix", () => {
  assertEquals(peelLocale("/about", I18N), { locale: "en", rest: "/about" });
  assertEquals(peelLocale("/fr/about", I18N), { locale: "fr", rest: "/about" });
  assertEquals(peelLocale("/fr", I18N), { locale: "fr", rest: "/" });
  assertEquals(peelLocale("/", I18N), { locale: "en", rest: "/" });
  // Unknown first segment is not a locale -> default + unchanged path.
  assertEquals(peelLocale("/de/nope", I18N), { locale: "de", rest: "/nope" });
  assertEquals(peelLocale("/xx/page", I18N), { locale: "en", rest: "/xx/page" });
});

Deno.test("peelLocale is a no-op without config", () => {
  assertEquals(peelLocale("/fr/about", undefined), { locale: "", rest: "/fr/about" });
});

Deno.test("localeHref is the inverse of peelLocale (default unprefixed)", () => {
  assertEquals(localeHref("en", "/about", I18N), "/about"); // default: unprefixed
  assertEquals(localeHref("fr", "/about", I18N), "/fr/about");
  assertEquals(localeHref("de", "/", I18N), "/de"); // root doesn't become "/de/"
  assertEquals(localeHref("en", "/", I18N), "/");
});

Deno.test("parseAcceptLanguage orders by quality", () => {
  assertEquals(parseAcceptLanguage("fr-CA,fr;q=0.9,en;q=0.8"), ["fr-ca", "fr", "en"]);
  assertEquals(parseAcceptLanguage(null), []);
});

Deno.test("detectLocale prefers cookie, then Accept-Language", () => {
  const withCookie = new Request("http://x/", {
    headers: { cookie: "NEXT_LOCALE=de", "accept-language": "fr" },
  });
  assertEquals(detectLocale(withCookie, I18N), "de");

  const withHeader = new Request("http://x/", {
    headers: { "accept-language": "fr-CA,fr;q=0.9" },
  });
  assertEquals(detectLocale(withHeader, I18N), "fr");

  const none = new Request("http://x/");
  assertEquals(detectLocale(none, I18N), "en");
});

// ---- App-level routing -----------------------------------------------------

function manifest(): RouteManifest {
  return {
    pages: [
      {
        kind: "page",
        pattern: parsePattern("about"),
        routePath: "/about",
        filePath: "about.tsx",
        layoutChain: [],
        loading: null,
        error: null,
        notFound: null,
        forbidden: null,
        unauthorized: null,
        templateChain: [],
      },
      {
        kind: "page",
        pattern: parsePattern(""),
        routePath: "/",
        filePath: "home.tsx",
        layoutChain: [],
        loading: null,
        error: null,
        notFound: null,
        forbidden: null,
        unauthorized: null,
        templateChain: [],
      },
    ],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
}

const modules: Record<string, unknown> = {
  "about.tsx": { default: (p: PageProps) => h("h1", null, `about:${p.params.locale}`) },
  "home.tsx": { default: (p: PageProps) => h("h1", null, `home:${p.params.locale}`) },
};

function app() {
  return createApp({
    getManifest: manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    i18n: I18N,
  });
}

Deno.test("unprefixed path routes to the default locale", async () => {
  const res = await app()(new Request("http://localhost/about"));
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), "about:en");
});

Deno.test("locale-prefixed path routes with that locale in params", async () => {
  const res = await app()(new Request("http://localhost/fr/about"));
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), "about:fr");
});

Deno.test("bare / still matches under the default locale", async () => {
  const res = await app()(new Request("http://localhost/"));
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), "home:en");
});

Deno.test("locale-prefixed root (/de) matches the home route", async () => {
  const res = await app()(new Request("http://localhost/de"));
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), "home:de");
});

// ---- automatic hreflang ----------------------------------------------------

Deno.test("i18n auto-emits hreflang alternates + x-default for every locale", async () => {
  const html = await (await app()(new Request("http://localhost/fr/about"))).text();
  // Default locale is unprefixed; others are prefixed.
  assertStringIncludes(html, `<link rel="alternate" hreflang="en" href="http://localhost/about">`);
  assertStringIncludes(
    html,
    `<link rel="alternate" hreflang="fr" href="http://localhost/fr/about">`,
  );
  assertStringIncludes(
    html,
    `<link rel="alternate" hreflang="de" href="http://localhost/de/about">`,
  );
  // x-default points at the default-locale URL.
  assertStringIncludes(
    html,
    `<link rel="alternate" hreflang="x-default" href="http://localhost/about">`,
  );
  // Canonical is the current locale's URL (fr here).
  assertStringIncludes(html, `<link rel="canonical" href="http://localhost/fr/about">`);
});

Deno.test("hreflang:false opts out of automatic alternates", async () => {
  const optOut = createApp({
    getManifest: manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    i18n: { ...I18N, hreflang: false },
  });
  const html = await (await optOut(new Request("http://localhost/fr/about"))).text();
  assertEquals(html.includes(`rel="alternate" hreflang=`), false);
});

Deno.test("a page's own alternates.languages wins over the generated set", async () => {
  const custom: Record<string, unknown> = {
    "about.tsx": {
      default: (p: PageProps) => h("h1", null, `about:${p.params.locale}`),
      metadata: { alternates: { languages: { en: "https://cdn.example/en/about" } } },
    },
  };
  const withCustom = createApp({
    getManifest: manifest,
    load: (fp) => Promise.resolve(custom[fp]),
    i18n: I18N,
  });
  const html = await (await withCustom(new Request("http://localhost/fr/about"))).text();
  // Author value is used verbatim; the generated fr/de entries are NOT added.
  assertStringIncludes(html, `hreflang="en" href="https://cdn.example/en/about"`);
  assertEquals(html.includes(`hreflang="de"`), false);
});

// ---- domain-based locale routing (i18n.domains) ----------------------------

const DOMAINS: I18nConfig = {
  locales: ["en", "fr", "de"],
  defaultLocale: "en",
  domains: [
    { domain: "example.fr", defaultLocale: "fr" },
    { domain: "example.com", defaultLocale: "en" },
  ],
};

function domainApp() {
  return createApp({
    getManifest: manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    i18n: DOMAINS,
  });
}

Deno.test("i18n domains: peelLocale uses the host's default locale for an unprefixed path", () => {
  assertEquals(peelLocale("/about", DOMAINS, "example.fr"), { locale: "fr", rest: "/about" });
  assertEquals(peelLocale("/about", DOMAINS, "example.com"), { locale: "en", rest: "/about" });
  // Case-insensitive, port-stripped.
  assertEquals(peelLocale("/about", DOMAINS, "EXAMPLE.FR:3000").locale, "fr");
  // An explicit prefix still wins over the domain default.
  assertEquals(peelLocale("/de/about", DOMAINS, "example.fr"), { locale: "de", rest: "/about" });
  // An unknown host falls back to the global default locale.
  assertEquals(peelLocale("/about", DOMAINS, "other.test"), { locale: "en", rest: "/about" });
  // No host given → global default (no domain awareness).
  assertEquals(peelLocale("/about", DOMAINS).locale, "en");
});

Deno.test("i18n domains: localeHref produces absolute cross-host URLs (for hreflang)", () => {
  assertEquals(localeHref("fr", "/about", DOMAINS), "https://example.fr/about");
  assertEquals(localeHref("en", "/about", DOMAINS), "https://example.com/about");
  // A domain root path drops the trailing slash.
  assertEquals(localeHref("fr", "/", DOMAINS), "https://example.fr");
});

Deno.test("i18n domains: an unprefixed request renders the host's default locale (no redirect)", async () => {
  const fr = await domainApp()(new Request("http://example.fr/about"));
  assertEquals(fr.status, 200);
  assertStringIncludes(await fr.text(), "about:fr");

  const en = await domainApp()(new Request("http://example.com/about"));
  assertEquals(en.status, 200);
  assertStringIncludes(await en.text(), "about:en");
});

Deno.test("i18n domains: hreflang alternates cross hosts", async () => {
  const html = await (await domainApp()(new Request("http://example.fr/about"))).text();
  assertStringIncludes(html, `hreflang="fr" href="https://example.fr/about"`);
  assertStringIncludes(html, `hreflang="en" href="https://example.com/about"`);
});

Deno.test("i18n domains: localeMiddleware never redirects an unprefixed path on a domain", async () => {
  const runner = createMiddlewareRunner({ default: localeMiddleware(DOMAINS) });
  // On example.fr, an English-preferring visitor is NOT redirected — the host is French.
  const outcome = await runner!(
    new Request("http://example.fr/about", { headers: { "accept-language": "en" } }),
  );
  assertEquals(outcome.type, "next");
});

// ---- localeMiddleware ------------------------------------------------------

Deno.test("localeMiddleware redirects to a detected non-default locale", async () => {
  const runner = createMiddlewareRunner({ default: localeMiddleware(I18N) });
  const outcome = await runner!(
    new Request("http://localhost/about", { headers: { "accept-language": "fr" } }),
  );
  assertEquals(outcome.type, "response");
  if (outcome.type === "response") {
    assertEquals(outcome.response.status, 307);
    assertEquals(outcome.response.headers.get("location"), "/fr/about");
    await outcome.response.body?.cancel();
  }
});

Deno.test("localeMiddleware leaves default-locale and prefixed paths alone", async () => {
  const runner = createMiddlewareRunner({ default: localeMiddleware(I18N) });
  // Default locale visitor: no redirect.
  const en = await runner!(
    new Request("http://localhost/about", { headers: { "accept-language": "en" } }),
  );
  assertEquals(en.type, "next");
  // Already prefixed: no redirect even with a different preference.
  const already = await runner!(
    new Request("http://localhost/fr/about", { headers: { "accept-language": "de" } }),
  );
  assertEquals(already.type, "next");
});

// ---- localePrefix: "always" ------------------------------------------------

const I18N_ALWAYS: I18nConfig = { ...I18N, localePrefix: "always" };

Deno.test('localePrefix "always": localeHref prefixes the default locale too', () => {
  assertEquals(localeHref("en", "/about", I18N_ALWAYS), "/en/about"); // default IS prefixed
  assertEquals(localeHref("fr", "/about", I18N_ALWAYS), "/fr/about");
  assertEquals(localeHref("en", "/", I18N_ALWAYS), "/en");
});

Deno.test('localePrefix "always": an unprefixed path redirects to the default locale prefix', async () => {
  const runner = createMiddlewareRunner({ default: localeMiddleware(I18N_ALWAYS) });
  // Even a default-locale visitor is redirected to a prefixed URL.
  const en = await runner!(
    new Request("http://localhost/about", { headers: { "accept-language": "en" } }),
  );
  assertEquals(en.type, "response");
  if (en.type === "response") {
    assertEquals(en.response.status, 307);
    assertEquals(en.response.headers.get("location"), "/en/about");
    await en.response.body?.cancel();
  }
  // A non-default preference still redirects to that locale's prefix.
  const fr = await runner!(
    new Request("http://localhost/about", { headers: { "accept-language": "fr" } }),
  );
  assertEquals(fr.type, "response");
  if (fr.type === "response") {
    assertEquals(fr.response.headers.get("location"), "/fr/about");
    await fr.response.body?.cancel();
  }
  // An already-prefixed path is left alone.
  const already = await runner!(new Request("http://localhost/en/about"));
  assertEquals(already.type, "next");
});
