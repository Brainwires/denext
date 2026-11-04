// A page from an older build posts Server Action ids a new build re-minted. The server answers
// `409` + `x-denext-action: unknown` (src/server/action-handler.ts), and the browser dispatch
// (src/client/action-dispatch.ts) reloads the page once on it — guarded by a sessionStorage flag,
// so a reloaded page whose actions are still unknown doesn't reload again — and fails the call.
// The flag is cleared by the next call that succeeds, so a later deploy can reload once more.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { dispatchAction } from "../src/client/action-dispatch.ts";
import { decodeWire } from "../src/runtime/wire-codec.ts";
import { prepareWire } from "../src/runtime/wire-encode.ts";

/** A browser's `location` and `sessionStorage`, installed for `body` and removed after. */
async function inBrowser(
  body: (page: { reloads: number; storage: Map<string, string> }) => Promise<void>,
): Promise<void> {
  const page = { reloads: 0, storage: new Map<string, string>() };
  const define = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const had = {
    location: Object.getOwnPropertyDescriptor(globalThis, "location"),
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"),
  };
  define("location", { reload: () => void page.reloads++ });
  define("sessionStorage", {
    getItem: (k: string) => page.storage.get(k) ?? null,
    setItem: (k: string, v: string) => void page.storage.set(k, v),
    removeItem: (k: string) => void page.storage.delete(k),
  });
  try {
    await body(page);
  } finally {
    for (const [name, descriptor] of Object.entries(had)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
}

/** Run `body` with `fetch` answering each call from `answers` in turn. */
async function withFetch(answers: Response[], body: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(answers.shift()!);
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
}

const unknown = () =>
  new Response(JSON.stringify({ error: "unknown action" }), {
    status: 409,
    headers: { "content-type": "application/json", "x-denext-action": "unknown" },
  });
const ok = () =>
  new Response(JSON.stringify({ result: 1 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const call = () => dispatchAction("stale#save", [], null, decodeWire, prepareWire);

Deno.test("an unknown action id reloads the page once, fails the call, and never loops", async () => {
  await inBrowser(async (page) => {
    await withFetch([unknown(), unknown(), unknown()], async () => {
      await assertRejects(call, Error, "older build");
      assertEquals(page.reloads, 1, "the page reloads to pick the new build's ids up");
      assert(page.storage.has("denext:action-reload"), "the guard is set before the reload");
      // The reloaded page's actions are unknown too (the secrets disagree): no second reload.
      await assertRejects(call, Error, "older build");
      await assertRejects(call, Error, "older build");
      assertEquals(page.reloads, 1);
    });
    // A call that succeeds clears the guard, so the next deploy can reload once more.
    await withFetch([ok(), unknown()], async () => {
      assertEquals(await call(), 1);
      assert(!page.storage.has("denext:action-reload"));
      await assertRejects(call, Error, "older build");
      assertEquals(page.reloads, 2);
    });
  });
});

Deno.test("a 409 without the marker header, and any other error, is a plain failure", async () => {
  await inBrowser(async (page) => {
    const plain409 = new Response(JSON.stringify({ error: "conflict" }), { status: 409 });
    const notFound = new Response(JSON.stringify({ error: "unknown action" }), { status: 404 });
    await withFetch([plain409, notFound], async () => {
      await assertRejects(call, Error, "conflict");
      await assertRejects(call, Error, "unknown action");
      assertEquals(page.reloads, 0);
      assert(!page.storage.has("denext:action-reload"));
    });
  });
});

Deno.test("without a browser (no location, no sessionStorage) the unknown answer is just an error", async () => {
  await withFetch([unknown()], async () => {
    await assertRejects(call, Error, "older build");
  });
});
