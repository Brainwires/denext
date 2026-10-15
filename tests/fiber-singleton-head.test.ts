// A root layout rendered by client code puts its `<title>` / `<meta>` / `<link>` in `<head>`. The
// server hoisted them into the document's head (beside the framework's own tags), so hydration
// adopts them there by match — as React hydrates hoistables — instead of re-creating them in the
// page container (which also warned of a mismatch); a later render keeps them in the head, and
// unmounting the layout takes them out of it.
import { assert, assertEquals } from "@std/assert";
import "./helpers/singleton-runtime.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, hydrateRoot, setDocument } from "../src/client/reconciler.ts";
import { useState } from "../src/runtime/hooks.ts";
import { FakeDocument } from "./helpers/dom.ts";
// deno-lint-ignore no-explicit-any
type Any = any;

/** The document a server render of `Layout` left: hoisted head tags among the framework's own. */
function serverPage() {
  const doc = new FakeDocument();
  setDocument(doc as Any);
  const add = (parent: Any, tag: string, attrs: Record<string, string>, text?: string) => {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text != null) el.appendChild(doc.createTextNode(text) as Any);
    parent.appendChild(el);
    return el;
  };
  add(doc.head, "meta", { charset: "utf-8" });
  add(doc.head, "link", { rel: "stylesheet", href: "/app.css" }); // the framework's own
  const title = add(doc.head, "title", {}, "Home");
  const desc = add(doc.head, "meta", { name: "description", content: "the home page" });
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  add(container, "p", {}, "hi");
  return { doc, container, title, desc };
}

let setTitle: (t: string) => void = () => {};
function Layout({ children }: { children?: Any }) {
  const [title, set] = useState("Home");
  setTitle = set;
  return h(
    "html",
    { lang: "en" },
    h(
      "head",
      null,
      h("title", null, title),
      h("meta", { name: "description", content: "the home page" }),
    ),
    h("body", null, children),
  );
}

const tags = (parent: Any, tag: string) =>
  (parent.childNodes as Any[]).filter((n) => n.tagName?.toLowerCase() === tag);

Deno.test("a client root layout's head tags hydrate in the head, not in the page container", () => {
  const { doc, container, title, desc } = serverPage();
  const warn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...a: unknown[]) => void warned.push(a);
  try {
    hydrateRoot(container as Any, h(Layout, null, h("p", null, "hi")));
    flushSync();
  } finally {
    console.warn = warn;
  }
  assertEquals(tags(container, "title"), [], "no <title> in the page container");
  assertEquals(tags(container, "meta"), []);
  assertEquals(tags(doc.head, "title"), [title], "the server's <title> is adopted, not duplicated");
  assertEquals(tags(doc.head, "meta").length, 2, "nor its <meta>");
  assert(tags(doc.head, "meta").includes(desc));
  assertEquals((container as Any).innerHTML, "<p>hi</p>", "the page content is untouched");
  assertEquals(warned, [], "no hydration mismatch");

  setTitle("Settings");
  flushSync();
  assertEquals(title.textContent, "Settings", "the adopted <title> updates in place");
  assertEquals(tags(doc.head, "title").length, 1);
});

Deno.test("a client root layout's head tags mount into the head, and leave it on unmount", () => {
  const doc = new FakeDocument();
  setDocument(doc as Any);
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const own = doc.createElement("link");
  own.setAttribute("rel", "stylesheet");
  doc.head.appendChild(own);
  const root = createRoot(container as Any);
  root.render(h(Layout, null, h("p", null, "x")));
  flushSync();
  assertEquals(tags(container, "title"), []);
  assertEquals(tags(doc.head, "title").length, 1);
  assertEquals(tags(doc.head, "title")[0].textContent, "Home");
  assertEquals(doc.head.childNodes[0], own, "the head's own tags stay first");
  root.unmount();
  flushSync();
  assertEquals(tags(doc.head, "title"), [], "unmounting the layout removes its head tags");
  assertEquals(doc.head.childNodes.length, 1, "and only those");
});
