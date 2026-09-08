// global-error.tsx hydration: `hydrateDocument` adopts a document-owning tree in place
// (skipping the leading doctype) so the global-error component becomes interactive and its
// `reset` is a real function — the client half of the "global-error hydrates" feature.

import { assertEquals } from "@std/assert";
import { h } from "../../src/jsx/jsx-runtime.ts";
import { flushSync, hydrateDocument, setDocument } from "../../src/client/reconciler.ts";
import { useState } from "../../src/runtime/hooks.ts";
import { FakeDocument, type FakeElement } from "../helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asAny = (v: unknown): any => v;

/**
 * A document whose top-level children are a doctype then `<html>` (like a real document), with
 * `<button>count: 0</button>` already in `<body>` as the server-rendered markup to adopt.
 */
function serverRenderedDocument(): { doc: FakeDocument; button: FakeElement } {
  const doc = new FakeDocument(); // documentElement (<html>) with <head> + <body>
  const button = doc.createElement("button");
  button.appendChild(doc.createTextNode("count: 0"));
  doc.body.appendChild(button);
  // The document's own children: a doctype (nodeType 10) followed by <html> (whose parent, as in
  // a real browser, is the document).
  asAny(doc).childNodes = [{ nodeType: 10 }, doc.documentElement];
  asAny(doc.documentElement).parentNode = doc;
  return { doc, button };
}

Deno.test("hydrateDocument adopts <html> in place, skips the doctype, and wires interactivity", () => {
  const { doc, button } = serverRenderedDocument();
  setDocument(asAny(doc));

  function GlobalError(_props: { error: Error; reset: () => void }) {
    const [n, setN] = useState(0);
    return h(
      "html",
      null,
      h("head", null),
      h("body", null, h("button", { onClick: () => setN(n + 1) }, `count: ${n}`)),
    );
  }

  const mismatches: unknown[] = [];
  hydrateDocument(
    h(GlobalError, { error: new Error("boom"), reset: () => {} }),
    { onRecoverableError: (e) => mismatches.push(e) },
  );

  // Clean hydration: seeding the cursor at <html> skipped the doctype, so no mismatch fired.
  assertEquals(mismatches, []);
  // The existing server button was ADOPTED (same node), not recreated.
  assertEquals(button.parentNode, doc.body);
  assertEquals(button.textContent, "count: 0");

  // Interactivity works after hydration: the click handler is live and updates the tree.
  button.dispatch("click");
  flushSync();
  assertEquals(button.textContent, "count: 1");
});

Deno.test("hydrateDocument without a doctype still hydrates (cursor seeds at documentElement)", () => {
  const { doc, button } = serverRenderedDocument();
  asAny(doc).childNodes = [doc.documentElement]; // no leading doctype (parentNode already set)
  setDocument(asAny(doc));

  function GlobalError() {
    return h("html", null, h("head", null), h("body", null, h("button", null, "count: 0")));
  }
  const mismatches: unknown[] = [];
  hydrateDocument(h(GlobalError, null), { onRecoverableError: (e) => mismatches.push(e) });

  assertEquals(mismatches, []);
  assertEquals(button.parentNode, doc.body);
});
