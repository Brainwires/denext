// Island-level lazy hydration: the four strategies and the delegated interaction
// dispatch. Scheduling primitives are injected so idle/visible fire deterministically.

import { assert, assertEquals } from "@std/assert";
import {
  dispatchInteraction,
  type LazyScheduler,
  registerLazyIsland,
  resetLazyIslands,
  setLazyScheduler,
} from "../src/client/lazy-hydrate.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** A scheduler that captures pending idle/visible/media callbacks for manual firing. */
function controllableScheduler() {
  let idleCb: (() => void) | null = null;
  let visibleCb: (() => void) | null = null;
  let mediaCb: (() => void) | null = null;
  let mediaQuery: string | null = null;
  let disconnected = false;
  let mediaDisconnected = false;
  const sched: LazyScheduler = {
    idle(cb) {
      idleCb = cb;
    },
    visible(_el, cb) {
      visibleCb = cb;
      return () => {
        disconnected = true;
      };
    },
    media(query, cb) {
      mediaQuery = query;
      mediaCb = cb;
      return () => {
        mediaDisconnected = true;
      };
    },
  };
  return {
    sched,
    fireIdle: () => idleCb?.(),
    fireVisible: () => visibleCb?.(),
    fireMedia: () => mediaCb?.(),
    get mediaQuery() {
      return mediaQuery;
    },
    get disconnected() {
      return disconnected;
    },
    get mediaDisconnected() {
      return mediaDisconnected;
    },
  };
}

function child(container: Any): Any {
  const { doc } = makeDom();
  const el = doc.createElement("span");
  container.appendChild(el);
  return el;
}

Deno.test("client:load hydrates immediately on register", () => {
  resetLazyIslands();
  const { container } = makeDom();
  let hydrated = 0;
  registerLazyIsland({ container: container as Any, strategy: "load", hydrate: () => hydrated++ });
  assertEquals(hydrated, 1);
});

Deno.test("client:idle hydrates only when idle fires", () => {
  resetLazyIslands();
  const ctl = controllableScheduler();
  setLazyScheduler(ctl.sched);
  const { container } = makeDom();
  let hydrated = 0;
  registerLazyIsland({ container: container as Any, strategy: "idle", hydrate: () => hydrated++ });
  assertEquals(hydrated, 0);
  ctl.fireIdle();
  assertEquals(hydrated, 1);
  ctl.fireIdle(); // idempotent
  assertEquals(hydrated, 1);
  setLazyScheduler();
});

Deno.test("client:visible hydrates on intersection and disconnects the observer", () => {
  resetLazyIslands();
  const ctl = controllableScheduler();
  setLazyScheduler(ctl.sched);
  const { container } = makeDom();
  let hydrated = 0;
  registerLazyIsland({
    container: container as Any,
    strategy: "visible",
    hydrate: () => hydrated++,
  });
  assertEquals(hydrated, 0);
  ctl.fireVisible();
  assertEquals(hydrated, 1);
  assert(ctl.disconnected, "expected the observer to disconnect after hydrating");
  setLazyScheduler();
});

Deno.test("client:media hydrates when the query matches and passes the query through", () => {
  resetLazyIslands();
  const ctl = controllableScheduler();
  setLazyScheduler(ctl.sched);
  const { container } = makeDom();
  let hydrated = 0;
  registerLazyIsland({
    container: container as Any,
    strategy: "media",
    param: "(min-width:800px)",
    hydrate: () => hydrated++,
  });
  assertEquals(hydrated, 0);
  assertEquals(ctl.mediaQuery, "(min-width:800px)");
  ctl.fireMedia();
  assertEquals(hydrated, 1);
  assert(ctl.mediaDisconnected, "expected the media listener to disconnect after hydrating");
  setLazyScheduler();
});

Deno.test("client:only hydrates immediately on register (client-only mount)", () => {
  resetLazyIslands();
  const { container } = makeDom();
  let hydrated = 0;
  registerLazyIsland({ container: container as Any, strategy: "only", hydrate: () => hydrated++ });
  assertEquals(hydrated, 1);
});

Deno.test("client:interaction hydrates on a delegated event inside the island", () => {
  resetLazyIslands();
  const { container } = makeDom();
  const inner = child(container);
  let hydrated = 0;
  registerLazyIsland({
    container: container as Any,
    strategy: "interaction",
    hydrate: () => hydrated++,
  });
  assertEquals(hydrated, 0);
  // An interaction on a descendant resolves up to the island container.
  assert(dispatchInteraction(inner), "expected a descendant interaction to hydrate");
  assertEquals(hydrated, 1);
  // Idempotent: a second interaction does nothing (real listeners now own it).
  assertEquals(dispatchInteraction(inner), false);
  assertEquals(hydrated, 1);
});

Deno.test("dispatchInteraction ignores targets outside any interaction island", () => {
  resetLazyIslands();
  const { container } = makeDom();
  registerLazyIsland({ container: container as Any, strategy: "interaction", hydrate: () => {} });
  const { container: other } = makeDom();
  const stray = child(other);
  assertEquals(dispatchInteraction(stray), false);
  assertEquals(dispatchInteraction(null), false);
});
