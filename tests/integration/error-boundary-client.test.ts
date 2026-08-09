import { assertEquals } from "@std/assert";
import { h } from "../../src/jsx/jsx-runtime.ts";
import { createRoot, setDocument } from "../../src/client/reconciler.ts";
import { ErrorBoundary, isRedirect, notFound, redirect } from "../../src/runtime/error-boundary.ts";
import { useErrorBoundary } from "../../src/runtime/hooks.ts";
import type { VNode } from "../../src/jsx/types.ts";
import { type FakeDocument, type FakeElement, makeDom } from "../helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

function Fallback(props: { error: Error }): VNode {
  return h("p", null, `fallback: ${props.error.message}`);
}

Deno.test("client ErrorBoundary renders fallback on a real error", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  function Boom(): VNode {
    throw new Error("kaboom");
  }
  const root = createRoot(asEl(container));
  root.render(
    h(ErrorBoundary, { fallback: Fallback, children: h(Boom, null) }),
  );
  assertEquals(container.innerHTML, "<p>fallback: kaboom</p>");
  root.unmount();
});

Deno.test("redirect() bubbles past a client ErrorBoundary (not swallowed)", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  function Redirector(): VNode {
    redirect("/login");
  }
  const root = createRoot(asEl(container));
  let caught: unknown;
  try {
    root.render(
      h(ErrorBoundary, { fallback: Fallback, children: h(Redirector, null) }),
    );
  } catch (e) {
    caught = e;
  }
  assertEquals(isRedirect(caught), true);
  assertEquals((caught as { url: string }).url, "/login");
});

Deno.test("notFound() bubbles past a client ErrorBoundary (not swallowed)", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  function Missing(): VNode {
    notFound();
  }
  const root = createRoot(asEl(container));
  let threw = false;
  try {
    root.render(
      h(ErrorBoundary, { fallback: Fallback, children: h(Missing, null) }),
    );
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

// ---- 4c: event-handler + async error catching -----------------------------

function ResettableFallback(props: { error: Error; reset: () => void }): VNode {
  return h("button", { onClick: props.reset }, `fallback: ${props.error.message}`);
}

Deno.test("a throwing onClick renders the nearest boundary's fallback", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  function Clicker(): VNode {
    return h("button", {
      onClick: () => {
        throw new Error("handler-boom");
      },
    }, "click");
  }
  const root = createRoot(asEl(container));
  root.render(
    h(ErrorBoundary, { fallback: ResettableFallback, children: h(Clicker, null) }),
  );
  assertEquals(container.innerHTML, "<button>click</button>");

  (container.childNodes[0] as FakeElement).dispatch("click");
  assertEquals(container.innerHTML, "<button>fallback: handler-boom</button>");
  root.unmount();
});

Deno.test("useErrorBoundary().captureError shows the fallback; reset recovers", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  function Widget(): VNode {
    const eb = useErrorBoundary();
    return h("button", {
      onClick: () => eb.captureError(new Error("async-fail")),
    }, "ok");
  }
  const root = createRoot(asEl(container));
  root.render(
    h(ErrorBoundary, { fallback: ResettableFallback, children: h(Widget, null) }),
  );
  assertEquals(container.innerHTML, "<button>ok</button>");

  // captureError -> boundary shows the fallback.
  (container.childNodes[0] as FakeElement).dispatch("click");
  assertEquals(container.innerHTML, "<button>fallback: async-fail</button>");

  // reset (the fallback button) -> children re-render.
  (container.childNodes[0] as FakeElement).dispatch("click");
  assertEquals(container.innerHTML, "<button>ok</button>");
  root.unmount();
});

Deno.test("an onClick calling redirect() does not render the fallback", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  function RedirectingButton(): VNode {
    return h("button", {
      onClick: () => redirect("/login"),
    }, "go");
  }
  const root = createRoot(asEl(container));
  root.render(
    h(ErrorBoundary, {
      fallback: ResettableFallback,
      children: h(RedirectingButton, null),
    }),
  );
  assertEquals(container.innerHTML, "<button>go</button>");

  // In the test env `location` is undefined, so the redirect is a no-op — but
  // crucially it must NOT be routed to the boundary as a fallback.
  (container.childNodes[0] as FakeElement).dispatch("click");
  assertEquals(container.innerHTML, "<button>go</button>");
  root.unmount();
});
