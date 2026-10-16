// dangerouslySetInnerHTML in the reconciler (React parity): hydration ADOPTS the server's inner
// HTML as-is — the same nodes, never cleared or re-created — and a host whose content is raw
// HTML owns no reconciled children, so neither a fresh mount nor a later commit prunes the
// markup it injected. A real `__html` mismatch is reported and patched.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, hydrateRoot, setDocument } from "../src/client/reconciler.ts";
import { useState } from "../src/runtime/hooks.ts";
import { installHydrationWarning } from "../src/client/fiber/hydration.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

const HTML = "<b>hi</b><i>there</i>";
const raw = (html = HTML) => ({ dangerouslySetInnerHTML: { __html: html } });

/** The server's `<div id="raw"><b>hi</b><i>there</i></div>`, built as real child nodes. */
function serverRaw(doc: FakeDocument): { div: FakeElement; b: FakeElement; i: FakeElement } {
  const div = doc.createElement("div");
  div.setAttribute("id", "raw");
  const b = doc.createElement("b");
  b.appendChild(doc.createTextNode("hi"));
  const i = doc.createElement("i");
  i.appendChild(doc.createTextNode("there"));
  div.appendChild(b);
  div.appendChild(i);
  // The mismatch check parses `__html` into a shallow copy of the element.
  Object.assign(div, { cloneNode: () => doc.createElement("div") });
  return { div, b, i };
}

function kids(el: FakeElement): unknown[] {
  return (el as unknown as { childNodes: unknown[] }).childNodes;
}

Deno.test("hydration adopts a dangerouslySetInnerHTML host's server children (same nodes)", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const { div, b, i } = serverRaw(doc);
  container.appendChild(div);

  hydrateRoot(asEl(container), h("div", { id: "raw", ...raw() }));
  flushSync();

  assert(kids(container)[0] === div, "the host itself is adopted");
  assertEquals(kids(div).length, 2);
  assert(kids(div)[0] === b, "the server's <b> is kept, not re-created or removed");
  assert(kids(div)[1] === i, "the server's <i> is kept, not re-created or removed");
  assertEquals(div.innerHTML, HTML);
});

Deno.test("hydration keeps raw HTML beside a stateful sibling, and across its re-render", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const outer = doc.createElement("div");
  const { div, b } = serverRaw(doc);
  const span = doc.createElement("span");
  span.appendChild(doc.createTextNode("0"));
  outer.appendChild(div);
  outer.appendChild(span);
  container.appendChild(outer);

  let bump: () => void = () => {};
  function Counter(): VNode {
    const [n, setN] = useState(0);
    bump = () => setN((v) => v + 1);
    return h("span", null, String(n));
  }
  hydrateRoot(asEl(container), h("div", null, h("div", { id: "raw", ...raw() }), h(Counter, null)));
  flushSync();
  assert(kids(div)[0] === b);

  bump();
  flushSync();
  assertEquals(span.textContent, "1");
  assert(kids(div)[0] === b, "a sibling's update leaves the adopted markup alone");
  assertEquals(div.innerHTML, HTML);
});

Deno.test("hydration adopts raw HTML rendered by nested client components", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const wrap = doc.createElement("section");
  const { div, b, i } = serverRaw(doc);
  wrap.appendChild(div);
  container.appendChild(wrap);

  const Inner = (): VNode => h("div", { id: "raw", ...raw() });
  const Outer = (): VNode => h("section", null, h(Inner, null));
  hydrateRoot(asEl(container), h(Outer, null));
  flushSync();

  assert(kids(wrap)[0] === div);
  assert(kids(div)[0] === b && kids(div)[1] === i, "nested: same nodes");
});

Deno.test("hydration with a different __html reports a mismatch and patches", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const { div, b } = serverRaw(doc);
  container.appendChild(div);

  const warnings = withWarnings(() => {
    hydrateRoot(asEl(container), h("div", { id: "raw", ...raw("<u>new</u>") }));
    flushSync();
  });
  assertEquals(div.innerHTML, "<u>new</u>");
  assert(kids(div)[0] !== b);
  assertEquals(warnings.length, 1, warnings.join("\n"));
  assertStringIncludes(warnings[0], "hydration mismatch");
  assertStringIncludes(warnings[0], "dangerouslySetInnerHTML");
});

Deno.test("hydration: suppressHydrationWarning silences a raw HTML mismatch (still patched)", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const { div } = serverRaw(doc);
  container.appendChild(div);
  const warnings = withWarnings(() => {
    hydrateRoot(
      asEl(container),
      h("div", { id: "raw", suppressHydrationWarning: true, ...raw("<u>x</u>") }),
    );
    flushSync();
  });
  assertEquals(div.innerHTML, "<u>x</u>");
  assertEquals(warnings.length, 0, warnings.join("\n"));
});

Deno.test("a fresh client mount keeps the raw HTML it injected", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  createRoot(asEl(container)).render(h("div", null, h("p", raw())));
  flushSync();
  assertEquals(container.innerHTML, `<div><p>${HTML}</p></div>`);
});

Deno.test("a keyed move of a raw-HTML host keeps its markup", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const root = createRoot(asEl(container));
  const list = (order: string[]) =>
    h("ul", null, ...order.map((k) => h("li", { key: k, ...raw(`<b>${k}</b>`) })));
  root.render(list(["a", "b", "c"]));
  flushSync();
  root.render(list(["c", "a", "b"]));
  flushSync();
  assertEquals(container.innerHTML, "<ul><li><b>c</b></li><li><b>a</b></li><li><b>b</b></li></ul>");
});

Deno.test("switching between children and dangerouslySetInnerHTML (both ways)", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const root = createRoot(asEl(container));
  root.render(h("div", null, h("span", null, "kid")));
  flushSync();
  root.render(h("div", raw()));
  flushSync();
  assertEquals(container.innerHTML, `<div>${HTML}</div>`);
  root.render(h("div", raw("<u>2</u>")));
  flushSync();
  assertEquals(container.innerHTML, "<div><u>2</u></div>");
  root.render(h("div", null, h("span", null, "back")));
  flushSync();
  assertEquals(container.innerHTML, "<div><span>back</span></div>");
});

const devFlag = globalThis as { __denextDev?: boolean };

/** Run `fn` in dev with the hydration warning installed, collecting console.warn output. */
function withWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  devFlag.__denextDev = true;
  installHydrationWarning();
  try {
    fn();
  } finally {
    console.warn = original;
    delete devFlag.__denextDev;
    installHydrationWarning(false);
  }
  return warnings.filter((w) => w.includes("hydration"));
}

Deno.test("a re-render with a fresh { __html } of the same markup keeps the nodes", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const root = createRoot(asEl(container));
  root.render(h("div", { title: "1", ...raw() }));
  flushSync();
  const div = kids(container)[0] as FakeElement;
  const first = kids(div)[0];
  root.render(h("div", { title: "2", ...raw() }));
  flushSync();
  assertEquals(div.getAttribute("title"), "2");
  assert(kids(div)[0] === first, "an equal __html is not re-applied");
  root.render(h("div", { title: "2", ...raw("<u>3</u>") }));
  flushSync();
  assertEquals(div.innerHTML, "<u>3</u>");
});
