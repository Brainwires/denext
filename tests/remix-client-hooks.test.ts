// denext/remix client hooks that back optimistic UI + navigation guards: `useFetchers`
// (app-wide in-flight fetcher registry) and `useBlocker` (soft-nav veto). The fetcher
// registry is exercised directly (the value `useFetchers` reads); `useBlocker` is driven
// through the client render harness (effects run) with a stubbed `location`, so a real
// navigate attempt exercises the veto + the blocked→proceed/reset state machine.

import { assert, assertEquals } from "@std/assert";
import { h } from "denext/jsx-runtime";
import { render, waitFor } from "denext/testing";
import { navigate } from "../src/client/navigation.ts";
import {
  Await,
  type Blocker,
  buildRevalidationHeaders,
  getActiveFetchers,
  setFetcherSnapshot,
  useAsyncError,
  useBlocker,
} from "../src/compat/remix/client.ts";
import {
  FROM_HEADER,
  LOADER_DATA_HEADER,
  MAX_KEPT_DATA_CHARS,
  REVALIDATE_HEADER,
} from "../src/compat/remix/revalidation.ts";

Deno.test("useFetchers registry: surfaces in-flight fetchers, withdraws idle ones", () => {
  // A submitting fetcher and a loading one are active; an idle one with no data is withdrawn.
  setFetcherSnapshot("a", { state: "submitting", data: undefined, formData: new FormData() });
  setFetcherSnapshot("b", { state: "loading", data: undefined });
  const active = getActiveFetchers();
  assertEquals(active.map((f) => f.key).sort(), ["a", "b"]);
  assert(active.every((f) => f.state !== "idle"));

  // Settling `a` to idle (no data, no formData) removes it from the active set.
  setFetcherSnapshot("a", { state: "idle", data: undefined });
  assertEquals(getActiveFetchers().map((f) => f.key), ["b"]);

  // A settled fetcher that still carries data is idle → also not in the active (in-flight) set.
  setFetcherSnapshot("b", { state: "idle", data: { ok: true } });
  assertEquals(getActiveFetchers(), []);
});

Deno.test("buildRevalidationHeaders: offers ids + params + prior data; empty when nothing mounted", () => {
  assertEquals(buildRevalidationHeaders(new Map(), "/x", null), {});

  const matches = new Map<string, { params: Record<string, string>; data: unknown }>([
    ["root", { params: {}, data: { user: "ada" } }],
    ["routes/notes", { params: { noteId: "1" }, data: { list: [1, 2] } }],
  ]);
  const hdrs = buildRevalidationHeaders(matches, "/notes/1", null);
  assertEquals(hdrs[REVALIDATE_HEADER], "root,routes/notes");
  assertEquals(hdrs[FROM_HEADER], "/notes/1");
  // Both routes' data fit the budget → echoed for the server to keep.
  assertEquals(JSON.parse(hdrs[LOADER_DATA_HEADER]), {
    root: { user: "ada" },
    "routes/notes": { list: [1, 2] },
  });
});

Deno.test("buildRevalidationHeaders: a route whose data exceeds the budget is not echoed", () => {
  const big = "x".repeat(MAX_KEPT_DATA_CHARS + 100);
  const matches = new Map<string, { params: Record<string, string>; data: unknown }>([
    ["root", { params: {}, data: { small: true } }],
    ["routes/big", { params: {}, data: { blob: big } }],
  ]);
  const hdrs = buildRevalidationHeaders(matches, "/x", null);
  const echoed = JSON.parse(hdrs[LOADER_DATA_HEADER]);
  // The small route is offered; the oversized one is omitted (the server will revalidate it).
  assertEquals(echoed.root, { small: true });
  assert(!("routes/big" in echoed), "oversized data is not echoed");
  // But it's still listed as a mounted id.
  assertEquals(hdrs[REVALIDATE_HEADER], "root,routes/big");
});

Deno.test("useBlocker: blocks a soft nav, then reset returns to unblocked", async () => {
  const g = globalThis as { location?: unknown };
  const orig = g.location;
  g.location = { href: "http://x/a", origin: "http://x" };
  try {
    let latest: Blocker | undefined;
    const Guard = () => {
      const b = useBlocker(true);
      latest = b;
      return h("p", null, b.state);
    };
    const screen = await render(h(Guard, null));
    assertEquals(screen.getByText("unblocked").tagName, "P");

    // A user-initiated soft nav is vetoed and flips the blocker to "blocked".
    void navigate("/b");
    await waitFor(() => assertEquals(latest?.state, "blocked"));
    assertEquals(latest?.location?.pathname, "/b");
    assert(typeof latest?.reset === "function");

    // Reset cancels the blocked nav and returns to "unblocked".
    latest!.reset!();
    await waitFor(() => assertEquals(latest?.state, "unblocked"));
  } finally {
    if (orig === undefined) delete g.location;
    else g.location = orig;
  }
});

Deno.test("Await renders errorElement (with useAsyncError) on a rejected deferred value", async () => {
  const ErrView = () => {
    const err = useAsyncError();
    return h("p", null, err instanceof Error ? `err:${err.message}` : "no-error");
  };
  // The streaming path delivers a rejected `defer()` as this plain marker (in place of the value).
  const marker = { __dnxAwaitError: true, message: "loader boom" };
  const screen = await render(
    h(Await, {
      resolve: marker,
      errorElement: h(ErrView, null),
      children: h("span", null, "should-not-render"),
    }),
  );
  assertEquals(screen.getByText("err:loader boom").tagName, "P");
});

Deno.test("Await renders children (with useAsyncValue) on a resolved value", async () => {
  const screen = await render(
    h(Await, { resolve: { hi: 1 }, children: h("span", null, "ok") }),
  );
  assertEquals(screen.getByText("ok").tagName, "SPAN");
});

Deno.test("useBlocker(false) never blocks", async () => {
  const g = globalThis as { location?: unknown; fetch?: typeof fetch };
  const orig = g.location;
  const origFetch = g.fetch;
  let fetched = false;
  g.location = { href: "http://x/a", origin: "http://x" };
  // Record then HANG — a settled response drives navigateSameOrigin into DOMParser (absent
  // under Deno); a recorded fetch proves the unblocked nav proceeded.
  g.fetch = (() => {
    fetched = true;
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  try {
    let latest: Blocker | undefined;
    const Guard = () => {
      latest = useBlocker(false);
      return h("p", null, latest.state);
    };
    await render(h(Guard, null));
    void navigate("/b");
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(latest?.state, "unblocked");
    assert(fetched, "an unblocked nav proceeds to fetch the route");
  } finally {
    if (orig === undefined) delete g.location;
    else g.location = orig;
    g.fetch = origFetch;
  }
});
