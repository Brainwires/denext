import { assertEquals } from "@std/assert";
import { matchSegments, parsePattern, parseSegment, specificity } from "../src/router/segments.ts";

Deno.test("parseSegment classifies each kind", () => {
  assertEquals(parseSegment("about").kind, "static");
  assertEquals(parseSegment("[slug]"), { kind: "dynamic", value: "slug" });
  assertEquals(parseSegment("[...rest]"), { kind: "catchAll", value: "rest" });
  assertEquals(parseSegment("[[...rest]]"), {
    kind: "optionalCatchAll",
    value: "rest",
  });
});

Deno.test("static route matches exactly", () => {
  const p = parsePattern("blog");
  assertEquals(matchSegments(p, "/blog"), {});
  assertEquals(matchSegments(p, "/blog/x"), null);
  assertEquals(matchSegments(p, "/other"), null);
});

Deno.test("root pattern matches root path", () => {
  const p = parsePattern("");
  assertEquals(matchSegments(p, "/"), {});
  assertEquals(matchSegments(p, "/x"), null);
});

Deno.test("dynamic segment captures a param", () => {
  const p = parsePattern("blog/[slug]");
  assertEquals(matchSegments(p, "/blog/hello"), { slug: "hello" });
  assertEquals(matchSegments(p, "/blog"), null);
  assertEquals(matchSegments(p, "/blog/a/b"), null);
});

Deno.test("dynamic segment url-decodes the value", () => {
  const p = parsePattern("u/[name]");
  assertEquals(matchSegments(p, "/u/a%20b"), { name: "a b" });
});

Deno.test("catch-all captures the remainder", () => {
  const p = parsePattern("docs/[...path]");
  assertEquals(matchSegments(p, "/docs/a/b/c"), { path: "a/b/c" });
  assertEquals(matchSegments(p, "/docs/a"), { path: "a" });
  // catch-all requires at least one segment
  assertEquals(matchSegments(p, "/docs"), null);
});

Deno.test("optional catch-all matches with and without segments", () => {
  const p = parsePattern("shop/[[...filters]]");
  assertEquals(matchSegments(p, "/shop"), {});
  assertEquals(matchSegments(p, "/shop/red/small"), { filters: "red/small" });
});

Deno.test("specificity orders static above dynamic above catch-all", () => {
  const staticP = specificity(parsePattern("blog/post"));
  const dynamicP = specificity(parsePattern("blog/[slug]"));
  const catchP = specificity(parsePattern("blog/[...rest]"));
  assertEquals(staticP > dynamicP, true);
  assertEquals(dynamicP > catchP, true);
});
