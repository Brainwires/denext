// forwardRef / memo now return React's non-callable ELEMENT-OBJECT shape
// (`{ $$typeof, render }` / `{ $$typeof, type, compare }`) instead of a branded
// callable function. The renderers resolve these wrappers (including nesting like
// memo(forwardRef(...))) via resolveComponentType. The public return type stays
// callable so the 1.0 API surface is unchanged; only the runtime value differs.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { Component, forwardRef, memo } from "../src/compat/react.ts";
import { isForwardRef, isMemo, isValidElementType } from "../src/compat/react-is.ts";
import {
  REACT_FORWARD_REF_TYPE,
  REACT_MEMO_TYPE,
  resolveComponentType,
} from "../src/runtime/react-brands.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("memo / forwardRef return non-callable objects with React's exact shape", () => {
  const Fn = (p: { x: number }) => h("i", null, String(p.x));
  const M = memo(Fn);
  const F = forwardRef<{ label: string }>((p, _ref) => h("b", null, p.label));

  // Non-callable objects, not functions.
  assertEquals(typeof M, "object");
  assertEquals(typeof F, "object");
  // Exact React field shape.
  assertEquals((M as Any).$$typeof, REACT_MEMO_TYPE);
  assertEquals((M as Any).type, Fn);
  assertEquals((F as Any).$$typeof, REACT_FORWARD_REF_TYPE);
  assertEquals(typeof (F as Any).render, "function");

  // react-is still classifies them (reads $$typeof).
  assert(isMemo(M));
  assert(isForwardRef(F));
  assert(isValidElementType(M));
  assert(isValidElementType(F));
});

Deno.test("resolveComponentType unwraps memo, forwardRef, and memo(forwardRef(...))", () => {
  const Fn = (_p: unknown) => null;
  const render = (_p: unknown, _r: unknown) => null;

  assertEquals(resolveComponentType(Fn), { fn: Fn, forwardsRef: false });
  assertEquals(resolveComponentType(memo(Fn as Any)), { fn: Fn, forwardsRef: false });

  const F = forwardRef(render as Any);
  assertEquals(resolveComponentType(F), { fn: render, forwardsRef: true });

  // Nested: memo(forwardRef(render)) resolves through both to the render fn.
  const MF = memo(forwardRef(render as Any) as Any);
  assertEquals(resolveComponentType(MF), { fn: render, forwardsRef: true });

  // A host string is not a component wrapper.
  assertEquals(resolveComponentType("div"), { fn: "div", forwardsRef: false });
});

Deno.test("memo / forwardRef / nested wrappers render on the client", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  const Inner = forwardRef<{ label: string }>((p, ref) => {
    // ref is threaded from props.
    (ref as { current?: unknown } | null) && ((ref as { current: unknown }).current = "set");
    return h("span", null, p.label);
  });
  const Wrapped = memo(Inner as Any);
  const ref = { current: null as unknown };

  createRoot(container as Any).render(h(Wrapped as Any, { ref, label: "hi" }));
  flushSync();

  assertEquals(container.innerHTML, "<span>hi</span>", "memo(forwardRef()) renders");
  assertEquals(ref.current, "set", "ref threaded through the nested wrapper");
});

Deno.test("memo / forwardRef render on the server (SSR)", async () => {
  const M = memo((p: { n: number }) => h("i", null, String(p.n)));
  const F = forwardRef<{ label: string }>((p, _r) => h("b", null, p.label));

  assertEquals(await renderToString(h(M as Any, { n: 7 })), "<i>7</i>");
  assertEquals(await renderToString(h(F as Any, { label: "z" })), "<b>z</b>");
  // Nested through SSR.
  const MF = memo(forwardRef<{ label: string }>((p, _r) => h("u", null, p.label)) as Any);
  assertEquals(await renderToString(h(MF as Any, { label: "q" })), "<u>q</u>");
});

Deno.test("memo() of a class component throws a guided error", async () => {
  class Cls extends Component<Record<string, never>> {
    override render() {
      return h("span", null, "c");
    }
  }
  const MC = memo(Cls as Any);
  // SSR path.
  await assertRejects(
    async () => {
      await renderToString(h(MC as Any, {}));
    },
    Error,
    "memo() of a class component",
  );
  // Client path.
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  assertThrows(
    () => {
      createRoot(container as Any).render(h(MC as Any, {}));
      flushSync();
    },
    Error,
    "memo() of a class component",
  );
});
