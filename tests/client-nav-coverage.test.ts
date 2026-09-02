// Coverage for the client soft-navigation runtime (`src/client/navigation.ts`)
// and island lazy-hydration (`src/client/lazy-hydrate.ts`).
//
// navigation.ts is browser-only in practice: every DOM/history/fetch access sits
// inside a function guarded by `typeof location/document === "undefined"`, so these
// tests drive both the no-DOM branch (direct calls) and the browser branch by
// stubbing `globalThis.location` / `document` / `history` / `fetch` and restoring
// them in a `finally`. lazy-hydrate.ts is driven through its injectable
// `LazyScheduler` seam (deterministic idle/visible/media) plus the real
// default scheduler where the environment lacks IntersectionObserver/matchMedia.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { h } from "denext/jsx-runtime";
import { render } from "denext/testing";
import {
  getLocationState,
  getNavigatingHref,
  Link,
  navigate,
  prefetch,
  setBasePath,
  setNavRequestProvider,
  setSoftNavBlocker,
  subscribeLocation,
  subscribeNavigating,
  useLinkStatus,
  useLocale,
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
  useSelectedLayoutSegment,
  useSelectedLayoutSegments,
  useTranslations,
  withViewTransition,
} from "../src/client/navigation.ts";
import {
  dispatchInteraction,
  getIslandTimeline,
  INTERACTION_EVENTS,
  type LazyScheduler,
  registerLazyIsland,
  resetLazyIslands,
  setLazyScheduler,
} from "../src/client/lazy-hydrate.ts";
import { MessagesContext } from "../src/runtime/i18n-messages.ts";
import { LayoutSegmentContext } from "../src/runtime/layout-segments.ts";

// deno-lint-ignore no-explicit-any
type AnyGlobal = any;

// ---- navigation.ts ---------------------------------------------------------

Deno.test("withViewTransition uses startViewTransition when present, else runs commit directly", () => {
  const g = globalThis as AnyGlobal;
  const origDoc = g.document;
  try {
    // Present: the commit runs *inside* startViewTransition.
    let svtCalls = 0;
    let committed = 0;
    g.document = {
      startViewTransition(cb: () => void) {
        svtCalls++;
        cb();
        return {};
      },
    };
    withViewTransition(() => committed++);
    assertEquals(svtCalls, 1);
    assertEquals(committed, 1);

    // Absent: commit runs synchronously (feature-detected, no throw).
    committed = 0;
    g.document = {};
    withViewTransition(() => committed++);
    assertEquals(committed, 1);
  } finally {
    if (origDoc === undefined) delete g.document;
    else g.document = origDoc;
  }
});

Deno.test("Link renders a basePath-prefixed anchor (idempotent) with its children", async () => {
  setBasePath("/app");
  try {
    const screen = await render(h(Link, { href: "/foo" }, "Go"));
    const anchor = screen.getByText("Go");
    assertEquals(anchor.tagName, "A");
    assertEquals(anchor.getAttribute("href"), "/app/foo");
    await screen.unmount();

    // Already prefixed: withBase is idempotent (no double "/app/app").
    const screen2 = await render(h(Link, { href: "/app/bar" }, "Bar"));
    assertEquals(screen2.getByText("Bar").getAttribute("href"), "/app/bar");
    await screen2.unmount();
  } finally {
    setBasePath("");
  }
});

Deno.test("useLinkStatus outside any <Link> reports not-pending", async () => {
  let status: { pending: boolean } | undefined;
  const Probe = () => {
    status = useLinkStatus();
    return h("span", null, String(useLinkStatus().pending));
  };
  const screen = await render(h(Probe, null));
  assertEquals(status?.pending, false);
  assert(screen.html().includes("false"));
  await screen.unmount();
});

Deno.test("usePathname / useSearchParams seed from the location store default", async () => {
  let path: string | undefined;
  let params: URLSearchParams | undefined;
  const Probe = () => {
    path = usePathname();
    params = useSearchParams();
    return h("span", null, path);
  };
  const screen = await render(h(Probe, null));
  // With no browser `location` at import time the store defaults to "/", "".
  assertEquals(path, "/");
  assert(params instanceof URLSearchParams);
  assertEquals(params?.get("missing"), null);
  await screen.unmount();
});

