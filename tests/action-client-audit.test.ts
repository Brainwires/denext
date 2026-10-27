// The browser half of Server Actions and the hook-boundary gate, as the AU5 audit
// (plans/audit-4.8-client-runtime.md) left them: the caller's FormData is never written to (a
// re-sent FormData carried the first call's arguments), a dispatch chunk that failed to load is
// retried by the next call instead of failing every action until a reload, and a build whose
// scan saw no `useErrorBoundary` reports a call it meets instead of letting errors pass it by.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { encodeActionArgs } from "../src/client/action-dispatch.ts";
import { prepareWire } from "../src/runtime/wire-encode.ts";
import { decodeActionArgs } from "../src/runtime/server-action.ts";
import { __setActionDispatchImportForTests, clientActionStub } from "../src/runtime/action-stub.ts";
import { useErrorBoundary } from "../src/compat/preact/hooks.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { render } from "../src/testing/mod.ts";

/** The arguments the server decodes from the body `encodeActionArgs` built. */
function serverArgs(args: unknown[]): Promise<unknown[]> {
  const { body, headers } = encodeActionArgs(args, prepareWire);
  return decodeActionArgs(new Request("http://localhost/x", { method: "POST", body, headers }));
}

Deno.test("encodeActionArgs leaves the caller's FormData as it was", async () => {
  const fd = new FormData();
  fd.append("title", "hello");
  const first = await serverArgs([fd, 1]);
  assertEquals([...fd.keys()], ["title"], "no reserved field written into the caller's form");
  assertEquals(first[1], 1);
  // The same FormData sent again with another argument: the server sees the new one.
  const second = await serverArgs([fd, 2]);
  assertEquals(second[1], 2, "not the first call's arguments");
  assertEquals((second[0] as FormData).getAll("title"), ["hello"]);
});

Deno.test("a dispatch chunk that failed to load is imported again by the next call", async () => {
  let attempts = 0;
  __setActionDispatchImportForTests(() => {
    attempts++;
    return attempts === 1
      ? Promise.reject(new TypeError("Failed to fetch dynamically imported module"))
      : Promise.resolve({
        dispatchAction: (id: string, args: unknown[]) => Promise.resolve({ id, args }),
      } as never);
  });
  try {
    const stub = clientActionStub<[number], unknown>("a1");
    await assertRejects(() => stub(1), TypeError, "Failed to fetch");
    assertEquals(await stub(2), { id: "a1", args: [2] }, "the next call loads the chunk again");
    assertEquals(attempts, 2);
  } finally {
    __setActionDispatchImportForTests(null);
  }
});

/** A component that is a Preact error boundary. */
function Guard() {
  useErrorBoundary();
  return h("p", null, "ok");
}

Deno.test("useErrorBoundary in a build with the hook-boundary gate off reports it (error 7)", async () => {
  const g = globalThis as { __DENEXT_HOOK_BOUNDARIES__?: boolean };
  const seen: unknown[] = [];
  const onError = (e: ErrorEvent) => {
    e.preventDefault();
    seen.push(e.error);
  };
  addEventListener("error", onError);
  g.__DENEXT_HOOK_BOUNDARIES__ = false;
  try {
    const screen = await render(h(Guard, null));
    assertEquals(seen.length, 1);
    const message = String((seen[0] as Error).message);
    assert(message.includes("Guard") && message.includes("useErrorBoundary"), message);
    await screen.rerender(h(Guard, null));
    assertEquals(seen.length, 1, "reported once");
    await screen.unmount();
  } finally {
    delete g.__DENEXT_HOOK_BOUNDARIES__;
    removeEventListener("error", onError);
  }
});
