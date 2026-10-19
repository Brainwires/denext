// React Native mode's own document-wide rules (src/react-native/document-style.ts: the TextInput
// placeholder / selection rules, the lists' hidden scrollbar). They used to be a `<style>` element
// with text, which a CSP without `style-src 'unsafe-inline'` blocks. Where the document can adopt
// a constructed style sheet they go there (CSSOM, not governed by `style-src`); elsewhere a
// `<style>` element is still the fallback.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { render } from "../src/testing/mod.ts";
import { withTextInputDefaults } from "../src/react-native/mod.ts";
import { TEXT_INPUT_CLASS } from "../src/react-native/text-input.ts";
import {
  ensureHiddenScrollbarRule,
  HIDE_SCROLLBAR_CLASS,
} from "../src/react-native/lists/style.ts";
import { addDocumentRules } from "../src/react-native/document-style.ts";
import { makeDom } from "./helpers/dom.ts";
import { withGlobals } from "./helpers/mobile-fakes.ts";

/** A constructed style sheet stand-in recording its rules (one rejected selector throws). */
class FakeSheet {
  cssRules: string[] = [];
  insertRule(rule: string, index: number): number {
    if (rule.includes("::-unknown")) throw new SyntaxError("bad selector");
    this.cssRules.splice(index, 0, rule);
    return index;
  }
}

/** A DOM whose document can adopt constructed sheets. */
function adoptingDom() {
  const { doc } = makeDom();
  const adopting = doc as typeof doc & { adoptedStyleSheets: FakeSheet[] };
  adopting.adoptedStyleSheets = [];
  return adopting;
}

Deno.test("addDocumentRules: an adopted sheet, not a <style> element, once per id", async () => {
  const doc = adoptingDom();
  await withGlobals({ document: doc, CSSStyleSheet: FakeSheet }, () => {
    addDocumentRules("x", [".a::placeholder{color:red}", ".b::-unknown{color:red}", ".c{x:y}"]);
    addDocumentRules("x", [".d{x:y}"]);
    ensureHiddenScrollbarRule();
    ensureHiddenScrollbarRule();
  });
  assertEquals(doc.head.childNodes.length, 0, "no <style> element for a CSP to block");
  assertEquals(doc.adoptedStyleSheets.map((s) => s.cssRules), [
    [".a::placeholder{color:red}", ".c{x:y}"],
    [`.${HIDE_SCROLLBAR_CLASS}::-webkit-scrollbar{display:none}`],
  ]);
});

Deno.test("addDocumentRules: TextInput's placeholder rule goes into an adopted sheet", async () => {
  const doc = adoptingDom();
  function Base(): VNode {
    return h("input", {});
  }
  const TextInput = withTextInputDefaults(Base as never) as unknown as (
    p: Record<string, unknown>,
  ) => VNode;
  await withGlobals({ document: doc, CSSStyleSheet: FakeSheet }, async () => {
    const screen = await render(h(TextInput, { placeholder: "p" }));
    await screen.unmount();
  });
  assertEquals(doc.head.childNodes.length, 0);
  const rules = doc.adoptedStyleSheets.flatMap((s) => s.cssRules);
  assert(rules[0].startsWith(`.${TEXT_INPUT_CLASS}::placeholder{`), rules[0]);
});

Deno.test("addDocumentRules: a <style> element without adoptedStyleSheets; nothing without a document", async () => {
  const { doc } = makeDom();
  await withGlobals({ document: doc }, () => addDocumentRules("y", [".a{x:y}", ".b{x:y}"]));
  const nodes = doc.head.childNodes as unknown as { id?: string; textContent?: string }[];
  assertEquals(nodes.map((n) => [n.id, n.textContent]), [["y", ".a{x:y}.b{x:y}"]]);
  // A document whose constructed sheets throw falls back too.
  const broken = adoptingDom();
  class Throwing {
    constructor() {
      throw new TypeError("Illegal constructor");
    }
  }
  await withGlobals(
    { document: broken, CSSStyleSheet: Throwing },
    () => addDocumentRules("z", [".a{x:y}"]),
  );
  assertEquals(broken.head.childNodes.length, 1);
  await withGlobals({ document: undefined }, () => addDocumentRules("w", [".a{x:y}"]));
});
