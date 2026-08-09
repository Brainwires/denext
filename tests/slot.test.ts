// Slot / asChild: the Radix primitive. Slot merges its props onto its single
// child element — className joins, handlers compose (child first), refs merge —
// without rendering a wrapper.

import { assert, assertEquals } from "@std/assert";
import { createRoot, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { Slot, Slottable } from "../src/compat/slot.ts";
import { composeRefs } from "../src/compat/refs.ts";
import { isForwardRef } from "../src/compat/react-is.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("Slot merges className onto the child and renders no wrapper", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  createRoot(container as Any).render(
    h(Slot as Any, { className: "outer" }, h("button", { className: "inner" }, "go")),
  );
  // One element: the child <button>, not a wrapping Slot element.
  assertEquals(container.childNodes.length, 1);
  const btn = container.childNodes[0] as Any;
  assertEquals(btn.tagName, "BUTTON");
  assertEquals(btn.getAttribute("class"), "outer inner");
});

Deno.test("Slot composes event handlers (child first, then slot)", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const order: string[] = [];
  createRoot(container as Any).render(
    h(
      Slot as Any,
      { onClick: () => order.push("slot") },
      h("button", { onClick: () => order.push("child") }, "go"),
    ),
  );
  (container.childNodes[0] as Any).dispatch("click");
  assertEquals(order, ["child", "slot"]);
});

Deno.test("Slot merges its ref with the child's ref", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const slotRef = { current: null as unknown };
  const childRef = { current: null as unknown };
  createRoot(container as Any).render(
    h(Slot as Any, { ref: slotRef }, h("button", { ref: childRef }, "go")),
  );
  const btn = container.childNodes[0];
  assertEquals(slotRef.current, btn, "slot ref points at the child DOM node");
  assertEquals(childRef.current, btn, "child ref still points at its DOM node");
});

Deno.test("Slot is branded as a forwardRef (react-is)", () => {
  assert(isForwardRef(Slot));
});

Deno.test("Slottable: Slot merges onto the marked child, keeps siblings", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  createRoot(container as Any).render(
    h(
      Slot as Any,
      { className: "outer" },
      h("i", null, "icon"),
      h(Slottable as Any, null, h("button", { className: "inner" }, "go")),
    ),
  );
  // Two siblings: the icon, and the merged button.
  const html = container.innerHTML;
  assert(html.includes("<i>icon</i>"), `icon sibling preserved: ${html}`);
  assert(html.includes('class="outer inner"'), `merged onto button: ${html}`);
});

Deno.test("composeRefs writes to and clears all refs", () => {
  const a = { current: null as string | null };
  const b: unknown[] = [];
  const ref = composeRefs<string>(a, (n) => b.push(n));
  ref("node");
  assertEquals(a.current, "node");
  assertEquals(b, ["node"]);
  ref(null);
  assertEquals(a.current, null);
  assertEquals(b, ["node", null]);
});
