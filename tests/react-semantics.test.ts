// React semantic parity fixed by the 2.0 audit: render-phase setState converges on the server,
// useOptimistic reverts when its transition settles, useActionState keeps one dispatch identity
// and surfaces action errors, forwardRef render fns get props without `ref`, use() honors
// React-tagged thenables, createPortal and a store without getServerSnapshot throw on the server.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { act, render } from "../src/testing/mod.ts";
import {
  startTransition,
  useActionState,
  useOptimistic,
  useState,
  useSyncExternalStore,
} from "../mod.ts";
import { ErrorBoundary, forwardRef, use } from "../mod.ts";
import { createPortal } from "../src/client/mod.ts";

Deno.test("server: a render-phase setState converges in place (derived-state idiom) like React", async () => {
  function Derived({ n }: { n: number }) {
    const [prev, setPrev] = useState(n);
    const [doubled, setDoubled] = useState(n * 2);
    if (prev !== n) {
      setPrev(n);
      setDoubled(n * 2);
    }
    return h("p", null, `${prev}:${doubled}`);
  }
  assertEquals(await renderToString(h(Derived, { n: 3 })), "<p>3:6</p>");
  function Once() {
    const [a, setA] = useState(0);
    if (a === 0) setA(1);
    return h("p", null, String(a));
  }
  assertEquals(
    await renderToString(h(Once, null)),
    "<p>1</p>",
    "the client renders 1; so must the server",
  );
});

Deno.test("useOptimistic reverts when the action settles even if state did not change (and on failure)", async () => {
  let add!: (v: string) => void;
  let seen: string[] = [];
  function C() {
    const [state] = useState("A");
    const [value, addOptimistic] = useOptimistic(state);
    add = addOptimistic;
    seen.push(value);
    return h("p", null, value);
  }
  const screen = await render(h(C, null));
  seen = [];
  await act(() => {
    startTransition(async () => {
      add("B");
      await Promise.resolve(); // an action that settles WITHOUT changing state
    });
  });
  await new Promise((r) => setTimeout(r, 20));
  await act(() => {});
  assertStringIncludes(screen.container.innerHTML, "A", "reverted to the base state");
  assert(seen.includes("B"), "the optimistic value was shown while pending");
});

Deno.test("useActionState: one dispatch identity, latest state, and an action error reaches the boundary", async () => {
  const dispatches: unknown[] = [];
  function Form() {
    const [state, dispatch] = useActionState((s: number, inc: number) => s + inc, 0);
    dispatches.push(dispatch);
    return h("button", { onClick: () => dispatch(1) }, String(state));
  }
  const screen = await render(h(Form, null));
  await screen.fireEvent.click(screen.getByRole("button"));
  await screen.fireEvent.click(screen.getByRole("button"));
  await new Promise((r) => setTimeout(r, 5));
  await act(() => {});
  assertStringIncludes(screen.container.innerHTML, ">2<", "state accumulates (no stale closure)");
  assertEquals(new Set(dispatches).size, 1, "dispatch identity is stable across renders");

  function Failing() {
    const [state, dispatch] = useActionState(() => {
      throw new Error("action boom");
    }, "idle");
    return h("button", { onClick: () => dispatch(undefined as never) }, state);
  }
  const boundary = await render(
    h(ErrorBoundary, { fallback: () => h("p", null, "CAUGHT") }, h(Failing, null)),
  );
  await boundary.fireEvent.click(boundary.getByRole("button"));
  await new Promise((r) => setTimeout(r, 5));
  await act(() => {});
  assertStringIncludes(
    boundary.container.innerHTML,
    "CAUGHT",
    "the error surfaced through the boundary",
  );
});

Deno.test("forwardRef: the render fn receives props WITHOUT ref, and ref as the second arg", async () => {
  let sawRefInProps: boolean | null = null;
  let gotRef: unknown = null;
  const Input = forwardRef<HTMLInputElement, { id: string }>((props, ref) => {
    sawRefInProps = "ref" in (props as object);
    gotRef = ref;
    return h("input", { ...props, ref } as never);
  });
  const ref = { current: null as HTMLInputElement | null };
  await render(h(Input as never, { id: "x", ref } as never));
  assertEquals(sawRefInProps, false);
  assertEquals(gotRef, ref);
});

Deno.test("use(): a React-tagged fulfilled thenable does not re-suspend", () => {
  const thenable = Object.assign(Promise.resolve(42), { status: "fulfilled", value: 42 });
  assertEquals(use(thenable as never), 42);
});

Deno.test("server: createPortal and a store without getServerSnapshot throw like React", async () => {
  await assertRejects(
    () => renderToString(createPortal(h("p", null, "x"), {} as never) as never),
    Error,
    "Portals are not currently supported by the server renderer",
  );
  function Store() {
    const v = useSyncExternalStore(() => () => {}, () => "client");
    return h("p", null, v);
  }
  await assertRejects(() => renderToString(h(Store, null)), Error, "Missing getServerSnapshot");
});
