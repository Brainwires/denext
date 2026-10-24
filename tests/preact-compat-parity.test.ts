// `denext/preact` parity with Preact: `useErrorBoundary` (a component that is an error boundary
// for its own subtree), the `options` hooks denext honours (`vnode`, `event`, `useDebugValue`)
// and `denext/preact/render-to-string` (preact-render-to-string's API and output conventions).

import { assert, assertEquals, assertRejects, assertStrictEquals, assertThrows } from "@std/assert";
import { render } from "../src/testing/mod.ts";
import {
  cloneElement,
  createElement,
  createPortal,
  Fragment,
  h,
  options,
  type VNode,
} from "../src/compat/preact/mod.ts";
import { useDebugValue, useErrorBoundary, useState } from "../src/compat/preact/hooks.ts";
import { jsx } from "../src/compat/preact/jsx-runtime.ts";
import compatDefault, {
  createElement as compatCreateElement,
  Suspense,
} from "../src/compat/preact/compat.ts";
import renderToStringDefault, {
  render as renderAlias,
  renderToReadableStream,
  renderToStaticMarkup,
  renderToString,
  renderToStringAsync,
} from "../src/compat/preact/render-to-string.ts";
import { ErrorBoundary as DenextErrorBoundary } from "../src/runtime/error-boundary.ts";

// ── useErrorBoundary ────────────────────────────────────────────────────────────────

Deno.test("useErrorBoundary catches a descendant's render error, reports it and resets", async () => {
  let fail = true;
  const caught: unknown[] = [];
  let resetFn: () => void = () => {};
  function Child() {
    if (fail) throw new Error("child broke");
    return h("p", null, "child ok");
  }
  function Boundary(props: { children?: unknown }) {
    const [error, reset] = useErrorBoundary((e) => {
      caught.push(e);
    });
    resetFn = reset;
    if (error) return h("p", null, `caught: ${(error as Error).message}`);
    return props.children as VNode;
  }
  const screen = await render(h("div", null, h(Boundary, null, h(Child, null))));
  assertEquals(screen.html(), "<div><p>caught: child broke</p></div>");
  assertEquals(caught.length, 1);
  assertEquals((caught[0] as Error).message, "child broke");
  fail = false;
  await screen.act(() => resetFn());
  assertEquals(screen.html(), "<div><p>child ok</p></div>");
  assertEquals(caught.length, 1);
  await screen.unmount();
});

Deno.test("useErrorBoundary catches an error routed from an event handler", async () => {
  function Thrower() {
    const [boom, setBoom] = useState(false);
    if (boom) throw new Error("after click");
    return h("button", { type: "button", onClick: () => setBoom(true) }, "go");
  }
  function Boundary() {
    const [error] = useErrorBoundary();
    return error ? h("span", null, "handled") : h(Thrower, null);
  }
  const screen = await render(h(Boundary, null));
  await screen.fireEvent.click(screen.getByRole("button"));
  assertEquals(screen.html(), "<span>handled</span>");
  await screen.unmount();
});

Deno.test("an error the error UI throws goes to the boundary above, not back here", async () => {
  function Child(): never {
    throw new Error("first");
  }
  function Boundary() {
    const [error] = useErrorBoundary();
    if (error) throw new Error("error UI broke");
    return h(Child, null);
  }
  const Outer = (p: { error: Error }) => h("em", null, p.error.message);
  const screen = await render(h(DenextErrorBoundary, { fallback: Outer }, h(Boundary, null)));
  assertEquals(screen.html(), "<em>error UI broke</em>");
  await screen.unmount();
});

Deno.test("useErrorBoundary nests: the nearest boundary catches", async () => {
  const outer: unknown[] = [];
  function Child(): never {
    throw new Error("inner");
  }
  function Inner() {
    const [error] = useErrorBoundary();
    return error ? h("i", null, "inner caught") : h(Child, null);
  }
  function Outer() {
    const [error] = useErrorBoundary((e) => {
      outer.push(e);
    });
    return error ? h("b", null, "outer caught") : h("section", null, h(Inner, null));
  }
  const screen = await render(h(Outer, null));
  assertEquals(screen.html(), "<section><i>inner caught</i></section>");
  assertEquals(outer, []);
  await screen.unmount();
});

Deno.test("createPortal is in Preact's core (Preact 11)", () => {
  assertEquals(typeof createPortal, "function");
});

// ── options ─────────────────────────────────────────────────────────────────────────

Deno.test("options.vnode sees every element the Preact factories create", () => {
  const seen: unknown[] = [];
  options.vnode = (v) => seen.push(v.type);
  try {
    const a = h("a", null);
    createElement("b", null);
    cloneElement(a, { id: "x" });
    jsx("c", {});
    compatCreateElement("d", null);
    compatDefault.createElement("e", null);
    h(Fragment, null);
    assertEquals(seen, ["a", "b", "a", "c", "d", "e", Fragment]);
    // A hook may rewrite the element in place (class-name prefixing libraries do).
    options.vnode = (v) => {
      if (typeof v.type === "string") (v.props as Record<string, unknown>).class = "p";
    };
    assertEquals((h("div", null).props as Record<string, unknown>).class, "p");
  } finally {
    delete options.vnode;
  }
});

