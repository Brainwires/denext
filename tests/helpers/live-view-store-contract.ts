// The contract every `LiveViewStore` keeps (memory, Redis, Postgres): a snapshot is handed back
// once (`take` deletes it), `set` replaces, `delete` drops, and an expired one is gone. Run by
// tests/live-views.test.ts (memory), tests/redis-stores.test.ts + tests/redis-integration.test.ts
// and the Postgres suites (tests/helpers/postgres-suites.ts).

import { assertEquals } from "@std/assert";
import type { LiveViewStore } from "../../src/server/live-view-store.ts";

/**
 * Run the contract on fresh stores.
 *
 * @param t The test context.
 * @param fresh A new, empty store per step (closed after it when it has `close`).
 */
export async function liveViewStoreContract(
  t: Deno.TestContext,
  fresh: () => LiveViewStore | Promise<LiveViewStore>,
): Promise<void> {
  const step = (name: string, fn: (store: LiveViewStore) => Promise<void>) =>
    t.step(name, async () => {
      const store = await fresh();
      try {
        await fn(store);
      } finally {
        await (store as { close?: () => Promise<void> }).close?.();
      }
    });
  await step("take hands a snapshot back once", async (store) => {
    assertEquals(await store.take("a"), null);
    await store.set("a", "sealed-1", 60);
    await store.set("a", "sealed-2", 60);
    assertEquals(await store.take("a"), "sealed-2", "set replaces");
    assertEquals(await store.take("a"), null, "take deleted it");
  });
  await step("delete drops a snapshot; ids are independent", async (store) => {
    await store.set("a", "x", 60);
    await store.set("b", "y", 60);
    await store.delete("a");
    await store.delete("nothing-here");
    assertEquals(await store.take("a"), null);
    assertEquals(await store.take("b"), "y");
  });
  await step("an expired snapshot is gone", async (store) => {
    await store.set("a", "x", 0.05);
    await new Promise((r) => setTimeout(r, 120));
    assertEquals(await store.take("a"), null);
  });
}
