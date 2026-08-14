// Dangerous URL scheme filtering (javascript:/vbscript:/executable data:).
// React only warns in dev; denext drops the value at the shared attribute
// chokepoint (`sanitizeUrlAttr`), so an untrusted href/src/formAction/action
// cannot execute script. Covers the unit matrix and SSR serialization; the
// client reconciler's `setAttribute` routes through the same function.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString, sanitizeUrlAttr } from "../src/jsx/render-to-string.ts";

Deno.test("sanitizeUrlAttr drops javascript:/vbscript: in any URL attribute", () => {
  const urlAttrs = ["href", "src", "formaction", "action", "poster", "cite", "ping", "data"];
  for (const attr of urlAttrs) {
    assertEquals(sanitizeUrlAttr("a", attr, "javascript:alert(1)"), null, attr);
    assertEquals(sanitizeUrlAttr("a", attr, "vbscript:msgbox(1)"), null, attr);
  }
});

Deno.test("sanitizeUrlAttr defeats whitespace/control-char scheme obfuscation", () => {
  assertEquals(sanitizeUrlAttr("a", "href", "  javascript:alert(1)"), null);
  assertEquals(sanitizeUrlAttr("a", "href", "java\tscript:alert(1)"), null);
  assertEquals(sanitizeUrlAttr("a", "href", "java\nscript:alert(1)"), null);
  assertEquals(sanitizeUrlAttr("a", "href", "javascript:alert(1)"), null);
  assertEquals(sanitizeUrlAttr("a", "href", "JaVaScRiPt:alert(1)"), null);
});

Deno.test("sanitizeUrlAttr keeps safe URLs and data: images", () => {
  assertEquals(sanitizeUrlAttr("a", "href", "https://example.com/x"), "https://example.com/x");
  assertEquals(sanitizeUrlAttr("a", "href", "/local/path"), "/local/path");
  assertEquals(sanitizeUrlAttr("a", "href", "#anchor"), "#anchor");
  assertEquals(sanitizeUrlAttr("a", "href", "mailto:x@y.z"), "mailto:x@y.z");
  // `datax:` is not the data: scheme — must not false-positive.
  assertEquals(sanitizeUrlAttr("a", "href", "datax:foo"), "datax:foo");
  // data:image/* in a media src/poster is legitimate and preserved.
  const dataImg = "data:image/png;base64,iVBORw0KGgo=";
  assertEquals(sanitizeUrlAttr("img", "src", dataImg), dataImg);
  assertEquals(sanitizeUrlAttr("video", "poster", dataImg), dataImg);
});

Deno.test("sanitizeUrlAttr drops executable data: (navigable / scripty contexts)", () => {
  const dataHtml = "data:text/html,<script>alert(1)</script>";
  assertEquals(sanitizeUrlAttr("a", "href", dataHtml), null); // navigation target
  assertEquals(sanitizeUrlAttr("form", "action", dataHtml), null); // submission target
  assertEquals(sanitizeUrlAttr("iframe", "src", dataHtml), null); // scripty tag
  assertEquals(sanitizeUrlAttr("object", "data", dataHtml), null); // scripty tag
  assertEquals(sanitizeUrlAttr("script", "src", "data:text/javascript,alert(1)"), null);
});

Deno.test("sanitizeUrlAttr ignores non-URL attributes", () => {
  assertEquals(sanitizeUrlAttr("div", "title", "javascript:noop"), "javascript:noop");
  assertEquals(sanitizeUrlAttr("div", "data-x", "javascript:noop"), "javascript:noop");
});

Deno.test("SSR drops a javascript: href but keeps the element", async () => {
  const html = await renderToString(h("a", { href: "javascript:alert(1)" }, "click"));
  assertEquals(html.includes("javascript:"), false);
  assertEquals(html.includes("href="), false);
  assertStringIncludes(html, ">click</a>");
});

Deno.test("SSR keeps a data:image/* src but drops a data:text/html iframe", async () => {
  const img = await renderToString(h("img", { src: "data:image/png;base64,iVBORw0KGgo=" }));
  assertStringIncludes(img, "data:image/png");

  const frame = await renderToString(
    h("iframe", { src: "data:text/html,<script>alert(1)</script>" }),
  );
  assert(!frame.includes("data:text/html"));
});

Deno.test("SSR drops a formAction javascript: on a button", async () => {
  const html = await renderToString(
    h("button", { formAction: "javascript:alert(1)" }, "go"),
  );
  assertEquals(html.includes("javascript:"), false);
  assertEquals(html.toLowerCase().includes("formaction="), false);
});