Deno.test("options.event runs before an intrinsic element's handler and may replace the event", async () => {
  const log: string[] = [];
  options.event = (e) => {
    log.push(`hook:${e.type}`);
    return { type: "replaced" };
  };
  try {
    const handler = (e: { type: string }) => log.push(`handler:${e.type}`);
    const first = jsx("button", { onClick: handler });
    const second = jsx("button", { onClick: handler });
    // The wrapper is stable per handler, so a re-render does not swap listeners.
    assertStrictEquals(
      (first.props as Record<string, unknown>).onClick,
      (second.props as Record<string, unknown>).onClick,
    );
    // A component's props are left alone.
    const Comp = (_: { onClick: unknown }) => null;
    assertStrictEquals((h(Comp as never, { onClick: handler }).props as never)["onClick"], handler);
    const screen = await render(h("button", { type: "button", onClick: handler }, "x"));
    await screen.fireEvent.click(screen.getByRole("button"));
    assertEquals(log, ["hook:click", "handler:replaced"]);
    await screen.unmount();
  } finally {
    delete options.event;
  }
  // Unset: the handler is passed through as it is.
  const plain = () => {};
  assertStrictEquals((h("i", { onClick: plain }).props as never)["onClick"], plain);
});

function DebugValues() {
  useDebugValue(3, (n) => `n=${n}`);
  useDebugValue("plain");
  return null as never;
}

Deno.test("options.useDebugValue receives the (formatted) debug value", async () => {
  const values: unknown[] = [];
  options.useDebugValue = (v) => values.push(v);
  try {
    const screen = await render(h(DebugValues, null));
    assertEquals(values.slice(0, 2), ["n=3", "plain"]);
    await screen.unmount();
  } finally {
    delete options.useDebugValue;
  }
});

// ── preact-render-to-string ─────────────────────────────────────────────────────────

// Each expected string is what preact@11.0.1 + preact-render-to-string@6.8.1 render for the
// same tree (captured with the real packages).
Deno.test("renderToString follows Preact's output conventions", () => {
  const C = (p: { name: string }) => h("span", null, "hi ", p.name, "!");
  const tree = h(
    "div",
    { className: "a", class: "b", htmlFor: "x", id: "r", "data-x": true, tabIndex: 0 } as never,
    h("input", { disabled: true, value: "v", readOnly: true, autoFocus: true } as never),
    h("br", null),
    h("img", { src: "a.png", alt: "" }),
    h(C as never, { name: "<x>" }),
    "a",
    "b",
    1,
    null,
    false,
    h(Fragment, null, "f1", "f2"),
    h("label", { htmlFor: "q" } as never, "L"),
    h("textarea", { value: "ta" } as never),
    h("div", { dangerouslySetInnerHTML: { __html: "<b>raw &gt;</b>" } } as never),
    h("p", { title: `q"<&>'`, style: { color: "red", fontSize: 12, "--v": 1 } }, `<&>"'`),
  );
  const expected = '<div class="b" for="x" id="r" data-x="true" tabindex="0">' +
    '<input disabled value="v" readonly autofocus/><br/><img src="a.png" alt/>' +
    '<span>hi &lt;x>!</span>ab1f1f2<label for="q">L</label><textarea>ta</textarea>' +
    "<div><b>raw &gt;</b></div>" +
    `<p title="q&quot;&lt;&amp;>'" style="color:red;font-size:12px;--v:1;">&lt;&amp;>&quot;'</p>` +
    "</div>";
  assertEquals(renderToString(tree), expected);
  assertEquals(renderAlias(tree), expected);
  assertEquals(renderToStringDefault(tree), expected);
  assertEquals(renderToStaticMarkup(tree), expected);
});

Deno.test("renderToString: no Suspense markers, hooks and context run", () => {
  function Counter() {
    const [n] = useState(2);
    return h("b", null, n);
  }
  assertEquals(renderToString(h("main", null, h(Counter, null))), "<main><b>2</b></main>");
});

Deno.test("renderToStringAsync waits for a suspended subtree; a sync render throws as Preact's", async () => {
  let ready = false;
  const pending = new Promise<void>((r) => setTimeout(() => (ready = true, r()), 5));
  function Slow() {
    if (!ready) throw pending;
    return h("p", null, "loaded");
  }
  const tree = h("div", null, h(Suspense, { fallback: h("i", null, "fb") }, h(Slow, null)));
  assertThrows(
    () => renderToString(tree),
    Error,
    'Use "renderToStringAsync" for suspenseful rendering.',
  );
  // The same markers preact-render-to-string writes around a boundary that suspended.
  assertEquals(await renderToStringAsync(tree), "<div><!--$s--><p>loaded</p><!--/$s--></div>");
  // A boundary that never suspended carries none.
  assertEquals(await renderToStringAsync(tree), "<div><p>loaded</p></div>");
  const stream = renderToReadableStream(h("p", null, "s"));
  await stream.allReady;
  assertEquals(await new Response(stream).text(), "<p>s</p>");
  const failing = renderToReadableStream(h(() => {
    throw new Error("render failed");
  }, null));
  await assertRejects(() => failing.allReady, Error, "render failed");
  assert(failing instanceof ReadableStream);
});
