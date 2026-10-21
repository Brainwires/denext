// forwardRef / memo now return React's non-callable ELEMENT-OBJECT shape
// (`{ $$typeof, render }` / `{ $$typeof, type, compare }`) instead of a branded
// callable function. The renderers resolve these wrappers (including nesting like
// memo(forwardRef(...))) via resolveComponentType. The public return type stays
// callable so the 1.0 API surface is unchanged; only the runtime value differs.

import "./helpers/class-runtime.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
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
import { installErrorTexts } from "../src/client/fiber/error-texts.ts";

// The full error texts a dev build installs (a production bundle throws the short form).
installErrorTexts();

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("memo / forwardRef return non-callable objects with React's exact shape", () => {
  const Fn = (p: { x: number }) => h("i", null, String(p.x));
  const M = memo(Fn);
  const F = forwardRef<unknown, { label: string }>((p, _ref) => h("b", null, p.label));

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

Deno.test("resolveComponentType caps a cyclic memo wrapper instead of hanging (L7)", () => {
  // A hand-built memo object whose `.type` points back at itself would otherwise
  // spin the unwrap loop forever, wedging the render thread. The depth cap turns
  // that into a guided throw.
  const cyclic: Any = { $$typeof: REACT_MEMO_TYPE };
  cyclic.type = cyclic;
  assertThrows(
    () => resolveComponentType(cyclic),
    Error,
    "maximum wrapper depth",
  );

  // A long-but-finite chain within the cap still resolves (not over-eager).
  const Fn = (_p: unknown) => null;
  let wrapped: Any = Fn;
  for (let i = 0; i < 40; i++) wrapped = { $$typeof: REACT_MEMO_TYPE, type: wrapped };
  assertEquals(resolveComponentType(wrapped), { fn: Fn, forwardsRef: false });
});

Deno.test("memo / forwardRef / nested wrappers render on the client", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  const Inner = forwardRef<unknown, { label: string }>((p, ref) => {
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
  const F = forwardRef<unknown, { label: string }>((p, _r) => h("b", null, p.label));

  assertEquals(await renderToString(h(M as Any, { n: 7 })), "<i>7</i>");
  assertEquals(await renderToString(h(F as Any, { label: "z" })), "<b>z</b>");
  // Nested through SSR.
  const MF = memo(forwardRef<unknown, { label: string }>((p, _r) => h("u", null, p.label)) as Any);
  assertEquals(await renderToString(h(MF as Any, { label: "q" })), "<u>q</u>");
});

Deno.test("memo() of a class component renders the class, as in React (SSR + client)", async () => {
  let renders = 0;
  class Cls extends Component<{ n: number; tag?: string }> {
    override render() {
      renders++;
      return h("span", null, `c${this.props.n}`);
    }
  }
  const MC = memo(Cls as Any);
  // SSR path.
  assertEquals(await renderToString(h(MC as Any, { n: 1 })), "<span>c1</span>");
  // Client path: the default compare is shallow, so equal props skip the class's render.
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  root.render(h(MC as Any, { n: 1 }));
  flushSync();
  assertEquals(container.innerHTML, "<span>c1</span>");
  assertEquals(renders, 2); // one SSR + one client mount
  root.render(h(MC as Any, { n: 1 }));
  flushSync();
  assertEquals(renders, 2, "shallow-equal props skip the class's render");
  root.render(h(MC as Any, { n: 2 }));
  flushSync();
  assertEquals(container.innerHTML, "<span>c2</span>");
  assertEquals(renders, 3, "changed props re-render the class");
});

Deno.test("memo(Class, compare) uses the custom compare", () => {
  let renders = 0;
  class Cls extends Component<{ n: number; tag: string }> {
    override render() {
      renders++;
      return h("span", null, `${this.props.tag}${this.props.n}`);
    }
  }
  // Equal when `n` matches, whatever `tag` is.
  const MC = memo(Cls as Any, (a: Any, b: Any) => a.n === b.n);
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  root.render(h(MC as Any, { n: 1, tag: "a" }));
  flushSync();
  assertEquals(container.innerHTML, "<span>a1</span>");
  root.render(h(MC as Any, { n: 1, tag: "b" }));
  flushSync();
  assertEquals(container.innerHTML, "<span>a1</span>", "compare said equal: no re-render");
  assertEquals(renders, 1);
  root.render(h(MC as Any, { n: 2, tag: "b" }));
  flushSync();
  assertEquals(container.innerHTML, "<span>b2</span>");
  assertEquals(renders, 2);
  // A compare that always says "changed" re-renders even for identical props.
  let always = 0;
  class Always extends Component<{ n: number }> {
    override render() {
      always++;
      return h("i", null, String(this.props.n));
    }
  }
  const MA = memo(Always as Any, () => false);
  const props = { n: 5 };
  root.render(h(MA as Any, props));
  flushSync();
  root.render(h(MA as Any, props));
  flushSync();
  assertEquals(always, 2, "compare → false re-renders the class");
});
