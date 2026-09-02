// Coverage for the compact ICU MessageFormat implementation (next-intl compat):
// interpolation, number/date/time, plural/select/selectordinal with offset and #,
// spellout/ordinal/duration, apostrophe escaping, and edge/fallback branches.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { formatIcu } from "../src/compat/next-intl/icu.ts";

Deno.test("plain interpolation and a missing value keep the placeholder", () => {
  assertEquals(formatIcu("Hello {name}!", { name: "Ada" }), "Hello Ada!");
  assertEquals(formatIcu("Hi {name}", {}), "Hi {name}", "missing simple arg keeps {name}");
});

Deno.test("number: named styles, integer, percent and empty for non-numeric", () => {
  assertEquals(formatIcu("{n, number, percent}", { n: 0.25 }, "en"), "25%");
  assertEquals(formatIcu("{n, number, integer}", { n: 3.9 }, "en"), "4");
  assertEquals(formatIcu("{n, number}", { n: "x" }, "en"), "", "non-numeric → empty");
  assertEquals(formatIcu("{n, number}", {}, "en"), "", "missing → empty");
});

Deno.test("number: :: skeletons — currency, fraction digits, compact, sign, group", () => {
  assertStringIncludes(formatIcu("{n, number, ::currency/USD}", { n: 5 }, "en"), "$5");
  assertEquals(formatIcu("{n, number, ::.00}", { n: 1.5 }, "en"), "1.50");
  assertStringIncludes(formatIcu("{n, number, ::compact-short}", { n: 12000 }, "en"), "12K");
  assertEquals(formatIcu("{n, number, ::sign-always}", { n: 3 }, "en"), "+3");
  assertEquals(formatIcu("{n, number, ::group-off}", { n: 12345 }, "en"), "12345");
  assertStringIncludes(formatIcu("{n, number, ::integer-width/000}", { n: 5 }, "en"), "005");
});

Deno.test("date/time: named buckets, :: field skeletons, and invalid dates", () => {
  const d = new Date(Date.UTC(2020, 0, 2, 3, 4, 5));
  assert(formatIcu("{d, date, short}", { d }, "en").length > 0);
  assert(formatIcu("{d, date, ::yMMMd}", { d }, "en").includes("2020"));
  assert(formatIcu("{d, time, short}", { d }, "en").length > 0);
  assertEquals(formatIcu("{d, date}", { d: "not-a-date" }, "en"), "", "invalid date → empty");
  assertEquals(formatIcu("{d, date}", {}, "en"), "", "missing → empty");
});

Deno.test("plural: category selection, exact =N, offset and the # substitution", () => {
  const msg = "{count, plural, =0 {none} one {# item} other {# items}}";
  assertEquals(formatIcu(msg, { count: 0 }, "en"), "none");
  assertEquals(formatIcu(msg, { count: 1 }, "en"), "1 item");
  assertEquals(formatIcu(msg, { count: 5 }, "en"), "5 items");

  const offset = "{count, plural, offset:1 one {you and # other} other {you and # others}}";
  assertEquals(formatIcu(offset, { count: 2 }, "en"), "you and 1 other");
  assertEquals(formatIcu(offset, { count: 4 }, "en"), "you and 3 others");

  // Non-numeric count → the `other` branch, no # value.
  assertEquals(
    formatIcu("{count, plural, other {many}}", { count: "x" }, "en"),
    "many",
  );
});

Deno.test("select and selectordinal", () => {
  const sel = "{g, select, male {he} female {she} other {they}}";
  assertEquals(formatIcu(sel, { g: "female" }, "en"), "she");
  assertEquals(formatIcu(sel, { g: "nonbinary" }, "en"), "they", "falls back to other");

  const ord = "{rank, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}";
  assertEquals(formatIcu(ord, { rank: 1 }, "en"), "1st");
  assertEquals(formatIcu(ord, { rank: 2 }, "en"), "2nd");
  assertEquals(formatIcu(ord, { rank: 3 }, "en"), "3rd");
  assertEquals(formatIcu(ord, { rank: 4 }, "en"), "4th");
});

Deno.test("spellout spells English integers, negatives and fractions", () => {
  assertEquals(formatIcu("{n, spellout}", { n: 0 }, "en"), "zero");
  assertEquals(formatIcu("{n, spellout}", { n: 21 }, "en"), "twenty-one");
  assertEquals(
    formatIcu("{n, spellout}", { n: 1234 }, "en"),
    "one thousand two hundred thirty-four",
  );
  assertEquals(formatIcu("{n, spellout}", { n: -5 }, "en"), "minus five");
  assertEquals(formatIcu("{n, spellout}", { n: 1.5 }, "en"), "one point five");
  // Non-English falls back to the localized numeral.
  assertEquals(formatIcu("{n, spellout}", { n: 5 }, "fr"), "5");
  assertEquals(formatIcu("{n, spellout}", {}, "en"), "", "missing → empty");
});

Deno.test("ordinal produces English suffixes and a plain numeral for other locales", () => {
  assertEquals(formatIcu("{n, ordinal}", { n: 1 }, "en"), "1st");
  assertEquals(formatIcu("{n, ordinal}", { n: 22 }, "en"), "22nd");
  assertEquals(formatIcu("{n, ordinal}", { n: 2 }, "fr"), "2", "non-English → numeral only");
  assertEquals(formatIcu("{n, ordinal}", {}, "en"), "");
});

Deno.test("duration formats seconds as H:MM:SS and handles negatives", () => {
  assertEquals(formatIcu("{s, duration}", { s: 3661 }, "en"), "1:01:01");
  assertStringIncludes(formatIcu("{s, duration}", { s: -61 }, "en"), "-");
  assertEquals(formatIcu("{s, duration}", { s: "x" }, "en"), "", "non-numeric → empty");
  assertEquals(formatIcu("{s, duration}", {}, "en"), "");
});

Deno.test("apostrophe escaping: '' → ', quoted syntax chars, and quoted #", () => {
  assertEquals(formatIcu("it''s", {}, "en"), "it's");
  assertEquals(formatIcu("'{'not an arg'}'", {}, "en"), "{not an arg}");
  // A quoted # inside a plural is a literal #, not the count.
  assertEquals(
    formatIcu("{n, plural, other {'#' and #}}", { n: 3 }, "en"),
    "# and 3",
  );
  // A lone apostrophe before a non-syntax char stays literal.
  assertEquals(formatIcu("o'clock", {}, "en"), "o'clock");
});

Deno.test("unknown arg type falls back to the raw value; nested submessages render", () => {
  assertEquals(formatIcu("{x, bogus}", { x: "raw" }, "en"), "raw");
  assertEquals(formatIcu("{x, bogus}", {}, "en"), "");
  const nested =
    "{count, plural, one {{g, select, male {his} other {their}} item} other {# items}}";
  assertEquals(formatIcu(nested, { count: 1, g: "male" }, "en"), "his item");
});

Deno.test("a pathologically deep message is rejected (stack-overflow guard)", () => {
  const deep = "{n, plural, other {".repeat(70) + "x" + "}}".repeat(70);
  assertThrows(() => formatIcu(deep, { n: 1 }, "en"), Error, "nesting too deep");
});

Deno.test("the parse cache serves repeated messages (same output on re-format)", () => {
  const msg = "Hello {name}";
  assertEquals(formatIcu(msg, { name: "A" }, "en"), "Hello A");
  assertEquals(
    formatIcu(msg, { name: "B" }, "en"),
    "Hello B",
    "cached AST re-renders with new values",
  );
});
