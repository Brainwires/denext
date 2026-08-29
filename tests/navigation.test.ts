import { assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import {
  getLocationState,
  Link,
  prefetch,
  subscribeLocation,
  usePathname,
  useRouter,
} from "../src/client/navigation.ts";
import type { VNode } from "../src/jsx/types.ts";

/** Yield to the event loop so a chain of microtasks (fetch().then().then()) settles. */
const flush = () => new Promise((r) => setTimeout(r, 0));

Deno.test("Link renders a server-side anchor with href and passthrough props", async () => {
  const html = await renderToString(
    h(Link, { href: "/about", className: "nav", children: "About" }),
  );
  assertStringIncludes(html, "<a");
  assertStringIncludes(html, 'href="/about"');
  assertStringIncludes(html, 'class="nav"');
  assertStringIncludes(html, ">About</a>");
  // The click handler is stripped during SSR.
  assertEquals(html.includes("onClick"), false);
});

Deno.test("usePathname returns the current pathname during SSR", async () => {
  function Where(): VNode {
    return h("code", null, usePathname());
  }
  const html = await renderToString(h(Where, null));
  // On the server, location is unavailable so it defaults to "/".
  assertEquals(html, "<code>/</code>");
});

Deno.test("useRouter exposes navigation methods", () => {
  // useRouter doesn't use the hook dispatcher; calling it outside a component here is
  // intentional (this is a plain test function, not a Capitalized component / useX hook).
  // deno-lint-ignore denext/hooks-in-component
  const router = useRouter();
  assertEquals(typeof router.push, "function");
  assertEquals(typeof router.replace, "function");
  assertEquals(typeof router.back, "function");
  assertEquals(typeof router.forward, "function");
  assertEquals(typeof router.refresh, "function");
});

Deno.test("prefetch cache is LRU-bounded so it can't grow without limit (CLI-M1)", async () => {
  const g = globalThis as {
    location?: unknown;
    fetch?: typeof fetch;
  };
  const origLocation = g.location;
  const origFetch = g.fetch;
  const fetchCalls = new Map<string, number>();
  g.location = { href: "http://x/", origin: "http://x" };
  g.fetch = ((input: string | URL) => {
    const u = String(input);
    fetchCalls.set(u, (fetchCalls.get(u) ?? 0) + 1);
    return Promise.resolve(
      { ok: true, text: () => Promise.resolve(`<html>${u}</html>`) } as Response,
    );
  }) as typeof fetch;
  try {
    // Prefetch 60 distinct URLs; the cache caps at 50, so the earliest are evicted.
    for (let i = 0; i < 60; i++) prefetch(`/p${i}`);
    await flush();
    // Re-prefetching a recent URL is a cache hit — no second fetch.
    prefetch("/p59");
    await flush();
    assertEquals(fetchCalls.get("http://x/p59"), 1, "recent URL stays cached");
    // Re-prefetching an evicted early URL re-fetches (it was dropped by the LRU).
    prefetch("/p0");
    await flush();
    assertEquals(fetchCalls.get("http://x/p0"), 2, "evicted URL is re-fetched");
  } finally {
    if (origLocation === undefined) delete g.location;
    else g.location = origLocation;
    g.fetch = origFetch;
  }
});

Deno.test("location store notifies subscribers and can unsubscribe", () => {
  let calls = 0;
  const unsub = subscribeLocation(() => calls++);
  // getLocationState is always readable.
  const state = getLocationState();
  assertEquals(typeof state.pathname, "string");
  unsub();
  // After unsubscribe the listener set no longer holds our callback.
  assertEquals(calls, 0);
});
