// A submit button's function `formAction` (React 19's `<button formAction={fn}>`): the submit event
// fires at the FORM, never at the button, so the button arms its form (once it is in it, and again
// on a click) to run the button's action in place of the form's own, however the submit starts (a
// click, `form.requestSubmit(button)`); a submit that beats the on-demand runtime is held with its
// FormData and `useFormStatus` pending taken at the submit; a form whose only function action is a
// button's still has a `useFormStatus` signal; and a build whose scan saw no form action reports
// one it meets instead of letting the form submit natively in silence. AU5
// (plans/audit-4.8-client-runtime.md).

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { render, type TestElement } from "../src/testing/mod.ts";
import { DomEl } from "../src/testing/dom.ts";
import { installFormActions, setFormActionRunner } from "../src/client/dom-props.ts";
import { useFormStatus } from "../src/runtime/actions.ts";
import { useContext } from "../src/runtime/hooks.ts";
import { FormStatusContext, type FormStatusSignal } from "../src/runtime/form-status.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// A browser gives a button its form owner (`button.form`, the nearest ancestor `<form>`) as soon
// as it is in the form; the test DOM's elements get the same getter.
Object.defineProperty(DomEl.prototype, "form", {
  configurable: true,
  get(this: { parentNode?: unknown }) {
    for (let n = this.parentNode as Any; n; n = n.parentNode) if (n.tagName === "FORM") return n;
    return null;
  },
});

/** Render `ui` (a `<form>`); its buttons submit unless they say otherwise. */
async function renderForm(ui: Parameters<typeof render>[0]) {
  const screen = await render(ui);
  const form = (screen.container as Any).childNodes[0];
  for (const b of screen.getAllByRole("button")) (b as Any).type ??= "submit";
  return { screen, form };
}

/** Submit `form` as a browser does after a click on `submitter`; whether it was prevented. */
async function submitFrom(
  screen: Awaited<ReturnType<typeof render>>,
  form: TestElement,
  submitter: TestElement | null,
): Promise<boolean> {
  let prevented = false;
  await screen.fireEvent.submit(form, { submitter, preventDefault: () => (prevented = true) });
  return prevented;
}

Deno.test("a submit button's formAction runs on its form's submit (the form has no action)", async () => {
  const calls: string[] = [];
  const { screen, form } = await renderForm(
    h("form", null, h("button", { formAction: () => calls.push("button") }, "go")),
  );
  const button = screen.getByRole("button");
  await screen.fireEvent.click(button);
  assert(await submitFrom(screen, form, button), "the native submit is prevented");
  assertEquals(calls, ["button"]);
  await screen.unmount();
});

Deno.test("the submitter's formAction replaces the form's own action", async () => {
  const calls: string[] = [];
  const { screen, form } = await renderForm(
    h(
      "form",
      { action: () => calls.push("form") },
      h("button", { formAction: () => calls.push("delete") }, "delete"),
      h("button", null, "save"),
    ),
  );
  const [del, save] = screen.getAllByRole("button");
  await screen.fireEvent.click(del);
  assert(await submitFrom(screen, form, del));
  assertEquals(calls, ["delete"], "the button's action, not also the form's");
  await screen.fireEvent.click(save);
  assert(await submitFrom(screen, form, save));
  assertEquals(calls, ["delete", "form"], "another button submits with the form's action");
  // A later submit through the first button without a click (`form.requestSubmit(del)`) runs the
  // button's action again, as React does: the button, not a click, decides.
  assert(await submitFrom(screen, form, del));
  assertEquals(calls, ["delete", "form", "delete"]);
  await screen.unmount();
});

Deno.test("form.requestSubmit(button) with no click runs the button's formAction", async () => {
  const calls: string[] = [];
  const { screen, form } = await renderForm(
    h("form", null, h("button", { formAction: () => calls.push("button") }, "go")),
  );
  await tick(); // the commit is over: the button armed its form
  assert(await submitFrom(screen, form, screen.getByRole("button")), "never sent natively");
  assertEquals(calls, ["button"]);
  // A submit with no submitter (Enter in a form without a submit button's action) stays native.
  assertEquals(await submitFrom(screen, form, null), false);
  assertEquals(calls, ["button"]);
  await screen.unmount();
});

