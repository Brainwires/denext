// A function-valued form action's submit work is the on-demand form-action.ts chunk (an app with
// no such form ships none of it): dom-props.ts intercepts the submit itself, starts loading the
// runtime when such a form first renders, and a submit that beats the load is held for it, never
// sent natively.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { installFormActions, setFormActionRunner } from "../src/client/dom-props.ts";
import { runFormAction } from "../src/client/form-action.ts";
import { type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Render `<form action={action}>` and return the form element. */
function renderForm(action: (data: unknown) => unknown): FakeElement {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  createRoot(container as Any).render(h("form", { action }, h("button", null, "go")));
  flushSync();
  return container.childNodes[0] as FakeElement;
}

Deno.test("a submit before the form-action runtime loads is intercepted, then runs", async () => {
  setFormActionRunner(null); // as a fresh page: nothing loaded yet
  const calls: unknown[] = [];
  const form = renderForm((data) => calls.push(data));
  let prevented = false;
  form.dispatch("submit", { preventDefault: () => (prevented = true) });
  assert(prevented, "the submit is intercepted synchronously (never a native navigation)");
  assertEquals(calls.length, 0, "the action waits for its runtime");
  await installFormActions(); // the load the render started
  await tick();
  assertEquals(calls.length, 1, "the held submit runs once the runtime is in");
});

Deno.test("rendering a function-valued action starts the runtime's load", async () => {
  setFormActionRunner(null);
  const calls: unknown[] = [];
  const form = renderForm(() => calls.push("ran"));
  for (let i = 0; i < 20; i++) await tick(); // nothing but the render asked for the runtime
  form.dispatch("submit");
  assertEquals(calls, ["ran"], "loaded by the render: the submit runs synchronously");
});

Deno.test("the installed runner is form-action.ts's", async () => {
  setFormActionRunner(null);
  await installFormActions();
  const seen: unknown[] = [];
  setFormActionRunner((...args) => {
    seen.push(args[2][0]);
    runFormAction(...args);
  });
  const action = () => {};
  const form = renderForm(action);
  form.dispatch("submit");
  assertEquals(seen, [action]);
  setFormActionRunner(null);
  await installFormActions();
});