Deno.test("useParams / useLocale return empty defaults when no hydration island is present", async () => {
  let params: Record<string, string> | undefined;
  let locale: string | undefined;
  const Probe = () => {
    params = useParams();
    locale = useLocale();
    return h("span", null, "ok");
  };
  const screen = await render(h(Probe, null));
  assertEquals(params, {});
  assertEquals(locale, "");
  await screen.unmount();
});

Deno.test("useTranslations interpolates from the provided catalog; missing keys echo", async () => {
  let out = "";
  const Probe = () => {
    const t = useTranslations();
    out = `${t("greeting", { name: "Ada" })}|${t("nope")}`;
    return h("span", null, out);
  };
  const screen = await render(
    h(MessagesContext.Provider, { value: { greeting: "Hi {name}" } }, h(Probe, null)),
  );
  assertEquals(out, "Hi Ada|nope");
  await screen.unmount();
});

Deno.test("useSelectedLayoutSegment(s) slices path segments below the layout depth", async () => {
  let segments: string[] = [];
  let first: string | null = null;
  const Probe = () => {
    segments = useSelectedLayoutSegments();
    first = useSelectedLayoutSegment();
    return h("span", null, segments.join(","));
  };
  const screen = await render(
    h(
      LayoutSegmentContext.Provider,
      { value: { pathname: "/a/b/c", depth: 1 } },
      h(Probe, null),
    ),
  );
  assertEquals(segments, ["b", "c"]);
  assertEquals(first, "b");
  await screen.unmount();
});

Deno.test("useRouter().back()/forward() delegate to history", async () => {
  const g = globalThis as AnyGlobal;
  const origHistory = g.history;
  let back = 0;
  let forward = 0;
  g.history = { back: () => back++, forward: () => forward++ };
  try {
    let router: ReturnType<typeof useRouter> | undefined;
    const Probe = () => {
      router = useRouter();
      return h("span", null, "router");
    };
    const screen = await render(h(Probe, null));
    router!.back();
    router!.back();
    router!.forward();
    assertEquals(back, 2);
    assertEquals(forward, 1);
    await screen.unmount();
  } finally {
    if (origHistory === undefined) delete g.history;
    else g.history = origHistory;
  }
});

Deno.test("subscribeLocation returns a working unsubscribe; getLocationState shape", () => {
  const state = getLocationState();
  assertEquals(typeof state.pathname, "string");
  assertEquals(typeof state.search, "string");
  let fired = 0;
  const unsub = subscribeLocation(() => fired++);
  assertEquals(typeof unsub, "function");
  unsub();
  unsub(); // idempotent — a second call is harmless
  assertEquals(fired, 0);
});

Deno.test("prefetch: same-origin dedupes concurrent triggers; cross-origin and no-location are no-ops", async () => {
  const g = globalThis as AnyGlobal;
  const origLoc = g.location;
  const origFetch = g.fetch;
  let fetches = 0;
  g.location = { href: "http://localhost/", origin: "http://localhost" };
  g.fetch = () => {
    fetches++;
    return Promise.resolve(
      new Response("<html></html>", { headers: { "x-denext-flight": "0" } }),
    );
  };
  try {
    // Two triggers for the same URL: the in-flight marker dedupes to one fetch.
    prefetch("/pf-dedupe");
    prefetch("/pf-dedupe");
    assertEquals(fetches, 1);

    // Cross-origin is skipped entirely.
    prefetch("http://other.example/x");
    assertEquals(fetches, 1);

    await new Promise((r) => setTimeout(r, 0)); // let the fetch settle (store the body)
  } finally {
    if (origLoc === undefined) delete g.location;
    else g.location = origLoc;
    if (origFetch === undefined) delete g.fetch;
    else g.fetch = origFetch;
  }

  // No browser `location`: prefetch is an immediate no-op (server-safe).
  const g2 = globalThis as AnyGlobal;
  const savedLoc = g2.location;
  const savedFetch = g2.fetch;
  let serverFetches = 0;
  delete g2.location;
  g2.fetch = () => {
    serverFetches++;
    return Promise.resolve(new Response(""));
  };
  try {
    prefetch("/pf-server");
    assertEquals(serverFetches, 0);
  } finally {
    if (savedLoc === undefined) delete g2.location;
    else g2.location = savedLoc;
    if (savedFetch === undefined) delete g2.fetch;
    else g2.fetch = savedFetch;
  }
});

