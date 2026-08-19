// withWebLock: cross-context single-flight via the Web Locks API, with an
// SSR / no-support fallback. Deno implements navigator.locks, so the browser
// path is exercised for real by defining a `document` global (which flips
// isServer() to false).

import { assert, assertEquals } from "@std/assert";
import { type WebLockOptions, withWebLock } from "../src/runtime/web-lock.ts";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `fn` with a fake browser environment (a `document` global) installed. */
async function inBrowser<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { document?: unknown };
  const had = "document" in g;
  g.document = {};
  try {
    return await fn();
  } finally {
    if (!had) delete g.document;
  }
}

Deno.test("withWebLock runs fn and returns its value on the server (no coordination)", async () => {
  // No `document` → isServer() true → fallback path, fn runs directly.
  assertEquals(await withWebLock("t:server", () => 42), 42);
  assertEquals(await withWebLock("t:server", () => Promise.resolve("ok")), "ok");
});

Deno.test("withWebLock runs and returns its value in a browser context", async () => {
  await inBrowser(async () => {
    assertEquals(await withWebLock("t:value", () => 7), 7);
    assertEquals(await withWebLock("t:value", () => Promise.resolve("done")), "done");
  });
});

Deno.test("withWebLock serializes exclusive holders of the same name", async () => {
  await inBrowser(async () => {
    const order: string[] = [];
    const a = withWebLock("t:excl", async () => {
      order.push("a-start");
      await delay(25);
      order.push("a-end");
    });
    // Give A a moment to acquire, then start B on the same lock.
    await delay(5);
    const b = withWebLock("t:excl", () => {
      order.push("b-start");
      order.push("b-end");
    });
    await Promise.all([a, b]);
    // B cannot start until A has fully released the exclusive lock.
    assertEquals(order, ["a-start", "a-end", "b-start", "b-end"]);
  });
});

Deno.test("withWebLock allows concurrent shared holders", async () => {
  await inBrowser(async () => {
    const opts: WebLockOptions = { mode: "shared" };
    let overlap = false;
    let active = 0;
    const worker = () =>
      withWebLock("t:shared", async () => {
        active++;
        if (active > 1) overlap = true; // two shared holders ran at once
        await delay(15);
        active--;
      }, opts);
    await Promise.all([worker(), worker()]);
    assert(overlap, "shared locks should be held concurrently");
  });
});

Deno.test("withWebLock with ifAvailable skips fn (returns undefined) when the lock is held", async () => {
  await inBrowser(async () => {
    let release!: () => void;
    const holding = new Promise<void>((r) => (release = r));
    // Hold the lock until we release it.
    const held = withWebLock("t:avail", () => holding);
    await delay(5);

    let ran = false;
    const result = await withWebLock("t:avail", () => {
      ran = true;
      return "ran";
    }, { ifAvailable: true });
    assertEquals(result, undefined, "ifAvailable resolves to undefined when held");
    assertEquals(ran, false, "fn does not run when the lock is unavailable");

    release();
    await held;

    // Once free, ifAvailable acquires and runs fn.
    assertEquals(await withWebLock("t:avail", () => "now", { ifAvailable: true }), "now");
  });
});
