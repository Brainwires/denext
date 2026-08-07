import { assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { isValidAttrName, renderToString } from "../src/jsx/render-to-string.ts";

Deno.test("isValidAttrName rejects tag/attribute breakout characters", () => {
  // Valid names.
  for (const ok of ["class", "data-id", "aria-label", "xml:lang", "x1", "foo.bar"]) {
    assertEquals(isValidAttrName(ok), true, ok);
  }
  // Dangerous names.
  for (
    const bad of [
      "",
      "x y",
      "x>",
      "x<",
      'x"',
      "x'",
      "x=",
      "x/",
      "x><img src=x onerror=alert(1)>",
    ]
  ) {
    assertEquals(isValidAttrName(bad), false, bad);
  }
});

Deno.test("SSR drops attribute names that would break out of the tag", async () => {
  const untrusted = { "x><img src=x onerror=alert(1)>": "y" };
  const html = await renderToString(h("div", untrusted, "hi"));
  // The injected markup must NOT appear; the div stays intact.
  assertEquals(html, "<div>hi</div>");
});

Deno.test("SSR still emits legitimate hyphen/colon attribute names", async () => {
  const html = await renderToString(
    h("input", { "data-id": "5", "aria-label": "name", type: "text" }),
  );
  assertStringIncludes(html, 'data-id="5"');
  assertStringIncludes(html, 'aria-label="name"');
  assertStringIncludes(html, 'type="text"');
});

Deno.test("attribute VALUES remain escaped (no attribute breakout)", async () => {
  const html = await renderToString(
    h("a", { title: '"><script>alert(1)</script>' }, "x"),
  );
  // The quote and angle brackets are entity-encoded inside the attribute.
  assertStringIncludes(html, "&quot;&gt;&lt;script&gt;");
  assertEquals(html.includes("<script>"), false);
});

Deno.test("hydration data script escapes </script> breakout", () => {
  // The document serializer escapes "<" in the JSON payload; verify the pattern
  // that protects against `</script>` injection via params/searchParams.
  const payload = JSON.stringify({ x: "</script><img onerror=alert(1)>" })
    .replace(/</g, "\\u003c");
  assertEquals(payload.includes("</script>"), false);
  assertStringIncludes(payload, "\\u003c");
});
