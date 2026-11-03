// The next-intl ICU engine (src/compat/next-intl/icu.ts) beyond the common subset: nesting to
// MAX_ICU_DEPTH levels (an iterative parser and renderer, far past the recursive parser's 64), `selectordinal` with `#` / `=N` / `offset`, and the
// full set of number and date `::` skeleton tokens `Intl` can express — each checked against a
// direct `Intl` call so the assertions hold in any time zone and ICU version.

import { assertEquals, assertThrows } from "@std/assert";
import { formatIcu, MAX_ICU_DEPTH } from "../src/compat/next-intl/icu.ts";

const num = (n: number, o: Intl.NumberFormatOptions, locale = "en") =>
  new Intl.NumberFormat(locale, o).format(n);

Deno.test("ICU nesting: plural/select render to MAX_ICU_DEPTH levels (no stack), one more throws", () => {
  const depth = MAX_ICU_DEPTH;
  const deep = "{n, plural, other {".repeat(depth) + "x#" + "}}".repeat(depth);
  assertEquals(formatIcu(deep, { n: 3 }, "en"), "x3");
  const selects = "{g, select, a {".repeat(depth) + "deep" + "} other {no}}".repeat(depth);
  assertEquals(formatIcu(selects, { g: "a" }, "en"), "deep");
  // Every level's sibling branch counts at the same depth: the `other` branches here are fine.
  assertEquals(formatIcu(selects, { g: "b" }, "en"), "no");
  const over = "{n, plural, other {".repeat(depth + 1) + "x" + "}}".repeat(depth + 1);
  assertThrows(() => formatIcu(over, { n: 1 }, "en"), SyntaxError, "too deep");
  // Text around every level still renders in order.
  const framed = "<{n, plural, other {".repeat(50) + "#" + "}}>".repeat(50);
  assertEquals(formatIcu(framed, { n: 1 }, "en"), "<".repeat(50) + "1" + ">".repeat(50));
});

Deno.test("ICU nesting: plural → select → selectordinal → plural, each with its own #", () => {
  const msg = "{count, plural, offset:1 =0 {none} other {# more: {g, select, " +
    "female {she ranked {rank, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} " +
    "of {total, plural, one {# entry} other {# entries}}} other {# others}}}}";
  assertEquals(
    formatIcu(msg, { count: 3, g: "female", rank: 2, total: 5 }, "en"),
    "2 more: she ranked 2nd of 5 entries",
  );
  // A select keeps the enclosing plural's `#`.
  assertEquals(formatIcu(msg, { count: 4, g: "x", rank: 1, total: 1 }, "en"), "3 more: 3 others");
  assertEquals(formatIcu(msg, { count: 0, g: "x", rank: 1, total: 1 }, "en"), "none");
});

