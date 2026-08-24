// Unit tests for `router.events` — the Pages Router route-change event emitter
// (`routeChangeStart`/`routeChangeComplete`/…). The emitter is pure (no DOM), so
// it's tested directly; the start→complete firing during a real soft navigation
// is covered by the browser e2e (tests/e2e/pages-router.e2e.test.ts).

import { assert, assertEquals } from "@std/assert";
import { createRouterEvents } from "../packages/pages-router/router.ts";

Deno.test("createRouterEvents: on/emit delivers to subscribers with args", () => {
  const events = createRouterEvents();
  const seen: unknown[][] = [];
  events.on("routeChangeStart", (...args) => seen.push(args));

  events.emit("routeChangeStart", "/next", { shallow: false });
  assertEquals(seen, [["/next", { shallow: false }]]);
});

Deno.test("createRouterEvents: off unsubscribes a handler", () => {
  const events = createRouterEvents();
  let count = 0;
  const handler = () => count++;
  events.on("routeChangeComplete", handler);
  events.emit("routeChangeComplete", "/a");
  events.off("routeChangeComplete", handler);
  events.emit("routeChangeComplete", "/b");
  assertEquals(count, 1);
});

Deno.test("createRouterEvents: multiple handlers all fire", () => {
  const events = createRouterEvents();
  let a = 0, b = 0;
  events.on("routeChangeStart", () => a++);
  events.on("routeChangeStart", () => b++);
  events.emit("routeChangeStart", "/x");
  assertEquals([a, b], [1, 1]);
});

Deno.test("createRouterEvents: a handler may unsubscribe during emit without skipping others", () => {
  const events = createRouterEvents();
  const order: string[] = [];
  const first = () => {
    order.push("first");
    events.off("routeChangeStart", second);
  };
  const second = () => order.push("second");
  const third = () => order.push("third");
  events.on("routeChangeStart", first);
  events.on("routeChangeStart", second);
  events.on("routeChangeStart", third);
  // `second` unsubscribed by `first` mid-emit, but this emit still sees the snapshot.
  events.emit("routeChangeStart", "/x");
  assertEquals(order, ["first", "second", "third"]);
  // The next emit reflects the unsubscription.
  order.length = 0;
  events.emit("routeChangeStart", "/y");
  assertEquals(order, ["first", "third"]);
});

Deno.test("createRouterEvents: emitting an event with no subscribers is a no-op", () => {
  const events = createRouterEvents();
  events.emit("hashChangeComplete", "/#a"); // must not throw
});

Deno.test("router exposes a usable events emitter during SSR", async () => {
  const { createServerRouter } = await import("../packages/pages-router/router.ts");
  const router = createServerRouter({ route: "/", query: {}, asPath: "/" });
  let fired = 0;
  const handler = () => fired++;
  router.events.on("routeChangeStart", handler);
  router.events.emit("routeChangeStart", "/");
  router.events.off("routeChangeStart", handler);
  router.events.emit("routeChangeStart", "/");
  assertEquals(fired, 1);
  assert(typeof router.events.on === "function");
});