Deno.test("setNavRequestProvider: an over-large echo makes the route fetch a POST with the body + headers", async () => {
  const g = globalThis as AnyGlobal;
  const origLoc = g.location;
  const origFetch = g.fetch;
  let init: RequestInit | undefined;
  g.location = { href: "http://localhost/", origin: "http://localhost" };
  g.fetch = (_href: string, i: RequestInit) => {
    init = i;
    return Promise.resolve(new Response("<html></html>"));
  };
  setNavRequestProvider(() => ({ headers: { "x-custom": "1" }, body: '{"echo":1}' }));
  try {
    prefetch("/pf-provider");
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(init?.method, "POST");
    assertEquals(init?.body, '{"echo":1}');
    const headers = init?.headers as Record<string, string>;
    assertEquals(headers["x-custom"], "1");
    // `x-denext-nav` is always set and always wins.
    assertEquals(headers["x-denext-nav"], "1");
  } finally {
    setNavRequestProvider(null);
    if (origLoc === undefined) delete g.location;
    else g.location = origLoc;
    if (origFetch === undefined) delete g.fetch;
    else g.fetch = origFetch;
  }
});

Deno.test("setSoftNavBlocker vetoes a user-initiated navigate before it starts", async () => {
  const g = globalThis as AnyGlobal;
  const origLoc = g.location;
  const origFetch = g.fetch;
  let fetched = false;
  g.location = { href: "http://localhost/", origin: "http://localhost" };
  g.fetch = () => {
    fetched = true;
    return new Promise<Response>(() => {});
  };
  setSoftNavBlocker(() => true);
  try {
    // A vetoed user nav returns before touching the pending signal or the network.
    await navigate("/blocked");
    assertEquals(getNavigatingHref(), null);
    assertEquals(fetched, false);
  } finally {
    setSoftNavBlocker(null);
    if (origLoc === undefined) delete g.location;
    else g.location = origLoc;
    if (origFetch === undefined) delete g.fetch;
    else g.fetch = origFetch;
  }
});

Deno.test("navigate publishes the global pending signal for the duration of a same-origin nav", () => {
  const g = globalThis as AnyGlobal;
  const origLoc = g.location;
  const origFetch = g.fetch;
  // Idle before any nav (blocker test above never sets the signal).
  assertEquals(getNavigatingHref(), null);
  g.location = { href: "http://localhost/", origin: "http://localhost" };
  // Hang the route fetch so the nav stays in flight and the signal stays published.
  g.fetch = () => new Promise<Response>(() => {});
  let notified = 0;
  const unsub = subscribeNavigating(() => notified++);
  try {
    void navigate("/nav-signal");
    assertEquals(getNavigatingHref(), "/nav-signal");
    assert(notified >= 1, "subscribers are notified when a nav starts");
  } finally {
    unsub();
    if (origLoc === undefined) delete g.location;
    else g.location = origLoc;
    if (origFetch === undefined) delete g.fetch;
    else g.fetch = origFetch;
  }
});

// ---- lazy-hydrate.ts -------------------------------------------------------

/** A fake island whose `hydrate` bumps a shared counter. */
function fakeIsland(
  strategy: string,
  container: unknown,
  onHydrate: () => void,
  param?: string,
) {
  return {
    container: container as Element,
    strategy: strategy as never,
    param,
    hydrate: onHydrate,
  };
}

Deno.test("registerLazyIsland: `load` and `only` hydrate synchronously", () => {
  resetLazyIslands();
  try {
    let loaded = 0;
    let only = 0;
    registerLazyIsland(fakeIsland("load", {}, () => loaded++));
    registerLazyIsland(fakeIsland("only", {}, () => only++));
    assertEquals(loaded, 1);
    assertEquals(only, 1);
  } finally {
    resetLazyIslands();
  }
});