Deno.test("ICU selectordinal: English categories, =N first, offset, and other locales", () => {
  const msg = "{n, selectordinal, =0 {zeroth} one {#st} two {#nd} few {#rd} other {#th}}";
  const out = [0, 1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map((n) =>
    formatIcu(msg, { n }, "en")
  );
  assertEquals(out, [
    "zeroth",
    "1st",
    "2nd",
    "3rd",
    "4th",
    "11th",
    "12th",
    "13th",
    "21st",
    "22nd",
    "23rd",
    "101st",
    "111th",
  ]);
  // offset shifts the category and `#`; `=N` matches the raw value.
  const off = "{n, selectordinal, offset:1 =1 {first} one {#st} two {#nd} other {#th}}";
  assertEquals(formatIcu(off, { n: 1 }, "en"), "first");
  assertEquals(formatIcu(off, { n: 3 }, "en"), "2nd");
  // French: only 1 is `one` (1er), the rest `other`.
  const fr = "{n, selectordinal, one {#er} other {#e}}";
  assertEquals(formatIcu(fr, { n: 1 }, "fr"), "1er");
  assertEquals(formatIcu(fr, { n: 2 }, "fr"), "2e");
});

Deno.test("ICU number skeletons: units, widths and per-units", () => {
  const n = 12.5;
  assertEquals(
    formatIcu("{n, number, ::unit/kilometer-per-hour unit-width-full-name}", { n }, "en"),
    num(n, { style: "unit", unit: "kilometer-per-hour", unitDisplay: "long" }),
  );
  assertEquals(
    formatIcu("{n, number, ::measure-unit/length-meter unit-width-narrow}", { n }, "en"),
    num(n, { style: "unit", unit: "meter", unitDisplay: "narrow" }),
  );
  assertEquals(
    formatIcu("{n, number, ::measure-unit/length-meter per-measure-unit/duration-second}", {
      n,
    }, "en"),
    num(n, { style: "unit", unit: "meter-per-second" }),
  );
  assertEquals(
    formatIcu("{n, number, ::currency/EUR unit-width-iso-code}", { n }, "en"),
    num(n, { style: "currency", currency: "EUR", currencyDisplay: "code" }),
  );
  assertEquals(
    formatIcu("{n, number, ::currency/USD unit-width-full-name}", { n }, "en"),
    num(n, { style: "currency", currency: "USD", currencyDisplay: "name" }),
  );
});

Deno.test("ICU number skeletons: concise tokens", () => {
  assertEquals(formatIcu("{n, number, ::K}", { n: 12345 }, "en"), "12K");
  assertEquals(formatIcu("{n, number, ::KK}", { n: 12345 }, "en"), "12 thousand");
  assertEquals(formatIcu("{n, number, ::+!}", { n: 5 }, "en"), "+5");
  assertEquals(formatIcu("{n, number, ::+_}", { n: -5 }, "en"), "5");
  assertEquals(formatIcu("{n, number, ::+?}", { n: 0 }, "en"), "0");
  assertEquals(formatIcu("{n, number, ::,_}", { n: 12345 }, "en"), "12345");
  assertEquals(formatIcu("{n, number, ::.}", { n: 2.7 }, "en"), "3");
  assertEquals(formatIcu("{n, number, ::0000}", { n: 42 }, "en"), "0,042");
  assertEquals(formatIcu("{n, number, ::% .0}", { n: 0.256 }, "en"), "25.6%");
  assertEquals(formatIcu("{n, number, ::%x100}", { n: 0.25 }, "en"), "25%");
  assertEquals(
    formatIcu("{n, number, ::currency/USD ()}", { n: -3 }, "en"),
    num(-3, { style: "currency", currency: "USD", currencySign: "accounting" }),
  );
  assertEquals(
    formatIcu("{n, number, ::E0}", { n: 12345 }, "en"),
    num(12345, { notation: "scientific" }),
  );
  assertEquals(
    formatIcu("{n, number, ::EE0}", { n: 12345 }, "en"),
    num(12345, { notation: "engineering" }),
  );
});

Deno.test("ICU number skeletons: precision, rounding, scale and numbering systems", () => {
  assertEquals(formatIcu("{n, number, ::@@#}", { n: 1.23456 }, "en"), "1.23");
  assertEquals(formatIcu("{n, number, ::@@@}", { n: 1 }, "en"), "1.00");
  assertEquals(formatIcu("{n, number, ::.00+}", { n: 1.234567 }, "en"), "1.234567");
  assertEquals(formatIcu("{n, number, ::.00/w}", { n: 2 }, "en"), "2");
  assertEquals(formatIcu("{n, number, ::.00/w}", { n: 2.5 }, "en"), "2.50");
  assertEquals(formatIcu("{n, number, ::.##/@@@r}", { n: 1.23456 }, "en"), "1.23");
  assertEquals(formatIcu("{n, number, ::precision-increment/0.05}", { n: 1.23 }, "en"), "1.25");
  assertEquals(
    formatIcu("{n, number, ::precision-unlimited}", { n: 1.23456789 }, "en"),
    "1.23456789",
  );
  assertEquals(formatIcu("{n, number, ::. rounding-mode-floor}", { n: 2.9 }, "en"), "2");
  assertEquals(formatIcu("{n, number, ::. rounding-mode-ceiling}", { n: 2.1 }, "en"), "3");
  assertEquals(formatIcu("{n, number, ::.0 rounding-mode-half-even}", { n: 0.25 }, "en"), "0.2");
  assertEquals(formatIcu("{n, number, ::scale/1000}", { n: 1.5 }, "en"), "1,500");
  assertEquals(formatIcu("{n, number, ::integer-width/*000}", { n: 7 }, "en"), "007");
  assertEquals(
    formatIcu("{n, number, ::group-min2}", { n: 1234 }, "es"),
    num(1234, {
      // deno-lint-ignore no-explicit-any
      useGrouping: "min2" as any,
    }, "es"),
  );
  assertEquals(
    formatIcu("{n, number, ::numbering-system/arab}", { n: 123 }, "en"),
    num(123, { numberingSystem: "arab" }),
  );
  assertEquals(
    formatIcu("{n, number, ::latin}", { n: 123 }, "ar"),
    num(123, { numberingSystem: "latn" }, "ar"),
  );
  // A token with no Intl equivalent is ignored, as next-intl's formatter ignores it.
  assertEquals(formatIcu("{n, number, ::decimal-always}", { n: 4 }, "en"), "4");
});

Deno.test("ICU date skeletons: hour cycles, fractional seconds, day periods, zone styles", () => {
  const d = new Date(Date.UTC(2024, 2, 5, 0, 7, 9, 345));
  const fmt = (skel: string) =>
    // The skeleton is formatted in the host zone; compare against the same zone.
    formatIcu(`{d, time, ::${skel}}`, { d }, "en");
  const host = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en", o).format(d);
  assertEquals(fmt("Km"), host({ hour: "numeric", minute: "2-digit", hourCycle: "h11" }));
  assertEquals(fmt("km"), host({ hour: "numeric", minute: "2-digit", hourCycle: "h24" }));
  assertEquals(fmt("Hm"), host({ hour: "numeric", minute: "2-digit", hourCycle: "h23" }));
  assertEquals(
    fmt("msSSS"),
    host({ minute: "numeric", second: "numeric", fractionalSecondDigits: 3 }),
  );
  assertEquals(fmt("hB"), host({ hour: "numeric", hourCycle: "h12", dayPeriod: "short" }));
  assertEquals(
    fmt("hv"),
    host({ hour: "numeric", hourCycle: "h12", timeZoneName: "shortGeneric" }),
  );
  assertEquals(
    fmt("hOOOO"),
    host({ hour: "numeric", hourCycle: "h12", timeZoneName: "longOffset" }),
  );
  assertEquals(fmt("GGGGGy"), host({ era: "narrow", year: "numeric" }));
});

Deno.test("ICU date skeletons: a field Intl cannot render throws (never a partial date)", () => {
  const d = new Date(Date.UTC(2024, 2, 5));
  assertThrows(() => formatIcu("{d, date, ::yQQQ}", { d }, "en"), RangeError, "quarter");
  assertThrows(() => formatIcu("{d, date, ::yw}", { d }, "en"), RangeError, "week");
  assertThrows(() => formatIcu("{d, date, ::yD}", { d }, "en"), RangeError, "day-of-year");
});

Deno.test("ICU skeleton tokens: a long run of digits parses in linear time", () => {
  for (
    const message of [
      `{n, number, ::integer-width/${"0".repeat(100_000)}x}`,
      `{n, number, ::precision-increment/${"1".repeat(100_000)}x}`,
    ]
  ) {
    const start = performance.now();
    formatIcu(message, { n: 1 }, "en");
    const ms = performance.now() - start;
    // Linear is milliseconds; quadratic in 100k digits is many seconds. The bound sits between, far
    // enough from the first for a loaded machine's scheduling stalls (500 ms was not).
    assertEquals(ms < 2_000, true, `${message.slice(0, 40)}… took ${ms.toFixed(0)} ms`);
  }
  // A width Intl cannot express (over 21 digits) is ignored, not a RangeError.
  assertEquals(formatIcu(`{n, number, ::integer-width/${"0".repeat(22)}}`, { n: 5 }, "en"), "5");
});

Deno.test("ICU select / plural / values: Object.prototype names are ordinary keys", () => {
  const msg = "{g, select, male {M} other {O}}";
  for (const g of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    assertEquals(formatIcu(msg, { g }, "en"), "O", g);
  }
  // A branch named like a prototype key is chosen by its own value only.
  assertEquals(formatIcu("{g, select, constructor {C} other {O}}", { g: "constructor" }), "C");
  assertEquals(formatIcu("{g, select, __proto__ {P} other {O}}", { g: "x" }), "O");
  assertEquals(formatIcu("{g, select, __proto__ {P} other {O}}", { g: "__proto__" }), "P");
  // A simple argument missing from `values` stays a placeholder, prototype names included.
  assertEquals(formatIcu("{constructor}", {}, "en"), "{constructor}");
  assertEquals(formatIcu("{x, constructor}", { x: 1 }, "en"), "1");
});

Deno.test("ICU output: a `#` amplified through a plural branch is capped", () => {
  const msg = "{n, plural, other {" + "#".repeat(200_000) + "}}";
  assertThrows(() => formatIcu(msg, { n: 1e300 }, "en"), RangeError, "output too long");
});
