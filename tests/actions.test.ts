import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { useActionState, useFormStatus } from "../src/runtime/actions.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

Deno.test("form action={fn} is not serialized as an attribute during SSR", async () => {
  const html = await renderToString(
    h("form", { action: () => {} }, h("button", null, "Go")),
  );
  assertEquals(html, "<form><button>Go</button></form>");
});

Deno.test("useActionState runs the action on form submit and updates state", async () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  function Counter(): VNode {
    const [count, submit, isPending] = useActionState<number, unknown>(
      (prev) => prev + 1,
      0,
    );
    return h("form", { action: submit }, [
      h("output", null, String(count)),
      h("span", null, isPending ? "…" : "ready"),
    ]);
  }
  createRoot(asEl(container)).render(h(Counter, null));
  const form = container.childNodes[0] as FakeElement;
  assertEquals((form.childNodes[0] as FakeElement).textContent, "0");

  // Simulate a form submit — the reconciler intercepts and calls the action.
  form.dispatch("submit");
  await tick();
  flushSync();
  assertEquals((form.childNodes[0] as FakeElement).textContent, "1");
});

Deno.test("useActionState supports async actions", async () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  function Form(): VNode {
    const [msg, submit] = useActionState<string, unknown>(
      async () => {
        await Promise.resolve();
        return "done";
      },
      "idle",
    );
    return h("form", { action: submit }, h("output", null, msg));
  }
  createRoot(asEl(container)).render(h(Form, null));
  const form = container.childNodes[0] as FakeElement;
  assertEquals((form.childNodes[0] as FakeElement).textContent, "idle");

  form.dispatch("submit");
  await tick();
  await tick();
  flushSync();
  assertEquals((form.childNodes[0] as FakeElement).textContent, "done");
});

Deno.test("useFormStatus is not pending during SSR", async () => {
  const html = await renderToString(
    h(function S(): VNode {
      const { pending } = useFormStatus();
      return h("span", null, pending ? "pending" : "idle");
    }, null),
  );
  assertEquals(html, "<span>idle</span>");
});

Deno.test("useActionState permalink renders as the SSR form action (no-JS fallback)", async () => {
  const html = await renderToString(
    h(function Form(): VNode {
      const [, submit] = useActionState<number, unknown>((s) => s, 0, "/submit-fallback");
      return h("form", { action: submit }, h("button", null, "Go"));
    }, null),
  );
  assert(html.includes(`action="/submit-fallback"`), html);
});

Deno.test("useActionState without a permalink renders no form action attribute", async () => {
  const html = await renderToString(
    h(function Form(): VNode {
      const [, submit] = useActionState<number, unknown>((s) => s, 0);
      return h("form", { action: submit }, h("button", null, "Go"));
    }, null),
  );
  assert(!html.includes("action="), html);
});