Deno.test("registerLazyIsland: idle/visible/media schedule via the injected scheduler; hydrate is idempotent", () => {
  resetLazyIslands();
  const idleCbs: Array<() => void> = [];
  const visibleCalls: Array<{ el: Element; cb: () => void }> = [];
  const mediaCalls: Array<{ query: string; cb: () => void }> = [];
  let visibleTornDown = 0;
  let mediaTornDown = 0;
  const scheduler: LazyScheduler = {
    idle: (cb) => idleCbs.push(cb),
    visible: (el, cb) => {
      visibleCalls.push({ el, cb });
      return () => visibleTornDown++;
    },
    media: (query, cb) => {
      mediaCalls.push({ query, cb });
      return () => mediaTornDown++;
    },
  };
  setLazyScheduler(scheduler);
  try {
    let idle = 0;
    let visible = 0;
    let media = 0;
    const visContainer = { tag: "vis" };

    registerLazyIsland(fakeIsland("idle", {}, () => idle++));
    registerLazyIsland(fakeIsland("visible", visContainer, () => visible++));
    registerLazyIsland(fakeIsland("media", {}, () => media++, "(min-width: 600px)"));

    // Nothing fired yet — the scheduler holds the callbacks.
    assertEquals([idle, visible, media], [0, 0, 0]);
    assertStrictEquals(visibleCalls[0].el, visContainer as unknown as Element);
    assertEquals(mediaCalls[0].query, "(min-width: 600px)");

    // Fire each; a second firing is a no-op (`runHydrate` is idempotent).
    idleCbs[0]();
    idleCbs[0]();
    visibleCalls[0].cb();
    mediaCalls[0].cb();
    assertEquals([idle, visible, media], [1, 1, 1]);
    // Hydration runs the strategy teardown so observers/listeners are released.
    assertEquals(visibleTornDown, 1);
    assertEquals(mediaTornDown, 1);
  } finally {
    resetLazyIslands();
    setLazyScheduler();
  }
});

Deno.test("dispatchInteraction hydrates the nearest `interaction` island (ancestor walk) and returns whether it did", () => {
  resetLazyIslands();
  try {
    let hydrated = 0;
    const container = { name: "island" };
    const child = { parentNode: container };
    const grandchild = { parentNode: child };
    registerLazyIsland(fakeIsland("interaction", container, () => hydrated++));

    // A target deep inside the island resolves up the parentNode chain.
    assertEquals(dispatchInteraction(grandchild as unknown as Element), true);
    assertEquals(hydrated, 1);

    // Already hydrated / unrelated targets do not match.
    assertEquals(dispatchInteraction(grandchild as unknown as Element), false);
    assertEquals(dispatchInteraction({ parentNode: null } as unknown as Element), false);
  } finally {
    resetLazyIslands();
  }
});

Deno.test("resetLazyIslands tears down pending islands and drops them", () => {
  resetLazyIslands();
  let tornDown = 0;
  setLazyScheduler({
    idle: (cb) => cb(),
    visible: (_el, _cb) => () => tornDown++,
    media: (_q, _cb) => () => {},
  });
  try {
    registerLazyIsland(fakeIsland("visible", {}, () => {}));
    registerLazyIsland(fakeIsland("interaction", { x: 1 }, () => {}));
    resetLazyIslands();
    // The visible island's teardown ran, and the interaction island is gone.
    assertEquals(tornDown, 1);
    assertEquals(dispatchInteraction({ parentNode: null } as unknown as Element), false);
  } finally {
    resetLazyIslands();
    setLazyScheduler();
  }
});

Deno.test("getIslandTimeline records hydrations only in dev mode", () => {
  resetLazyIslands();
  const g = globalThis as AnyGlobal;
  const origDev = g.__denextDev;
  const origIslands = g.__denextIslands;
  const origDebug = console.debug;
  try {
    // Production (no __denextDev): nothing recorded.
    delete g.__denextDev;
    delete g.__denextIslands;
    registerLazyIsland(fakeIsland("load", { getAttribute: () => "prod-id" }, () => {}));
    assertEquals(getIslandTimeline(), []);

    // Dev: a hydration is appended with its id + strategy.
    g.__denextDev = true;
    g.__denextIslands = undefined;
    console.debug = () => {};
    const container = { getAttribute: (n: string) => (n === "data-dnx-id" ? "hero" : null) };
    registerLazyIsland(fakeIsland("load", container, () => {}));
    const timeline = getIslandTimeline();
    assertEquals(timeline.length, 1);
    assertEquals(timeline[0].id, "hero");
    assertEquals(timeline[0].strategy, "load");
    assertEquals(typeof timeline[0].at, "number");
  } finally {
    console.debug = origDebug;
    if (origDev === undefined) delete g.__denextDev;
    else g.__denextDev = origDev;
    if (origIslands === undefined) delete g.__denextIslands;
    else g.__denextIslands = origIslands;
    resetLazyIslands();
  }
});

