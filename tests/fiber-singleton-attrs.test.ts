// A client root layout's `<html>`/`<body>` adopt the page's own elements (host singletons, see
// begin-work.ts). React clears a singleton's attributes when it unmounts, so a soft navigation
// from one root layout to another must not leave the first layout's classes on `<html>`.
import { assertEquals } from "@std/assert";
import "./helpers/singleton-runtime.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, hydrateRoot, setDocument } from "../src/client/reconciler.ts";
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

// ---- Hydration and script-set attributes (React's singleton semantics) -----------------------

/** A server-rendered page: `<p>hi</p>` in the container, `attrs` on the real `<html>`. */
function serverPage(attrs: Record<string, string>) {
  const { doc, container } = page();
  for (const [k, v] of Object.entries(attrs)) doc.documentElement.setAttribute(k, v);
  const p = doc.createElement("p");
  p.appendChild(doc.createTextNode("hi") as Any);
  container.appendChild(p);
  return { doc, container };
}

const tokens = (el: Any) =>
  new Set(String(el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));

Deno.test("singleton hydration: a pre-hydration script's class (next-themes) survives", () => {
  // next-themes' inline script runs before hydration and adds the theme to <html>: the layout
  // renders `<html className="font-sans" suppressHydrationWarning>`, the page holds
  // `class="font-sans dark"`. Hydration must not write the layout's props over it.
  const { doc, container } = serverPage({
    lang: "en",
    class: "font-sans dark",
    style: "color-scheme: dark",
  });
  hydrateRoot(
    container as Any,
    h(
      "html",
      { lang: "en", className: "font-sans", suppressHydrationWarning: true },
      h("body", null, h("p", null, "hi")),
    ),
  );
  flushSync();
  assertEquals(tokens(doc.documentElement), new Set(["font-sans", "dark"]));
  assertEquals(doc.documentElement.getAttribute("style"), "color-scheme: dark");
  assertEquals(doc.documentElement.getAttribute("lang"), "en");
});

Deno.test("singleton hydration: props that already match are not re-applied", () => {
  const { doc, container } = serverPage({ lang: "en", class: "a" });
  const writes: string[] = [];
  const html = doc.documentElement as Any;
  const set = html.setAttribute.bind(html);
  html.setAttribute = (n: string, v: string) => (writes.push(n), set(n, v));
  hydrateRoot(
    container as Any,
    h("html", { lang: "en", className: "a" }, h("body", null, h("p", null, "hi"))),
  );
  flushSync();
  assertEquals(writes, [], "nothing was rewritten");
});

Deno.test("singleton hydration: suppressHydrationWarning keeps a mismatched attribute; without it the client value wins", () => {
  const kept = serverPage({ "data-theme": "dark" });
  hydrateRoot(
    kept.container as Any,
    h(
      "html",
      { "data-theme": "light", suppressHydrationWarning: true },
      h("body", null, h("p", null, "hi")),
    ),
  );
  flushSync();
  assertEquals(kept.doc.documentElement.getAttribute("data-theme"), "dark");

  const patched = serverPage({ "data-theme": "dark" });
  hydrateRoot(
    patched.container as Any,
    h("html", { "data-theme": "light" }, h("body", null, h("p", null, "hi"))),
  );
  flushSync();
  assertEquals(patched.doc.documentElement.getAttribute("data-theme"), "light");
});

Deno.test("singleton: unmount removes only what the layout set, never a script's attribute or class", () => {
  const { doc, container } = serverPage({ "data-theme": "dark", class: "a dark" });
  const root = hydrateRoot(
    container as Any,
    h(
      "html",
      { "data-theme": "light", className: "a", suppressHydrationWarning: true },
      h("body", null, h("p", null, "hi")),
    ),
  );
  flushSync();
  root.unmount();
  flushSync();
  assertEquals(doc.documentElement.getAttribute("data-theme"), "dark", "the layout never set it");
  assertEquals(doc.documentElement.getAttribute("class"), "dark", "only the layout's token left");
});

Deno.test("singleton: a layout switch keeps a class token a script added after mount", () => {
  const { doc, container } = page();
  const root = createRoot(container as Any);
  root.render(h(LayoutA, null, h("p", null, "a")));
  flushSync();
  // A theme toggle after mount: `document.documentElement.classList.add("dark")`.
  doc.documentElement.setAttribute("class", "theme-a dark");
  doc.documentElement.setAttribute("data-theme", "dark");
  root.render(h(LayoutB, null, h("p", null, "b")));
  flushSync();
  assertEquals(
    doc.documentElement.getAttribute("class"),
    "dark",
    "LayoutA's token went, dark stayed",
  );
  assertEquals(doc.documentElement.getAttribute("data-theme"), "dark");
});

Deno.test("singleton: a className update keeps a script-added token", () => {
  const { doc, container } = page();
  const root = createRoot(container as Any);
  const Layout = ({ c }: { c: string }) => h("html", { className: c }, h("body", null, "x"));
  root.render(h(Layout, { c: "a" }));
  flushSync();
  doc.documentElement.setAttribute("class", "a dark");
  root.render(h(Layout, { c: "b" }));
  flushSync();
  assertEquals(tokens(doc.documentElement), new Set(["b", "dark"]));
});
