// dangerouslySetInnerHTML: raw-HTML parity plus a dev-only XSS-sink warning, and
// correct client application (innerHTML, not a bogus attribute). denext emits the
// HTML raw like React; the warning (gated on __denextDev) nudges devs to sanitize.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { applyProps } from "../src/client/dom-props.ts";
import { FakeElement } from "./helpers/dom.ts";

function captureWarn(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void calls.push(args.join(" "));
  return { calls, restore: () => (console.warn = original) };
}

Deno.test("SSR emits dangerouslySetInnerHTML raw (React parity)", async () => {
  const html = await renderToString(
    h("div", { dangerouslySetInnerHTML: { __html: "<b>bold</b>" } }),
  );
  assertStringIncludes(html, "<b>bold</b>");
});

Deno.test("SSR warns about dangerouslySetInnerHTML only in dev", async () => {
  const g = globalThis as { __denextDev?: boolean };
  const node = h("div", { dangerouslySetInnerHTML: { __html: "<b>x</b>" } });

  // Dev off: no warning.
  delete g.__denextDev;
  let cap = captureWarn();
  try {
    await renderToString(node);
  } finally {
    cap.restore();
  }
  assertEquals(cap.calls.filter((m) => m.includes("dangerouslySetInnerHTML")).length, 0);

  // Dev on: exactly one warning naming the sink.
  g.__denextDev = true;
  cap = captureWarn();
  try {
    await renderToString(node);
  } finally {
    cap.restore();
    delete g.__denextDev;
  }
  const hits = cap.calls.filter((m) => m.includes("dangerouslySetInnerHTML"));
  assertEquals(hits.length, 1);
  assertStringIncludes(hits[0], "sanitize");
});

Deno.test("SSR warns about <iframe srcdoc> only in dev (Part C)", async () => {
  const g = globalThis as { __denextDev?: boolean };
  const node = h("iframe", { srcdoc: "<script>alert(1)</script>" });

  // Dev off: no warning, and the value is still attribute-escaped in the output.
  delete g.__denextDev;
  let cap = captureWarn();
  let html: string;
  try {
    html = await renderToString(node);
  } finally {
    cap.restore();
  }
  assertEquals(cap.calls.filter((m) => m.includes("srcdoc")).length, 0);
  assertStringIncludes(html, "&lt;script&gt;"); // escaped as an attribute value

  // Dev on: exactly one warning naming the sink.
  g.__denextDev = true;
  cap = captureWarn();
  try {
    await renderToString(node);
  } finally {
    cap.restore();
    delete g.__denextDev;
  }
  const hits = cap.calls.filter((m) => m.includes("srcdoc"));
  assertEquals(hits.length, 1);
  assertStringIncludes(hits[0], "XSS");

  // A non-iframe `srcdoc` prop does not warn (the sink is iframe-specific).
  g.__denextDev = true;
  cap = captureWarn();
  try {
    await renderToString(h("div", { srcdoc: "<b>x</b>" }));
  } finally {
    cap.restore();
    delete g.__denextDev;
  }
  assertEquals(cap.calls.filter((m) => m.includes("srcdoc")).length, 0);
});

// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement) => e as any;

Deno.test("client applies dangerouslySetInnerHTML as innerHTML, not an attribute", () => {
  const el = new FakeElement("div");
  applyProps(
    asEl(el),
    {},
    {},
    { dangerouslySetInnerHTML: { __html: "<span>hi</span>" } },
    () => {},
  );
  assertEquals(el.innerHTML, "<span>hi</span>");
  // The object must NOT leak out as a stringified attribute.
  assertEquals(el.getAttribute("dangerouslySetInnerHTML"), null);
  assertEquals(el.getAttribute("dangerouslysetinnerhtml"), null);
  assert(!el.outerHTML.includes("[object Object]"));
});

Deno.test("client clears innerHTML when dangerouslySetInnerHTML is removed", () => {
  const el = new FakeElement("div");
  const withHtml = { dangerouslySetInnerHTML: { __html: "<i>x</i>" } };
  applyProps(asEl(el), {}, {}, withHtml, () => {});
  assertEquals(el.innerHTML, "<i>x</i>");
  // Remove the prop → raw HTML is dropped.
  applyProps(asEl(el), {}, withHtml, {}, () => {});
  assertEquals(el.innerHTML, "");
});