Deno.test("default scheduler hydrates immediately when no IntersectionObserver/matchMedia exist", async () => {
  resetLazyIslands();
  setLazyScheduler(); // real default scheduler
  const g = globalThis as AnyGlobal;
  const hadIO = "IntersectionObserver" in g;
  const hadMM = "matchMedia" in g;
  const origIO = g.IntersectionObserver;
  const origMM = g.matchMedia;
  delete g.IntersectionObserver;
  delete g.matchMedia;
  try {
    let visible = 0;
    let media = 0;
    // No observer / matchMedia in the runtime ⇒ hydrate now to stay correct.
    registerLazyIsland(fakeIsland("visible", {}, () => visible++));
    registerLazyIsland(fakeIsland("media", {}, () => media++, "(min-width: 1px)"));
    assertEquals(visible, 1);
    assertEquals(media, 1);

    // `idle` falls back to setTimeout(cb, 0) — fires on the next macrotask.
    let idle = 0;
    registerLazyIsland(fakeIsland("idle", {}, () => idle++));
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(idle, 1);
  } finally {
    if (hadIO) g.IntersectionObserver = origIO;
    else delete g.IntersectionObserver;
    if (hadMM) g.matchMedia = origMM;
    else delete g.matchMedia;
    resetLazyIslands();
  }
});

Deno.test("default scheduler observes the box target of a display:contents wrapper", () => {
  resetLazyIslands();
  setLazyScheduler();
  const g = globalThis as AnyGlobal;
  const origIO = g.IntersectionObserver;
  const origGCS = g.getComputedStyle;
  const observers: Array<{
    cb: (entries: Array<{ isIntersecting: boolean }>) => void;
    observed: unknown;
    disconnected: boolean;
  }> = [];
  g.IntersectionObserver = class {
    cb: (entries: Array<{ isIntersecting: boolean }>) => void;
    observed: unknown = null;
    disconnected = false;
    constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
      this.cb = cb;
      observers.push(this);
    }
    observe(el: unknown) {
      this.observed = el;
    }
    disconnect() {
      this.disconnected = true;
    }
  };
  g.getComputedStyle = (el: { display?: string }) => ({ display: el.display ?? "block" });
  try {
    let hydrated = 0;
    const child = { name: "real-root" };
    // A display:contents wrapper has no layout box → observe its first element child.
    const container = { display: "contents", firstElementChild: child };
    registerLazyIsland(fakeIsland("visible", container, () => hydrated++));

    assertEquals(observers.length, 1);
    assertStrictEquals(observers[0].observed, child);

    // Reporting intersection hydrates and disconnects the observer.
    observers[0].cb([{ isIntersecting: false }]); // ignored — not intersecting
    assertEquals(hydrated, 0);
    observers[0].cb([{ isIntersecting: true }]);
    assertEquals(hydrated, 1);
    assert(observers[0].disconnected, "the observer is disconnected on hydrate");
  } finally {
    g.IntersectionObserver = origIO;
    if (origGCS === undefined) delete g.getComputedStyle;
    else g.getComputedStyle = origGCS;
    resetLazyIslands();
    setLazyScheduler();
  }
});

Deno.test("default scheduler media: hydrates on the matchMedia change event, and instantly when already matching", () => {
  resetLazyIslands();
  setLazyScheduler();
  const g = globalThis as AnyGlobal;
  const origMM = g.matchMedia;
  try {
    // Not matching yet: registers a `change` listener; hydrates when it flips.
    let listener: (() => void) | null = null;
    let removed = 0;
    const state = { matches: false };
    g.matchMedia = (_q: string) => ({
      get matches() {
        return state.matches;
      },
      addEventListener: (_t: string, cb: () => void) => {
        listener = cb;
      },
      removeEventListener: () => removed++,
    });
    let a = 0;
    registerLazyIsland(fakeIsland("media", {}, () => a++, "(min-width: 700px)"));
    assertEquals(a, 0);
    assert(listener, "a change listener is registered while not matching");
    state.matches = true;
    (listener as unknown as () => void)(); // media now matches
    assertEquals(a, 1);
    assertEquals(removed, 1, "the change listener is removed on hydrate");

    // Already matching at registration: hydrates immediately, no listener needed.
    g.matchMedia = (_q: string) => ({ matches: true });
    let b = 0;
    registerLazyIsland(fakeIsland("media", {}, () => b++, "(min-width: 1px)"));
    assertEquals(b, 1);
  } finally {
    if (origMM === undefined) delete g.matchMedia;
    else g.matchMedia = origMM;
    resetLazyIslands();
    setLazyScheduler();
  }
});

Deno.test("INTERACTION_EVENTS lists the first-touch hydration triggers", () => {
  assertEquals(
    [...INTERACTION_EVENTS],
    ["pointerdown", "click", "keydown", "focusin", "touchstart"],
  );
});
