// Unit coverage for next-intl routing (routing.ts): defineRouting normalization
// and detectLocale's cookie → Accept-Language → default precedence.

import { assertEquals } from "@std/assert";
import { defineRouting, detectLocale } from "../src/compat/next-intl/routing.ts";

Deno.test("defineRouting normalizes localePrefix and cookie config", () => {
  const basic = defineRouting({ locales: ["en", "fr"], defaultLocale: "en" });
  assertEquals(basic.localePrefixMode, "always"); // default
  assertEquals(basic.cookieName, "NEXT_LOCALE"); // default cookie

  const obj = defineRouting({
    locales: ["en", "fr"],
    defaultLocale: "en",
    localePrefix: { mode: "as-needed" },
    localeCookie: { name: "lang" },
  });
  assertEquals(obj.localePrefixMode, "as-needed");
  assertEquals(obj.cookieName, "lang");

  const noCookie = defineRouting({
    locales: ["en"],
    defaultLocale: "en",
    localeCookie: false,
  });
  assertEquals(noCookie.cookieName, "");
});

Deno.test("detectLocale prefers a valid locale cookie", () => {
  const routing = defineRouting({ locales: ["en", "fr"], defaultLocale: "en" });
  const req = new Request("http://x/", {
    headers: { cookie: "NEXT_LOCALE=fr", "accept-language": "en" },
  });
  assertEquals(detectLocale(req, routing), "fr");
});

Deno.test("detectLocale ignores an invalid cookie and falls to Accept-Language", () => {
  const routing = defineRouting({ locales: ["en", "fr"], defaultLocale: "en" });
  const req = new Request("http://x/", {
    headers: { cookie: "NEXT_LOCALE=zz", "accept-language": "fr-FR,fr;q=0.9" },
  });
  assertEquals(detectLocale(req, routing), "fr"); // matches base tag `fr`
});

Deno.test("detectLocale falls back to the default locale", () => {
  const routing = defineRouting({ locales: ["en", "fr"], defaultLocale: "en" });
  const req = new Request("http://x/", { headers: { "accept-language": "de,es;q=0.8" } });
  assertEquals(detectLocale(req, routing), "en");
});

Deno.test("detectLocale honors localeDetection:false (always default)", () => {
  const routing = defineRouting({
    locales: ["en", "fr"],
    defaultLocale: "en",
    localeDetection: false,
  });
  const req = new Request("http://x/", {
    headers: { cookie: "NEXT_LOCALE=fr", "accept-language": "fr" },
  });
  assertEquals(detectLocale(req, routing), "en");
});