/** `useFormStatus()`'s pending flag and data, as text. */
function Status(): VNode {
  const { pending, data } = useFormStatus();
  return h("output", null, pending ? `P:${(data as unknown as { n?: number })?.n}` : "-");
}

Deno.test("a submit that beats the form-action runtime holds its FormData and pending from the submit", async () => {
  const calls: unknown[] = [];
  let built = 0;
  const RealFormData = globalThis.FormData;
  // The FormData a submit is built with, numbered in the order they are made.
  globalThis.FormData = class {
    n = ++built;
  } as unknown as typeof FormData;
  const grabbed: { signal: FormStatusSignal | null } = { signal: null };
  function Grab(): VNode {
    grabbed.signal = useContext(FormStatusContext);
    return h("i", null);
  }
  try {
    const { screen, form } = await renderForm(
      h(
        "form",
        null,
        h(Grab, null),
        h("button", { formAction: (d: unknown) => void calls.push(d) }, "go"),
      ),
    );
    await tick();
    const signal = grabbed.signal;
    assert(signal, "the form has a status signal");
    // Whether the form went pending inside the submit's own dispatch (before any later task).
    let dispatching = false;
    const pendingAt: boolean[] = [];
    signal.listeners.add(() => {
      if (signal.pending > 0) pendingAt.push(dispatching);
    });
    setFormActionRunner(null); // as a fresh page: the runtime is still loading
    let prevented = false;
    await screen.fireEvent.submit(form, {
      submitter: screen.getByRole("button"),
      preventDefault: () => {
        prevented = true;
        dispatching = true;
        queueMicrotask(() => (dispatching = false));
      },
    });
    assert(prevented, "held, never native");
    assertEquals(pendingAt[0], true, "pending from the submit itself");
    await installFormActions();
    await tick();
    assertEquals(calls.length, 1, "the held submit runs once the runtime is in");
    assertEquals((calls[0] as { n: number }).n, 1, "with the FormData taken at the submit");
    assertEquals(built, 1, "none is built when the runtime arrives");
    assertEquals(signal.pending, 0, "and it is no longer pending");
    await screen.unmount();
  } finally {
    globalThis.FormData = RealFormData;
  }
});

Deno.test("useFormStatus under a form whose only function action is a button's goes pending", async () => {
  let release!: () => void;
  const { screen, form } = await renderForm(
    h(
      "form",
      null,
      h(Status, null),
      h("button", { formAction: () => new Promise<void>((r) => (release = r)) }, "go"),
    ),
  );
  await installFormActions();
  await tick();
  assert(await submitFrom(screen, form, screen.getByRole("button")));
  await tick();
  assert(screen.container.textContent?.startsWith("P:"), String(screen.container.textContent));
  release();
  await tick();
  await tick();
  assertEquals(screen.container.textContent, "-go");
  await screen.unmount();
});

Deno.test("a non-submit button's formAction never runs on a click alone", async () => {
  const calls: string[] = [];
  const { screen } = await renderForm(
    h("form", null, h("button", { type: "button", formAction: () => calls.push("x") }, "go")),
  );
  const button = screen.getByRole("button") as Any;
  button.type = "button";
  await screen.fireEvent.click(button);
  await installFormActions();
  await tick();
  assertEquals(calls, [], "a click submits nothing: only a submit runs an action");
  await screen.unmount();
});

Deno.test("a build with the form-action gate off reports a function action (error 6)", async () => {
  const g = globalThis as { __DENEXT_FORM_ACTIONS__?: boolean };
  const seen: unknown[] = [];
  const onError = (e: ErrorEvent) => {
    e.preventDefault();
    seen.push(e.error);
  };
  addEventListener("error", onError);
  g.__DENEXT_FORM_ACTIONS__ = false;
  try {
    const screen = await render(h("form", { action: () => {} }, h("button", null, "go")));
    assertEquals(seen.length, 1);
    assert(String((seen[0] as Error).message).includes("form-action"), String(seen[0]));
    await screen.unmount();
  } finally {
    delete g.__DENEXT_FORM_ACTIONS__;
    removeEventListener("error", onError);
  }
});
