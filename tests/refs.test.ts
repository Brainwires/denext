// Ref fidelity: object refs are set on mount and cleared on unmount; callback
// refs run their React-19 cleanup on detach; changing a ref detaches the old one;
// forwardRef threads a ref down to the real DOM node.

import { assertEquals } from "@std/assert";
import { createRoot, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { forwardRef } from "../src/compat/react.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("object ref: current set on mount, nulled on unmount", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const ref = { current: null as unknown };
  function App() {
    return h("div", { ref });
  }
  const root = createRoot(container as Any);
  root.render(h(App, null));
  assertEquals(ref.current, container.childNodes[0], "ref.current is the element");
  root.unmount();
  assertEquals(ref.current, null, "ref.current cleared on unmount");
});

Deno.test("callback ref: runs React-19 cleanup on unmount", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const attached: unknown[] = [];
  let cleaned = 0;
  const ref = (el: unknown) => {
    attached.push(el);
    return () => cleaned++;
  };
  function App() {
    return h("div", { ref });
  }
  const root = createRoot(container as Any);
  root.render(h(App, null));
  assertEquals(attached.length, 1);
  assertEquals(attached[0], container.childNodes[0]);
  root.unmount();
  assertEquals(cleaned, 1, "cleanup fn runs once on unmount");
});

Deno.test("changing the ref detaches the old one", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const a = { current: null as unknown };
  const b = { current: null as unknown };
  function App(props: { ref: unknown }) {
    return h("div", { ref: props.ref });
  }
  const root = createRoot(container as Any);
  root.render(h(App, { ref: a }));
  assertEquals(a.current, container.childNodes[0]);
  root.render(h(App, { ref: b }));
  assertEquals(a.current, null, "old ref detached");
  assertEquals(b.current, container.childNodes[0], "new ref attached");
  root.unmount();
});

Deno.test("forwardRef threads a ref down to the real DOM node", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const ref = { current: null as unknown };
  const Fancy = forwardRef<unknown, { ref?: unknown }>((_props, r) =>
    h("button", { ref: r }, "go")
  );
  function App() {
    return h(Fancy as Any, { ref });
  }
  createRoot(container as Any).render(h(App, null));
  const btn = container.childNodes[0] as Any;
  assertEquals(btn.tagName, "BUTTON");
  assertEquals(ref.current, btn, "forwarded ref points at the DOM node");
});
