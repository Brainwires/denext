// RootOptions error callbacks (React 19 parity): createRoot/hydrateRoot accept
// onCaughtError / onUncaughtError / onRecoverableError and invoke them at the
// matching points, WITHOUT changing denext's default behavior (a boundary still
// catches, an uncaught error still surfaces, the client render is still kept on a
// hydration mismatch).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, hydrateRoot, setDocument } from "../src/client/reconciler.ts";
import { ErrorBoundary } from "../src/runtime/error-boundary.ts";
import { useLayoutEffect } from "../src/runtime/hooks.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

function Fallback(props: { error: Error }): VNode {
  return h("p", null, `fb: ${props.error.message}`);
}

Deno.test("onCaughtError fires when a boundary catches a render error", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const caught: Array<{ msg: string; stack?: string }> = [];
  function Boom(): VNode {
    throw new Error("render boom");
  }
  const root = createRoot(asEl(container), {
    onCaughtError: (e, info) =>
      caught.push({ msg: (e as Error).message, stack: info.componentStack }),
  });
  root.render(h(ErrorBoundary, { fallback: Fallback, children: h(Boom, null) }));

  // Default behavior is unchanged: the boundary still renders its fallback.
  assertEquals(container.innerHTML, "<p>fb: render boom</p>");
  // ...and the callback observed it, with a component stack.
  assertEquals(caught.length, 1);
  assertEquals(caught[0].msg, "render boom");
  assert(caught[0].stack && caught[0].stack.length > 0, "a componentStack is provided");
  root.unmount();
});

Deno.test("onCaughtError fires for an effect error caught by a boundary", async () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const caught: string[] = [];
  function Boom(): VNode {
    useLayoutEffect(() => {
      throw new Error("effect boom");
    }, []);
    return h("span", null, "ok");
  }
  const root = createRoot(asEl(container), {
    onCaughtError: (e) => caught.push((e as Error).message),
  });
  root.render(h(ErrorBoundary, { fallback: Fallback, children: h(Boom, null) }));
  // Effect errors route on a microtask (they run inside commit).
  await Promise.resolve();
  flushSync();
  assertEquals(container.innerHTML, "<p>fb: effect boom</p>");
  assertEquals(caught, ["effect boom"]);
  root.unmount();
});

Deno.test("onUncaughtError fires, then the error still surfaces, when no boundary catches", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const uncaught: string[] = [];
  function Boom(): VNode {
    throw new Error("no boundary");
  }
  const root = createRoot(asEl(container), {
    onUncaughtError: (e) => uncaught.push((e as Error).message),
  });
  let threw = false;
  try {
    root.render(h(Boom, null));
  } catch (e) {
    threw = true;
    assertEquals((e as Error).message, "no boundary");
  }
  assert(threw, "an uncaught error must still surface (default behavior preserved)");
  assertEquals(uncaught, ["no boundary"]);
});

Deno.test("onRecoverableError fires on a hydration mismatch (regardless of dev mode)", () => {
  // Ensure dev mode is OFF: the callback must fire in production too (React parity),
  // and it replaces the dev-only console warning.
  const g = globalThis as { __denextDev?: boolean };
  const prevDev = g.__denextDev;
  delete g.__denextDev;
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  // Server rendered <div>hi</div>; the client hydrates <span>hi</span>.
  const div = doc.createElement("div");
  div.appendChild(doc.createTextNode("hi"));
  container.appendChild(div);

  const recovered: Array<{ msg: string; stack?: string }> = [];
  try {
    hydrateRoot(asEl(container), h("span", null, "hi"), {
      onRecoverableError: (e, info) =>
        recovered.push({ msg: (e as Error).message, stack: info.componentStack }),
    });
  } finally {
    if (prevDev !== undefined) g.__denextDev = prevDev;
  }
  assert(recovered.length >= 1, "onRecoverableError fired for the mismatch");
  assertStringIncludes(recovered[0].msg, "Hydration failed");
});

Deno.test("no callbacks → default behavior is unchanged (boundary catches, no throw)", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  function Boom(): VNode {
    throw new Error("silent");
  }
  const root = createRoot(asEl(container)); // no options
  root.render(h(ErrorBoundary, { fallback: Fallback, children: h(Boom, null) }));
  assertEquals(container.innerHTML, "<p>fb: silent</p>");
  root.unmount();
});
