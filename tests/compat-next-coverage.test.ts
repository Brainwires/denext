// Coverage for compat surface: next/form (<Form>), next/head (<Head>/defaultHead),
// compose-refs (composeRefs/useComposedRefs), class-detect, and the react-dom shim.

import { REACT_COMPAT_VERSION } from "../src/compat/react-version.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "denext/jsx-runtime";
import { render } from "denext/testing";
import Form from "../src/compat/next/form.ts";
import Head, { defaultHead } from "../src/compat/next/head.ts";
import { composeRefs, useComposedRefs } from "../src/compat/refs.ts";
import { classComponentsDisabledError, isClassComponent } from "../src/compat/class-detect.ts";
import { Component } from "../src/compat/react.ts";
import ReactDOM, { unstable_batchedUpdates, version } from "../src/compat/react-dom.ts";

// ---- next/form -------------------------------------------------------------

Deno.test("Form with a string action renders a GET form to the action path", async () => {
  const screen = await render(
    h(Form, { action: "/search", prefetch: false, children: h("input", { name: "q" }) }),
  );
  try {
    const html = screen.html();
    assertStringIncludes(html, "<form");
    assertStringIncludes(html, 'method="get"');
    assertStringIncludes(html, 'action="/search"');
  } finally {
    await screen.unmount();
  }
});

Deno.test("Form with a function action renders a plain form (no GET interception)", async () => {
  const action = (_fd: FormData) => {};
  const screen = await render(
    h(Form, { action, children: h("button", { type: "submit" }, "Go") }),
  );
  try {
    const html = screen.html();
    assertStringIncludes(html, "<form");
    assert(!html.includes('method="get"'), "a Server Action form is not a GET-interception form");
  } finally {
    await screen.unmount();
  }
});

Deno.test("Form submit calls onSubmit and honors preventDefault (no navigation on the server path)", async () => {
  let submitted = false;
  const screen = await render(
    h(Form, {
      action: "/search",
      prefetch: false,
      "data-testid": "the-form",
      onSubmit: (e: Event) => {
        submitted = true;
        e.preventDefault();
      },
      children: h("input", { name: "q", value: "hi" }),
    }),
  );
  try {
    const form = screen.getByTestId("the-form");
    await screen.fireEvent.submit(form);
    assert(submitted, "onSubmit ran");
  } finally {
    await screen.unmount();
  }
});

// ---- next/head -------------------------------------------------------------

Deno.test("Head renders its children through (passthrough fragment)", async () => {
  const screen = await render(h(Head, { children: h("title", null, "Hello") }));
  try {
    assertStringIncludes(screen.html(), "Hello");
  } finally {
    await screen.unmount();
  }
});

Deno.test("defaultHead includes charset and, outside AMP, the viewport meta", () => {
  const tags = defaultHead();
  assertEquals(tags.length, 2);
  assertEquals(tags[0].type, "meta");
  assertEquals(tags[0].props.charSet, "utf-8");
  assertEquals(tags[1].props.name, "viewport");

  const ampTags = defaultHead(true);
  assertEquals(ampTags.length, 1, "AMP omits the viewport meta");
});

// ---- compose-refs ----------------------------------------------------------

Deno.test("composeRefs fans a node out to object and callback refs, and clears on detach", () => {
  const objRef: { current: string | null } = { current: null };
  let cbValue: string | null = "initial";
  const composed = composeRefs<string>(objRef, (n) => (cbValue = n), null, undefined);

  composed("node");
  assertEquals(objRef.current, "node");
  assertEquals(cbValue, "node");

  composed(null);
  assertEquals(objRef.current, null, "object ref cleared on detach");
  assertEquals(cbValue, null, "callback ref cleared on detach");
});

Deno.test("useComposedRefs writes the mounted node into a forwarded ref", async () => {
  const ref: { current: unknown } = { current: null };
  function Comp() {
    const composed = useComposedRefs(ref);
    return h("div", { ref: composed, "data-testid": "target" }, "x");
  }
  const screen = await render(h(Comp, null));
  try {
    assert(ref.current != null, "ref populated after mount");
    assertEquals((ref.current as { tagName: string }).tagName, "DIV");
  } finally {
    await screen.unmount();
    assertEquals(ref.current, null, "ref cleared on unmount");
  }
});

// ---- class-detect ----------------------------------------------------------

Deno.test("isClassComponent recognizes a denext Component subclass, rejects functions/primitives", () => {
  class MyClass extends Component {
    override render() {
      return h("div", null, "hi");
    }
  }
  assert(isClassComponent(MyClass));
  assert(!isClassComponent(function fn() {}));
  assert(!isClassComponent(() => {}));
  assert(!isClassComponent(null));
  assert(!isClassComponent("div"));
});

Deno.test("classComponentsDisabledError names the fix", () => {
  const err = classComponentsDisabledError();
  assert(err instanceof Error);
  assertStringIncludes(err.message, "classComponents: true");
});

// ---- react-dom shim --------------------------------------------------------

Deno.test("unstable_batchedUpdates runs fn(arg) and returns its result", () => {
  const seen: number[] = [];
  const out = unstable_batchedUpdates((n: number) => {
    seen.push(n);
    return n * 2;
  }, 21);
  assertEquals(out, 42);
  assertEquals(seen, [21]);
});

Deno.test("react-dom reports a React 19 version and a populated default namespace", () => {
  assertEquals(version, REACT_COMPAT_VERSION);
  assertEquals(ReactDOM.version, REACT_COMPAT_VERSION);
  for (
    const key of ["createRoot", "hydrateRoot", "flushSync", "render", "hydrate", "createPortal"]
  ) {
    assertEquals(typeof (ReactDOM as Record<string, unknown>)[key], "function", key);
  }
});
