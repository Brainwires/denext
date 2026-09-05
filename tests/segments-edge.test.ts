// Edge-case coverage for the route segment matcher and parsers (src/router/
// segments.ts): multi-dynamic patterns, catch-all vs optional-catch-all arity,
// URL-decoding, intercept/slot parsing, and specificity ordering — the details the
// base segments.test.ts doesn't drill into.

import { assert, assertEquals } from "@std/assert";
import {
  matchSegments,
  parseIntercept,
  parsePattern,
  parseSlot,
  specificity,
  splitPath,
} from "../src/router/segments.ts";

const match = (pattern: string, path: string) => matchSegments(parsePattern(pattern), path);

// --- matching -------------------------------------------------------------

Deno.test("matches multiple dynamic segments in one pattern", () => {
  assertEquals(match("a/[x]/b/[y]", "/a/1/b/2"), { x: "1", y: "2" });
});

Deno.test("a dynamic segment does not match across a slash", () => {
  assertEquals(match("a/[x]", "/a/1/2"), null);
  assertEquals(match("a/[x]", "/a"), null);
});

Deno.test("a dynamic segment URL-decodes its value", () => {
  assertEquals(match("user/[name]", "/user/ada%20lovelace"), { name: "ada lovelace" });
});

Deno.test("catch-all requires at least one segment", () => {
  assertEquals(match("files/[...path]", "/files/a/b/c"), { path: ["a", "b", "c"] });
  assertEquals(match("files/[...path]", "/files"), null, "zero trailing segments must not match");
});

Deno.test("optional catch-all matches with zero or many segments", () => {
  // Zero segments → the param is absent (not "").
  const zero = match("shop/[[...slug]]", "/shop");
  assert(zero !== null, "optional catch-all matches the bare path");
  assertEquals(zero!.slug, undefined);
  // Many segments → the param captures the remainder.
  assertEquals(match("shop/[[...slug]]", "/shop/a/b"), { slug: ["a", "b"] });
});

Deno.test("a static pattern matches only its exact path", () => {
  assertEquals(match("about", "/about"), {});
  assertEquals(match("about", "/about/team"), null);
});

Deno.test("the root pattern matches only the root path", () => {
  assertEquals(match("", "/"), {});
  assertEquals(match("", "/x"), null);
});

// --- parseIntercept -------------------------------------------------------

Deno.test("parseIntercept classifies (.)/(..)/(..)(..)/(...) markers", () => {
  assertEquals(parseIntercept("(.)photo"), { level: "same", name: "photo" });
  assertEquals(parseIntercept("(..)photo"), { level: 1, name: "photo" });
  assertEquals(parseIntercept("(..)(..)photo"), { level: 2, name: "photo" });
  assertEquals(parseIntercept("(...)photo"), { level: "root", name: "photo" });
});

Deno.test("parseIntercept returns null for a plain route group and a normal folder", () => {
  assertEquals(parseIntercept("(marketing)"), null);
  assertEquals(parseIntercept("photo"), null);
});

// --- parseSlot ------------------------------------------------------------

Deno.test("parseSlot extracts a named slot and ignores non-slots", () => {
  assertEquals(parseSlot("@modal"), "modal");
  assertEquals(parseSlot("photo"), null);
  assertEquals(parseSlot("@"), null); // bare @ is not a slot
});

// --- specificity ----------------------------------------------------------

Deno.test("specificity ranks static > dynamic > catch-all", () => {
  const stat = specificity(parsePattern("a/b"));
  const dyn = specificity(parsePattern("a/[x]"));
  const cat = specificity(parsePattern("a/[...x]"));
  assert(stat > dyn, "static beats dynamic");
  assert(dyn > cat, "dynamic beats catch-all");
});

// --- splitPath ------------------------------------------------------------

Deno.test("splitPath drops empty segments (leading/trailing/double slashes)", () => {
  assertEquals(splitPath("/a//b/"), ["a", "b"]);
  assertEquals(splitPath("/"), []);
});
