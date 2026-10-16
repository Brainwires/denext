// Two React 19 behaviours a framework's client entry relies on (TanStack Start's
// `hydrateRoot(document, <RouterClient router={router} />)`): `hydrateRoot(document, …)` adopts
// the server's `<html>` in place, past the doctype; and a component that suspends with no
// Suspense boundary above it suspends the whole root — the server DOM stays as it is, and the
// root hydrates once the promise settles — instead of throwing out of the render.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, hydrateRoot, setDocument } from "../src/client/reconciler.ts";
import { useState } from "../src/runtime/hooks.ts";
import { FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asAny = (v: unknown): any => v;

/** A server-rendered document: a doctype, then `<html>` with `<button>count: 0</button>`. */
function serverRenderedDocument(): { doc: FakeDocument; button: FakeElement } {
  const doc = new FakeDocument();
  const button = doc.createElement("button");
  button.appendChild(doc.createTextNode("count: 0"));
  doc.body.appendChild(button);
  asAny(doc).childNodes = [{ nodeType: 10 }, doc.documentElement];
  asAny(doc.documentElement).parentNode = doc;
  asAny(doc).nodeType = 9;
  return { doc, button };
}

function Document() {
  const [n, setN] = useState(0);
  return h(
    "html",
    null,
    h("head", null),
    h("body", null, h("button", { onClick: () => setN(n + 1) }, `count: ${n}`)),
  );
}

const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

Deno.test("hydrateRoot(document, …) adopts <html> past the doctype", () => {
  const { doc, button } = serverRenderedDocument();
  setDocument(asAny(doc));
  const mismatches: unknown[] = [];
  hydrateRoot(asAny(doc), h(Document, null), {
    onRecoverableError: (e) => mismatches.push(e),
  });
  assertEquals(mismatches, []);
  assertEquals(asAny(doc).childNodes.length, 2, "nothing appended to the document");
  assert(button.parentNode === doc.body, "the server's button was adopted");
  button.dispatch("click");
  flushSync();
  assertEquals(button.textContent, "count: 1");
});

Deno.test("a suspension with no boundary suspends the root; it hydrates once the promise settles", async () => {
  const { doc, button } = serverRenderedDocument();
  setDocument(asAny(doc));
  let resolve!: () => void;
  const pending = new Promise<void>((r) => (resolve = r));
  let ready = false;
  void pending.then(() => (ready = true));
  function Gate() {
    if (!ready) throw pending;
    return h(Document, null);
  }
  const mismatches: unknown[] = [];
  hydrateRoot(asAny(doc), h(Gate, null), { onRecoverableError: (e) => mismatches.push(e) });
  flushSync();
  assertEquals(button.textContent, "count: 0", "the server DOM stays while the root is suspended");
  resolve();
  await tick();
  flushSync();
  assertEquals(mismatches, [], "the retry hydrates");
  assert(button.parentNode === doc.body, "the server's button was adopted");
  button.dispatch("click");
  flushSync();
  assertEquals(button.textContent, "count: 1");
});

Deno.test("a client render that suspends with no boundary commits once the promise settles", async () => {
  const { doc, container } = makeDom();
  setDocument(asAny(doc));
  let resolve!: () => void;
  const pending = new Promise<void>((r) => (resolve = r));
  let ready = false;
  void pending.then(() => (ready = true));
  function Gate() {
    if (!ready) throw pending;
    return h("p", null, "ready");
  }
  createRoot(asAny(container)).render(h(Gate, null));
  flushSync();
  assertEquals(asAny(container).childNodes.length, 0, "nothing commits while suspended");
  resolve();
  await tick();
  flushSync();
  assertEquals(asAny(container).textContent, "ready");
});
