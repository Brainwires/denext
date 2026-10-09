// Dangerous URL scheme filtering (javascript:/vbscript:/executable data:).
// React only warns in dev; denext drops the value at the shared attribute
// chokepoint (`sanitizeUrlAttr`), so an untrusted href/src/formAction/action
// cannot execute script. Covers the unit matrix and SSR serialization; the
// client reconciler's `setAttribute` routes through the same function.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString, sanitizeUrlAttr } from "../src/jsx/render-to-string.ts";
import { createRoot, setDocument } from "../src/client/reconciler.ts";
import { installDomPropWarnings } from "../src/client/dom-props.ts";
import { type FakeElement, makeDom } from "./helpers/dom.ts";

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
  assertEquals(sanitizeUrlAttr("a", "href", "\x01javascript:alert(1)"), null);
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

// ---- The client reconciler applies the same guard; its dev warnings ride installDevtools ----

/** Mount `<a href={href}>` + a raw-HTML `<div>` on the client; return the anchor + console.warn calls. */
function mountClient(href: string): { a: FakeElement; warnings: string[] } {
  const { doc, container } = makeDom();
  // deno-lint-ignore no-explicit-any
  setDocument(doc as any);
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    // deno-lint-ignore no-explicit-any
    createRoot(container as any).render(
      h(
        "p",
        null,
        h("a", { href }, "x"),
        h("div", { dangerouslySetInnerHTML: { __html: "<b>y</b>" } }),
      ),
    );
  } finally {
    console.warn = orig;
  }
  return { a: (container.childNodes[0] as FakeElement).childNodes[0] as FakeElement, warnings };
}

Deno.test("client: a javascript: href is dropped, a safe one kept", () => {
  assertEquals(mountClient("javascript:alert(1)").a.getAttribute("href"), null);
  assertEquals(mountClient("/ok").a.getAttribute("href"), "/ok");
});

Deno.test("client: dev warnings fire once the dev entry installs them (installDevtools)", () => {
  const g = globalThis as { __denextDev?: boolean };
  g.__denextDev = true;
  installDomPropWarnings();
  try {
    const { a, warnings } = mountClient("javascript:alert(1)");
    assertEquals(a.getAttribute("href"), null);
    assert(
      warnings.some((w) => w.includes("refused a dangerous URL in href")),
      warnings.join("\n"),
    );
    assert(
      warnings.some((w) => w.includes("dangerouslySetInnerHTML on <div>")),
      warnings.join("\n"),
    );
  } finally {
    installDomPropWarnings(false);
    delete g.__denextDev;
  }
});

Deno.test("client: no dev warning without the dev install (a production bundle)", () => {
  const g = globalThis as { __denextDev?: boolean };
  g.__denextDev = true; // even with the flag, an entry that never installed them stays silent
  try {
    const { a, warnings } = mountClient("javascript:alert(1)");
    assertEquals(a.getAttribute("href"), null);
    assertEquals(warnings, []);
  } finally {
    delete g.__denextDev;
  }
});
