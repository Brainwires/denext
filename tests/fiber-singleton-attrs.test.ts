// A client root layout's `<html>`/`<body>` adopt the page's own elements (host singletons, see
// begin-work.ts). React clears a singleton's attributes when it unmounts, so a soft navigation
// from one root layout to another must not leave the first layout's classes on `<html>`.
import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { FakeDocument } from "./helpers/dom.ts";
// deno-lint-ignore no-explicit-any
type Any = any;

function page() {
  const doc = new FakeDocument();
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  setDocument(doc as Any);
  return { doc, container };
}

function LayoutA({ children }: { children?: Any }) {
  return h("html", { lang: "en", className: "theme-a" }, h("body", { "data-a": "1" }, children));
}
function LayoutB({ children }: { children?: Any }) {
  return h("html", { dir: "rtl" }, h("body", { className: "b" }, children));
}

Deno.test("singleton: switching root layouts clears the old layout's <html>/<body> attributes", () => {
  const { doc, container } = page();
  const root = createRoot(container as Any);
  root.render(h(LayoutA, null, h("p", null, "a")));
  flushSync();
  assertEquals(doc.documentElement.getAttribute("class"), "theme-a");
  assertEquals(doc.documentElement.getAttribute("lang"), "en");
  assertEquals(doc.body.getAttribute("data-a"), "1");

  root.render(h(LayoutB, null, h("p", null, "b")));
  flushSync();
  assertEquals(doc.documentElement.getAttribute("class"), null, "LayoutA's class is gone");
  assertEquals(doc.documentElement.getAttribute("lang"), null);
  assertEquals(doc.documentElement.getAttribute("dir"), "rtl");
  assertEquals(doc.body.getAttribute("data-a"), null);
  assertEquals(doc.body.getAttribute("class"), "b");
});

Deno.test("singleton: a layout sharing an attribute keeps the new value after the switch", () => {
  const { doc, container } = page();
  const root = createRoot(container as Any);
  const Dark = () => h("html", { className: "dark" }, h("body", null, "x"));
  const Light = () => h("html", { className: "light" }, h("body", null, "y"));
  root.render(h(Dark, null));
  flushSync();
  root.render(h(Light, null));
  flushSync();
  assertEquals(doc.documentElement.getAttribute("class"), "light");
});

Deno.test("singleton: unmounting the root clears the attributes and listeners it set", () => {
  const { doc, container } = page();
  const root = createRoot(container as Any);
  let clicks = 0;
  root.render(
    h("html", { className: "x" }, h("body", { onClick: () => clicks++, "data-b": "1" }, "z")),
  );
  flushSync();
  assertEquals(doc.body.getAttribute("data-b"), "1");
  root.unmount();
  flushSync();
  assertEquals(doc.documentElement.getAttribute("class"), null);
  assertEquals(doc.body.getAttribute("data-b"), null);
  (doc.body as Any).dispatch("click");
  assertEquals(clicks, 0, "the body listener is removed");
});
