// A submit button's function `formAction` (React 19's `<button formAction={fn}>`): the submit event
// fires at the FORM, never at the button, so the button's click readies its form to run the
// button's action (in place of the form's own), held clicks re-submit once the on-demand runtime
// is in, and a build whose scan saw no form action reports one it meets instead of letting the
// form submit natively in silence. AU5 (plans/audit-4.8-client-runtime.md).

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { render, type TestElement } from "../src/testing/mod.ts";
import { installFormActions, setFormActionRunner } from "../src/client/dom-props.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Render `ui` (a `<form>`), and give its buttons the form owner a browser gives them. */
async function renderForm(ui: Parameters<typeof render>[0]) {
  const screen = await render(ui);
  const form = (screen.container as Any).childNodes[0];
  for (const b of screen.getAllByRole("button")) {
    (b as Any).form = form;
    (b as Any).type ??= "submit";
  }
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

Deno.test("the submitter's formAction replaces the form's own action, once", async () => {
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
  // A later submit through the first button without a click (requestSubmit) does not reuse the
  // action its earlier click armed: it was taken by the submit it ran.
  assert(await submitFrom(screen, form, del));
  assertEquals(calls, ["delete", "form", "form"]);
  await screen.unmount();
});

Deno.test("a click that beats the form-action runtime is held, then re-submitted", async () => {
  const calls: string[] = [];
  const { screen, form } = await renderForm(
    h("form", null, h("button", { formAction: () => calls.push("button") }, "go")),
  );
  const button = screen.getByRole("button");
  const requested: unknown[] = [];
  form.requestSubmit = (s: unknown) => requested.push(s);
  setFormActionRunner(null); // as a fresh page: the runtime is still loading
  let prevented = false;
  await screen.fireEvent.click(button, { preventDefault: () => (prevented = true) });
  assert(prevented, "the click's native submit is held back");
  assertEquals(calls, [], "the action waits for its submit");
  await installFormActions();
  await tick();
  assertEquals(requested, [button], "the held click re-submits through its button");
  assert(await submitFrom(screen, form, button));
  assertEquals(calls, ["button"]);
  await screen.unmount();
});

Deno.test("a non-submit button's formAction never re-submits a held click", async () => {
  const { screen, form } = await renderForm(
    h("form", null, h("button", { type: "button", formAction: () => {} }, "go")),
  );
  const button = screen.getByRole("button") as Any;
  button.type = "button";
  const requested: unknown[] = [];
  form.requestSubmit = (s: unknown) => requested.push(s);
  setFormActionRunner(null);
  await screen.fireEvent.click(button);
  await installFormActions();
  await tick();
  assertEquals(requested, []);
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
