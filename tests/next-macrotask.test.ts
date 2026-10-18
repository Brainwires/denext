// One macrotask turn (src/runtime/next-macrotask.ts): `act`'s quiet wait and the streaming
// renderers' shell pass. Calls made before a turn runs share it, and a capped wait cancels its
// turn when the awaited promise wins, so no handle outlives it (the test sanitizers check).

import { assertEquals } from "@std/assert";
import { nextMacrotask, withinMacrotask } from "../src/runtime/next-macrotask.ts";

/** Run `fn` with `MessageChannel` unavailable (the `setTimeout` fallback). */
async function withoutMessageChannel(fn: () => Promise<void>): Promise<void> {
  const g = globalThis as { MessageChannel?: unknown };
  const saved = g.MessageChannel;
  delete g.MessageChannel;
  try {
    await fn();
  } finally {
    g.MessageChannel = saved;
  }
}

Deno.test("nextMacrotask: every microtask queued first has run; waiters resolve in call order", async () => {
  const order: string[] = [];
  const a = nextMacrotask().then(() => order.push("a"));
  const b = nextMacrotask().then(() => order.push("b"));
  let chain = Promise.resolve();
  for (let i = 0; i < 50; i++) chain = chain.then(() => {});
  void chain.then(() => order.push("microtasks"));
  await Promise.all([a, b]);
  assertEquals(order, ["microtasks", "a", "b"]);
  // The next call schedules a new turn.
  await nextMacrotask();
});

Deno.test("withinMacrotask: the promise's value when it settles first, else undefined", async () => {
  assertEquals(await withinMacrotask(Promise.resolve(7)), 7);
  const late = new Promise<number>((r) => setTimeout(() => r(1), 30));
  assertEquals(await withinMacrotask(late), undefined);
  await late;
});

Deno.test("without MessageChannel both fall back to a zero-delay timer", async () => {
  await withoutMessageChannel(async () => {
    await nextMacrotask();
    assertEquals(await withinMacrotask(Promise.resolve("v")), "v");
    const late = new Promise<string>((r) => setTimeout(() => r("x"), 30));
    assertEquals(await withinMacrotask(late), undefined);
    await late;
  });
});
