import { assert, assertEquals } from "@std/assert";
import { getIslandTimeline, registerLazyIsland, resetLazyIslands } from "../src/client/lazy-hydrate.ts";

interface DevGlobals {
  __denextDev?: boolean;
  __denextIslands?: unknown[];
}
const g = globalThis as DevGlobals;

function withDev(dev: boolean | undefined, fn: () => void): void {
  const prev = g.__denextDev;
  g.__denextDev = dev;
  g.__denextIslands = [];
  resetLazyIslands();
  try {
    fn();
  } finally {
    g.__denextDev = prev;
    g.__denextIslands = [];
  }
}

const fakeIsland = (id: string) => ({
  container: { getAttribute: () => id } as unknown as Element,
  strategy: "load" as const,
  hydrate: () => {},
});

Deno.test("islands inspector: dev records each hydration (id + strategy)", () => {
  withDev(true, () => {
    registerLazyIsland(fakeIsland("0.3")); // `load` hydrates immediately
    const timeline = getIslandTimeline();
    assertEquals(timeline.length, 1);
    assertEquals(timeline[0].strategy, "load");
    assertEquals(timeline[0].id, "0.3");
    assert(typeof timeline[0].at === "number");
  });
});

Deno.test("islands inspector: no records in production (no __denextDev)", () => {
  withDev(undefined, () => {
    registerLazyIsland(fakeIsland("x"));
    assertEquals(getIslandTimeline().length, 0);
  });
});
