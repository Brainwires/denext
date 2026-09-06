// `useApi` (src/client/use-api.ts): the typed client as a hook — lifecycle, errors, refetch,
// tag invalidation through an installed source, entry ref-counting, and Suspense mode seeded
// from the hydration state. Rendered with the real reconciler into a fake DOM; the "client" is a
// stub so no network or server is involved (the wire is covered by tests/api-types.test.ts).

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";
import { setApiInvalidationSource, useApi } from "../src/client/use-api.ts";
import { type ApiClient, ApiClientError, type ApiSchema } from "../src/runtime/api-client.ts";
import { setAdoptedSignalState } from "../src/runtime/signal-state.ts";
import { Suspense } from "../src/runtime/suspense.ts";

type Any = any;

/** A controllable stub client: every call returns a promise the test settles. */
function stubClient() {
  const calls: { path: string; method: string; opts: unknown }[] = [];
  const pending: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  const client = ((path: string, method: string, opts?: unknown) => {
    calls.push({ path, method, opts });
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  }) as unknown as ApiClient<ApiSchema>;
  return { client, calls, pending };
}

/** Let settled promises propagate (the store notifies listeners on a microtask). */
const tick = () => new Promise((r) => setTimeout(r, 0));

function mount(node: unknown) {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  root.render(node as Any);
  flushSync();
  return { root, container };
}

Deno.test("useApi: pending → data; the fetch starts after mount and is not repeated on re-render", async () => {
  const { client, calls, pending } = stubClient();
  let renders = 0;
  function App() {
    renders++;
    const { data, pending: p } = useApi("/api/hello" as never, "GET" as never, undefined, {
      client,
    });
    return h("span", null, p ? "loading" : JSON.stringify(data));
  }
  const { root, container } = mount(h(App, null));
  assertEquals(container.textContent, "loading");
  assertEquals(calls.length, 1, "one fetch after mount");
  pending[0].resolve({ hello: "world" });
  await tick();
  flushSync();
  assertEquals(container.textContent, '{"hello":"world"}');
  root.render(h(App, null));
  flushSync();
  assertEquals(calls.length, 1, "a re-render does not refetch");
  assert(renders >= 2);
  root.unmount();
});

Deno.test("useApi: a failed call surfaces the ApiClientError; refetch() tries again", async () => {
  const { client, calls, pending } = stubClient();
  let refetch: () => Promise<void> = () => Promise.resolve();
  function App() {
    const r = useApi("/api/boom" as never, "GET" as never, undefined, { client });
    refetch = r.refetch;
    return h("span", null, r.error ? `${r.error.status}:${r.error.code}` : r.pending ? "…" : "ok");
  }
  const { root, container } = mount(h(App, null));
  const res = new Response(null, { status: 409, statusText: "Conflict" });
  pending[0].reject(new ApiClientError("GET", "/api/boom", res, { error: { code: "conflict" } }));
  await tick();
  flushSync();
  assertEquals(container.textContent, "409:conflict");
  const p = refetch();
  assertEquals(calls.length, 2);
  pending[1].resolve("fine");
  await p;
  flushSync();
  assertEquals(container.textContent, "ok");
  root.unmount();
});

Deno.test("useApi: `tags` subscribe through the installed invalidation source and refetch on invalidate", async () => {
  const { client, calls, pending } = stubClient();
  const watched: { tags: string[]; fire: () => void; unsubscribed: boolean }[] = [];
  setApiInvalidationSource((tags, onInvalidate) => {
    const w = { tags, fire: onInvalidate, unsubscribed: false };
    watched.push(w);
    return () => {
      w.unsubscribed = true;
    };
  });
  const App = () => {
    const { data } = useApi("/api/count" as never, "GET" as never, undefined, {
      client,
      tags: ["counter"],
    });
    return h("span", null, String(data ?? "-"));
  };
  try {
    const { root, container } = mount(h(App, null));
    assertEquals(watched.length, 1);
    assertEquals(watched[0].tags, ["counter"]);
    pending[0].resolve(1);
    await tick();
    flushSync();
    assertEquals(container.textContent, "1");
    watched[0].fire(); // the server invalidated the tag
    assertEquals(calls.length, 2, "an invalidation refetches");
    pending[1].resolve(2);
    await tick();
    flushSync();
    assertEquals(container.textContent, "2");
    root.unmount();
    assertEquals(watched[0].unsubscribed, true, "unmount unsubscribes the watch");
  } finally {
    setApiInvalidationSource(null);
  }
});

Deno.test("useApi: enabled:false never fetches; unmounting the last hook drops the entry", async () => {
  const { client, calls, pending } = stubClient();
  function App({ on }: { on: boolean }) {
    const { pending: p } = useApi("/api/x" as never, "GET" as never, undefined, {
      client,
      enabled: on,
    });
    return h("span", null, p ? "idle" : "done");
  }
  const { root, container } = mount(h(App, { on: false }));
  assertEquals([container.textContent, calls.length], ["idle", 0]);
  root.render(h(App, { on: true }));
  flushSync();
  assertEquals(calls.length, 1);
  pending[0].resolve(1);
  await tick();
  flushSync();
  assertEquals(container.textContent, "done");
  root.unmount();
  // A fresh mount after the entry was dropped fetches again (not served from a stale table).
  const again = mount(h(App, { on: true }));
  assertEquals(calls.length, 2, "the entry did not outlive its last hook");
  again.root.unmount();
});

Deno.test("useApi: suspense mode adopts the SSR-recorded value and never refetches on hydration", () => {
  const { client, calls } = stubClient();
  // The server recorded `{ v, enc }` under the hook's position-derived `useId()`; the entry
  // installs that map before hydration. A Proxy answers for whatever id the hook derives.
  function App() {
    const { data } = useApi("/api/when" as never, "GET" as never, undefined, {
      client,
      suspense: true,
    });
    const at = (data as unknown as { at: Date }).at;
    return h("span", null, at instanceof Date ? "date" : String(data));
  }
  const recorded: Record<string, unknown> = {};
  const proxy = new Proxy(recorded, {
    has: () => true,
    get: (
      _t,
      id,
    ) => (typeof id === "string"
      ? { v: { at: { $: "D", v: "1970-01-01T00:00:00.000Z" } }, enc: 1 }
      : undefined),
    getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, value: undefined }),
  });
  setAdoptedSignalState(proxy as Any);
  try {
    const { root, container } = mount(
      h(Suspense, { fallback: h("span", null, "fallback"), children: h(App, null) }),
    );
    assertEquals(container.textContent, "date", "hydrated from the recorded value (decoded)");
    assertEquals(calls.length, 0, "no refetch on hydration");
    root.unmount();
  } finally {
    setAdoptedSignalState(null);
  }
});

Deno.test("useApi: suspense mode without a recorded value suspends, then renders the data", async () => {
  const { client, pending } = stubClient();
  function App() {
    const { data } = useApi("/api/n" as never, "GET" as never, undefined, {
      client,
      suspense: true,
    });
    return h("span", null, String(data));
  }
  const { root, container } = mount(
    h(Suspense, { fallback: h("span", null, "fallback"), children: h(App, null) }),
  );
  assertEquals(container.textContent, "fallback");
  pending[0].resolve(42);
  await tick();
  flushSync();
  assertEquals(container.textContent, "42");
  root.unmount();
});
