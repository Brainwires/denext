// Behavior tests for the next-intl signature-parity additions: createTranslator,
// createFormatter, hasLocale, IntlError/IntlErrorCode, initializeConfig, IntlProvider,
// useNow(options), and createNavigation() with no config.

import { assert, assertEquals } from "@std/assert";
import {
  createFormatter,
  createTranslator,
  hasLocale,
  initializeConfig,
  IntlError,
  IntlErrorCode,
  IntlProvider,
  NextIntlClientProvider,
} from "../src/compat/next-intl/index.ts";
import { createNavigation } from "../src/compat/next-intl/navigation.ts";

Deno.test("createTranslator builds a translator outside React", () => {
  const t = createTranslator({
    locale: "en",
    messages: { greeting: "Hello {name}" },
  });
  assertEquals(t("greeting", { name: "Ada" }), "Hello Ada");
});

Deno.test("createFormatter formats dateTime/number/list", () => {
  const f = createFormatter({ locale: "en-US", timeZone: "UTC" });
  assertEquals(f.number(1234.5, { maximumFractionDigits: 0 }), "1,235");
  assertEquals(f.list(["a", "b", "c"]), "a, b, and c");
  assert(f.dateTime(new Date("2026-01-02T00:00:00Z")).length > 0);
});

Deno.test("hasLocale is a type guard over the supported locales", () => {
  const locales = ["en", "de"] as const;
  assert(hasLocale(locales, "de"));
  assert(!hasLocale(locales, "fr"));
  assert(!hasLocale(locales, 123));
});

Deno.test("IntlError carries an IntlErrorCode + original message", () => {
  const err = new IntlError(IntlErrorCode.MISSING_MESSAGE, "greeting");
  assertEquals(err.code, IntlErrorCode.MISSING_MESSAGE);
  assertEquals(err.originalMessage, "greeting");
  assert(err instanceof Error);
});

Deno.test("initializeConfig fills messages default; IntlProvider aliases the client provider", () => {
  assertEquals(initializeConfig({ locale: "en" }).messages, {});
  assertEquals(IntlProvider, NextIntlClientProvider);
});

Deno.test("createNavigation() works with no config (unprefixed passthrough)", () => {
  const nav = createNavigation();
  assertEquals(typeof nav.Link, "function");
  assertEquals(typeof nav.usePathname, "function");
});
