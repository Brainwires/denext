// React parity for where the client reconciler creates nodes and which URL attributes it
// keeps:
//
// - Nodes rendered under a portal are created in the PORTAL CONTAINER's `ownerDocument`
//   (an iframe's or popup's document), as React does — not the root's.
// - An empty `src`/`href` is removed, except `<a href="">` (a "reload" link React keeps);
//   a boolean `src`/`href` is removed too (React 19 `setProp`).

import { assertEquals, assertStrictEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createPortal, createRoot, flushSync } from "../src/client/reconciler.ts";
import { useState } from "../src/runtime/hooks.ts";
import { type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

/** Record which document created each element / text node. */
function trackCreation(doc: ReturnType<typeof makeDom>["doc"], label: string, log: string[]) {
  const el = doc.createElement.bind(doc);
  const text = doc.createTextNode.bind(doc);
  doc.createElement = (tag: string) => (log.push(`${label}:${tag}`), el(tag));
  doc.createTextNode = (value: string) => (log.push(`${label}:#${value}`), text(value));
}

Deno.test("nodes under a portal are created in the portal container's document", () => {
  const main = makeDom();
  const frame = makeDom(); // a second document (an iframe's / a popup's)
  const log: string[] = [];
  trackCreation(main.doc, "main", log);
  trackCreation(frame.doc, "frame", log);
  createRoot(asEl(main.container)).render(
    h(
      "div",
      null,
      h("b", null),
      createPortal(h("section", null, h("i", null, "in-frame")), asEl(frame.container)),
    ),
  );
  assertEquals(frame.container.innerHTML, "<section><i>in-frame</i></section>");
  assertEquals(main.container.innerHTML, "<div><b></b></div>");
  assertEquals(
    log.filter((l) => l.startsWith("frame:")).sort(),
    ["frame:#in-frame", "frame:i", "frame:section"],
  );
  assertEquals(log.filter((l) => l.startsWith("main:")).sort(), ["main:b", "main:div"]);
  assertStrictEquals(asEl(frame.container).childNodes[0].ownerDocument, frame.doc);
});

Deno.test("a node mounted later under a cross-document portal still uses the portal's document", () => {
  const main = makeDom();
  const frame = makeDom();
  let show: (v: boolean) => void = () => {};
  function App() {
    const [on, set] = useState(false);
    show = set;
    return h(
      "div",
      null,
      createPortal(on ? h("p", null, "late") : null, asEl(frame.container)),
      on ? h("span", null) : null,
    );
  }
  createRoot(asEl(main.container)).render(h(App, null));
  const log: string[] = [];
  trackCreation(main.doc, "main", log);
  trackCreation(frame.doc, "frame", log);
  flushSync(() => show(true));
  assertEquals(frame.container.innerHTML, "<p>late</p>");
  assertEquals(log.sort(), ["frame:#late", "frame:p", "main:span"]);
});

Deno.test("client: an empty src/href is removed except <a href>, as React's setProp does", () => {
  const { container } = makeDom();
  let set: (v: string | boolean) => void = () => {};
  function Links() {
    const [url, s] = useState<string | boolean>("");
    set = s;
    return h(
      "div",
      null,
      h("a", { href: url }, "reload"),
      h("img", { src: url }),
      h("link", { href: url }),
    );
  }
  createRoot(asEl(container)).render(h(Links, null));
  assertEquals(container.innerHTML, '<div><a href="">reload</a><img></img><link></link></div>');
  flushSync(() => set("/x"));
  assertEquals(
    container.innerHTML,
    '<div><a href="/x">reload</a><img src="/x"></img><link href="/x"></link></div>',
  );
  flushSync(() => set(""));
  assertEquals(container.innerHTML, '<div><a href="">reload</a><img></img><link></link></div>');
  // A boolean URL is never an attribute (React removes it).
  flushSync(() => set(true));
  assertEquals(container.innerHTML, "<div><a>reload</a><img></img><link></link></div>");
});
