// Regression guards for the pre-2.0.0 whole-app audit (React surface): hooks-order guard,
// dynamic() loading props, Children null guards, cloneElement key coercion, composeRefs
// cleanups, createSlot, bigint children, useFormStatus submission details, and the root
// barrel's React helpers.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { useState } from "../src/runtime/hooks.ts";
import { Children, cloneElement } from "../src/runtime/react-core.ts";
import { dynamic } from "../src/runtime/dynamic.ts";
import { composeRefs } from "../src/compat/refs.ts";
import { createSlot, createSlottable, Slot, Slottable } from "../src/compat/slot.ts";
import { Activity, cache, ViewTransition } from "../mod.ts";
import { useFormStatus } from "../src/runtime/actions.ts";
import { render } from "../src/testing/mod.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

type Any = never;

Deno.test("rules of hooks: a mounted component rendering MORE hooks than before throws", () => {
  const { doc: document } = makeDom();
  setDocument(document as unknown as Document);
  let setExtra: (v: boolean) => void = () => {};
  function Comp() {
    const [extra, set] = useState(false);
    setExtra = set;
    // deno-lint-ignore denext/rules-of-hooks
    if (extra) useState(0); // conditional hook — a Rules-of-Hooks violation (on purpose)
    return h("p", null, extra ? "extra" : "base");
  }
  const container = document.createElement("div");
  const root = createRoot(container as unknown as Element);
  flushSync(() => root.render(h(Comp, null)));
  assertEquals(container.textContent, "base");
  assertThrows(
    () => flushSync(() => setExtra(true)),
    Error,
    "Rendered more hooks than during the previous render",
  );
  root.unmount();
});

Deno.test("dynamic(): the `loading` component receives Next's loading props", async () => {
  // ssr:false → the server renders the loading component (with Next's props) in place.
  const Slow = dynamic(() => new Promise<{ default: () => VNode }>(() => {}), {
    ssr: false,
    loading: (p) => h("i", null, `${p.isLoading}/${p.pastDelay}/${p.error === null}`),
  });
  const html = await renderToString(h(Slow, null));
  assertStringIncludes(html, "<i>true/true/true</i>");
});

Deno.test("Children: forEach/count/toArray tolerate null and undefined", () => {
  let calls = 0;
  Children.forEach(null, () => calls++);
  Children.forEach(undefined, () => calls++);
  assertEquals(calls, 0);
  assertEquals(Children.count(null), 0);
  assertEquals(Children.toArray(null), []);
  assertEquals(Children.toArray(undefined), []);
  assertEquals(Children.toArray([h("a", null), null, "t"]).length, 2);
});

Deno.test("cloneElement coerces a numeric key to a string, like React", () => {
  const el = h("div", { key: 1 });
  assertEquals(cloneElement(el, { key: 2 }).key, "2");
  assertEquals(cloneElement(el, { key: "k" }).key, "k");
  assertEquals(cloneElement(el).key, 1, "no config: the original key is kept as authored");
});

Deno.test("composeRefs: runs each callback ref's returned cleanup on detach (React 19)", () => {
  const events: string[] = [];
  const objRef = { current: null as HTMLElement | null };
  const withCleanup = (node: HTMLElement | null) => {
    events.push(`attach:${node ? "el" : "null"}`);
    return () => events.push("cleanup");
  };
  const plain = (node: HTMLElement | null) => events.push(`plain:${node ? "el" : "null"}`);
  const composed = composeRefs<HTMLElement>(objRef, withCleanup, plain);
  const el = {} as HTMLElement;
  const cleanup = composed(el);
  assertEquals(objRef.current, el);
  cleanup();
  assertEquals(objRef.current, null, "an object ref is nulled on detach");
  assertEquals(events, ["attach:el", "plain:el", "cleanup", "plain:null"]);
});

Deno.test("createSlot / createSlottable (Radix 1.2) behave like Slot / Slottable", async () => {
  const OwnedSlot = createSlot("Button");
  assertEquals((OwnedSlot as { displayName?: string }).displayName, "Button.Slot");
  assertEquals(createSlottable("Button"), Slottable);
  const html = await renderToString(
    h(OwnedSlot as Any, { className: "btn", "data-x": "1" }, h("a", { href: "/", className: "a" })),
  );
  assertStringIncludes(html, 'class="btn a"');
  assertStringIncludes(html, 'data-x="1"');
  void Slot;
});

Deno.test("a bigint child renders as text (SSR)", async () => {
  assertStringIncludes(
    await renderToString(h("p", null, 9007199254740993n)),
    "<p>9007199254740993</p>",
  );
});

Deno.test("root barrel: cache / Activity / ViewTransition are available from `denext`", async () => {
  let calls = 0;
  const memo = cache((n: number) => (calls++, n * 2));
  assertEquals(memo(2), 4);
  assertEquals(memo(2), 4);
  assertEquals(calls, 1, "memoized");
  const html = await renderToString(
    h(Activity, { mode: "visible" }, h(ViewTransition, null, h("b", null, "x"))),
  );
  assertStringIncludes(html, "<b>x</b>");
});

Deno.test("useFormStatus exposes the pending submission's data/method/action", async () => {
  let resolveAction: () => void = () => {};
  const action = () => new Promise<void>((r) => (resolveAction = r));
  const seen: string[] = [];
  function Status() {
    const s = useFormStatus();
    seen.push(
      s.pending
        ? `pending:${s.data instanceof FormData ? "formdata" : "nodata"}:${s.method}:${
          typeof s.action === "function" ? "fn" : "none"
        }`
        : "idle",
    );
    return h("output", null, s.pending ? "busy" : "idle");
  }
  const screen = await render(
    h("form", { action, "data-testid": "f" }, h("input", { name: "q" }), h(Status, null)),
  );
  assertEquals(seen.at(-1), "idle");
  await screen.fireEvent.submit(screen.getByTestId("f"));
  assert(seen.some((s) => s.startsWith("pending:")), `saw a pending status: ${seen.join(",")}`);
  const pending = seen.find((s) => s.startsWith("pending:"))!;
  assertStringIncludes(pending, ":post:fn");
  resolveAction();
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(seen.at(-1), "idle", "back to idle once the action settles");
});
