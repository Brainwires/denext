/**
 * Contract suites for denext's pluggable stores: run one against your own `CacheStore`,
 * `SessionStore` or `RateLimitStore` (a Redis, DynamoDB or Cloudflare KV adapter, say) to prove
 * it behaves the way the framework relies on. denext's own stores (in-memory, SQLite, Postgres,
 * Redis, Deno KV) pass the same suites.
 *
 * ```ts
 * import { cacheStoreContract } from "denext/testing";
 * import { myCacheStore } from "./my-cache-store.ts";
 *
 * Deno.test("myCacheStore honours the CacheStore contract", async (t) => {
 *   await cacheStoreContract(t, () => myCacheStore({ url: Deno.env.get("STORE_URL") }));
 * });
 * ```
 *
 * Each case runs as a step on a FRESH store from your factory (an empty database, or a new key
 * prefix on a shared one) and calls the store's `close()` afterwards when it has one. Under
 * another runner, pass `{ step: (name, fn) => test(name, fn) }`.
 *
 * @module
 */

import type { CachedPage, CacheStore } from "../server/cache.ts";
import type { SessionStore } from "../server/auth/session-store.ts";
import type { RateLimitStore } from "../server/auth/rate-limit.ts";
import type { AuthSession } from "../server/auth/types.ts";

/** Where the cases run: `Deno.TestContext` fits, or any `{ step }` that runs a named case. */
export interface ContractContext {
  /** Run one named case. */
  step(name: string, fn: () => Promise<void>): Promise<unknown> | unknown;
}

/** Makes a fresh, empty store for one case. */
export type StoreFactory<S> = () => S | Promise<S>;

/** A contract case that failed; its message names what the store got wrong. */
export class StoreContractError extends Error {
  /**
   * Create the error.
   *
   * @param message What differed.
   */
  constructor(message: string) {
    super(message);
    this.name = "StoreContractError";
  }
}

/** Structural equality over JSON-like values (`Infinity` and `NaN` included). */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}

/** A readable form of a value for a failure message. */
const show = (v: unknown): string =>
  v === undefined ? "undefined" : JSON.stringify(v, (_, x) => (x === Infinity ? "Infinity" : x));

function expectSame(actual: unknown, expected: unknown, what: string): void {
  if (!same(actual, expected)) {
    throw new StoreContractError(`${what}: expected ${show(expected)}, got ${show(actual)}`);
  }
}

function expectTrue(condition: unknown, what: string): void {
  if (!condition) throw new StoreContractError(what);
}

/** Run each case on a fresh store, closing it afterwards. */
async function runCases<S>(
  t: ContractContext,
  make: StoreFactory<S>,
  cases: Record<string, (store: S) => Promise<void>>,
): Promise<void> {
  for (const [name, run] of Object.entries(cases)) {
    await t.step(name, async () => {
      const store = await make();
      try {
        await run(store);
      } finally {
        await (store as { close?: () => unknown }).close?.();
      }
    });
  }
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const page = (path: string, tags: string[], extra: Partial<CachedPage> = {}): CachedPage => ({
  body: `<p>${path}</p>`,
  status: 200,
  path,
  expiresAt: Infinity,
  tags,
  ...extra,
});

const CACHE_CASES: Record<string, (store: CacheStore) => Promise<void>> = {
  "data round-trips (value, expiry, staleAt) and misses once hard-expired": async (store) => {
    const value = { n: 1, s: "x", list: [1, "two", null], nested: { ok: true } };
    await store.setData("k", { value, expiresAt: Infinity, tags: ["t"] });
    expectSame(await store.getData("k"), { value, expiresAt: Infinity, tags: ["t"] }, "getData");
    const expiresAt = Date.now() + 60_000;
    await store.setData("s", { value: 2, expiresAt, staleAt: 123, tags: [] });
    const s = await store.getData("s");
    expectSame([s?.value, s?.expiresAt, s?.staleAt], [2, expiresAt, 123], "expiry and staleAt");
    await store.setData("old", { value: 3, expiresAt: Date.now() - 1, tags: [] });
    expectSame(await store.getData("old"), undefined, "a hard-expired entry is a miss");
    expectSame(await store.getData("missing"), undefined, "an unknown key is a miss");
  },
  "a write replaces the entry under its key": async (store) => {
    await store.setData("k", { value: "a", expiresAt: Infinity, tags: ["x"] });
    await store.setData("k", { value: "b", expiresAt: Infinity, tags: ["y"] });
    const read = await store.getData("k");
    expectSame([read?.value, read?.tags], ["b", ["y"]], "the second write wins");
  },
  "pages round-trip with csp and PPR extras": async (store) => {
    const extras = { holeIds: ["h1"], csp: "script-src 'self'", status: 404 };
    await store.setPage("p1", page("/a", ["blog"], extras));
    const read = await store.getPage("p1");
    expectSame(
      [read?.body, read?.path, read?.status, read?.csp, read?.holeIds, read?.tags],
      ["<p>/a</p>", "/a", 404, extras.csp, ["h1"], ["blog"]],
      "getPage",
    );
    expectSame(await store.getPage("missing"), undefined, "an unknown page is a miss");
    await store.setPage("gone", page("/g", [], { expiresAt: Date.now() - 1 }));
    expectSame(await store.getPage("gone"), undefined, "a hard-expired page is a miss");
  },
  "a large page body round-trips intact": async (store) => {
    const body = "<p>" + "ü€x".repeat(70_000) + "</p>"; // > 64 KiB in UTF-8
    await store.setPage("big", page("/big", ["t"], { body }));
    expectTrue((await store.getPage("big"))?.body === body, "the large body changed");
  },
  "deleteByPath purges that path's pages only": async (store) => {
    await store.setPage("p1", page("/a", []));
    await store.setPage("p1b", page("/a", []));
    await store.setPage("p2", page("/b", []));
    await store.deleteByPath("/a");
    expectSame(await store.getPage("p1"), undefined, "page of /a");
    expectSame(await store.getPage("p1b"), undefined, "second page of /a");
    expectTrue(await store.getPage("p2"), "a page of another path was purged");
  },
  "deleteByTag purges tagged data and pages, nothing else": async (store) => {
    await store.setPage("p1", page("/a", ["blog"]));
    await store.setPage("p2", page("/b", ["blog", "home"]));
    await store.setPage("p3", page("/c", ["home"]));
    await store.setData("d1", { value: 1, expiresAt: Infinity, tags: ["blog"] });
    await store.setData("d2", { value: 2, expiresAt: Infinity, tags: ["other"] });
    await store.deleteByTag("blog");
    expectSame(await store.getPage("p1"), undefined, "tagged page p1");
    expectSame(await store.getPage("p2"), undefined, "tagged page p2");
    expectSame(await store.getData("d1"), undefined, "tagged data d1");
    expectTrue(await store.getPage("p3"), "an untagged page was purged");
    expectSame((await store.getData("d2"))?.value, 2, "untagged data");
    await store.deleteByTag("no-such-tag");
  },
  "a rewrite without a tag drops the old tag": async (store) => {
    await store.setData("d", { value: 1, expiresAt: Infinity, tags: ["a"] });
    await store.setData("d", { value: 2, expiresAt: Infinity, tags: ["b"] });
    await store.setPage("p", page("/p", ["a"]));
    await store.setPage("p", page("/q", ["b"]));
    await store.deleteByTag("a");
    await store.deleteByPath("/p");
    expectSame((await store.getData("d"))?.value, 2, "data no longer tagged a");
    expectSame((await store.getPage("p"))?.path, "/q", "page no longer tagged a nor at /p");
  },
  "expireByTag soft-expires in place (when the store supports it)": async (store) => {
    if (!store.expireByTag) return;
    await store.setData("d", { value: 1, expiresAt: Infinity, tags: ["a"] });
    await store.setPage("p", page("/p", ["a"]));
    await store.setData("other", { value: 9, expiresAt: Infinity, tags: ["b"] });
    const staleAt = Date.now() - 1;
    const expiresAt = Date.now() + 60_000;
    await store.expireByTag("a", { staleAt, expiresAt });
    const d = await store.getData("d");
    expectSame([d?.value, d?.staleAt, d?.expiresAt], [1, staleAt, expiresAt], "data timing");
    const p = await store.getPage("p");
    expectSame([p?.body, p?.staleAt, p?.expiresAt], ["<p>/p</p>", staleAt, expiresAt], "page");
    expectSame((await store.getData("other"))?.staleAt, undefined, "an untagged entry");
    await store.expireByTag("a", { staleAt, expiresAt: Date.now() - 1 });
    expectSame(await store.getData("d"), undefined, "expired by a past hard expiry");
  },
  "sweepPages keeps one key prefix and counts the rest (when supported)": async (store) => {
    if (!store.sweepPages) return;
    await store.setPage("v2:new:/a", page("/a", ["t"]));
    await store.setPage("v2:old:/a", page("/a", ["t"]));
    await store.setPage("v1:/b", page("/b", []));
    await store.setData("v1:data", { value: 1, expiresAt: Infinity, tags: [] });
    expectSame(await store.sweepPages("v2:new:"), 2, "pages swept");
    expectTrue(await store.getPage("v2:new:/a"), "the kept page was swept");
    expectSame((await store.getData("v1:data"))?.value, 1, "data entries are never swept");
    expectSame(await store.sweepPages("v2:new:"), 0, "a second sweep");
  },
};

/**
 * The `CacheStore` contract: data and page round-trips, hard expiry, overwrites, large values,
 * `deleteByPath`, `deleteByTag` (and that a rewrite drops a tag), and `expireByTag` /
 * `sweepPages` when the store implements them.
 *
 * @param t Where the cases run (a `Deno.TestContext`).
 * @param make A fresh, empty store per case.
 * @throws {StoreContractError} From the case the store fails.
 */
export async function cacheStoreContract(
  t: ContractContext,
  make: StoreFactory<CacheStore>,
): Promise<void> {
  await runCases(t, make, CACHE_CASES);
}

/** Epoch seconds `offset` from now. */
const inSeconds = (offset: number): number => Math.trunc(Date.now() / 1000 + offset);

const session = (userId: string, expiresAt = inSeconds(3600)): AuthSession => ({
  user: { id: userId },
  provider: "credentials",
  expiresAt,
});

const SESSION_CASES: Record<string, (store: SessionStore) => Promise<void>> = {
  "create/get round-trip; unknown ids and expired sessions are misses": async (store) => {
    const alice = { ...session("alice"), user: { id: "alice", email: "a@x.test" } };
    await store.create("a", alice);
    expectSame(await store.get("a"), alice, "get");
    expectSame(await store.get("nope"), undefined, "unknown id");
    await store.create("old", session("carol", inSeconds(-1)));
    expectSame(await store.get("old"), undefined, "an expired session is a miss");
  },
  "create overwrites the same id": async (store) => {
    await store.create("a", session("alice"));
    await store.create("a", session("bob"));
    expectSame((await store.get("a"))?.user.id, "bob", "the second create wins");
  },
  "update rewrites a live session only (when supported)": async (store) => {
    if (!store.update) return;
    await store.create("a", session("alice"));
    const later = inSeconds(7200);
    expectSame(await store.update("a", session("alice", later)), true, "update of a live one");
    expectSame((await store.get("a"))?.expiresAt, later, "the new expiry");
    expectSame(await store.update("nope", session("x")), false, "write-only-if-present");
    expectSame(await store.get("nope"), undefined, "update must not create");
    await store.create("old", session("carol", inSeconds(-1)));
    expectSame(await store.update("old", session("carol")), false, "an expired one stays dead");
    await store.delete("a");
    expectSame(await store.update("a", session("alice")), false, "a revoked one stays revoked");
    expectSame(await store.get("a"), undefined, "and is not resurrected");
  },
  "delete revokes one session; deleteByUser revokes all of a user's": async (store) => {
    await store.create("a1", session("alice"));
    await store.create("a2", session("alice"));
    await store.create("b", session("bob"));
    await store.delete("a1");
    expectSame(await store.get("a1"), undefined, "deleted session");
    expectSame((await store.get("a2"))?.user.id, "alice", "the user's other session");
    await store.deleteByUser("alice");
    expectSame(await store.get("a2"), undefined, "after deleteByUser");
    expectSame((await store.get("b"))?.user.id, "bob", "another user's session");
    await store.delete("unknown");
    await store.deleteByUser("nobody");
  },
};

/**
 * The `SessionStore` contract: round-trips, expiry, overwrite, write-only-if-present
 * `update` (a revoked or expired session is never resurrected), `delete` and `deleteByUser`.
 *
 * @param t Where the cases run (a `Deno.TestContext`).
 * @param make A fresh, empty store per case.
 * @throws {StoreContractError} From the case the store fails.
 */
export async function sessionStoreContract(
  t: ContractContext,
  make: StoreFactory<SessionStore>,
): Promise<void> {
  await runCases(t, make, SESSION_CASES);
}

const RATE_LIMIT_CASES: Record<string, (store: RateLimitStore) => Promise<void>> = {
  "increment opens a window and counts into it without sliding it": async (store) => {
    expectSame(await store.get("k"), undefined, "no window yet");
    const before = Date.now();
    const first = await store.increment("k", 60_000);
    expectSame(first.count, 1, "the first failure");
    expectTrue(
      first.resetAt >= before + 60_000 && first.resetAt <= Date.now() + 60_000,
      `resetAt ${first.resetAt} is not now + windowMs`,
    );
    const second = await store.increment("k", 60_000);
    expectSame([second.count, second.resetAt], [2, first.resetAt], "the second failure");
    expectSame(await store.get("k"), { count: 2, resetAt: first.resetAt }, "get");
    expectSame(await store.get("other"), undefined, "keys are independent");
  },
  "concurrent increments are all counted": async (store) => {
    const counts = await Promise.all(
      Array.from({ length: 5 }, () => store.increment("k", 60_000)),
    );
    expectSame(counts.map((w) => w.count).sort(), [1, 2, 3, 4, 5], "every failure counted");
    expectSame((await store.get("k"))?.count, 5, "the total");
  },
  "reset forgets the key; decrement gives one back (when supported)": async (store) => {
    await store.increment("k", 60_000);
    await store.increment("k", 60_000);
    if (store.decrement) {
      await store.decrement("k");
      expectSame((await store.get("k"))?.count, 1, "after decrement");
      await store.decrement("k");
      await store.decrement("k");
      expectTrue(((await store.get("k"))?.count ?? 0) === 0, "decrement never goes below 0");
      await store.decrement("unknown");
      expectSame(await store.get("unknown"), undefined, "decrement must not open a window");
    }
    await store.reset("k");
    expectSame(await store.get("k"), undefined, "after reset");
    expectSame((await store.increment("k", 60_000)).count, 1, "a reset key starts over");
  },
  "a closed window reads as none and the next failure starts over": async (store) => {
    const first = await store.increment("short", 1);
    await tick(10);
    expectSame(await store.get("short"), undefined, "a closed window");
    const next = await store.increment("short", 60_000);
    expectSame(next.count, 1, "the count starts over");
    expectTrue(next.resetAt > first.resetAt, "with a new reset time");
  },
};

/**
 * The `RateLimitStore` contract: a fixed window that opens on the first failure, counts every
 * concurrent failure, closes on time, and `reset` / `decrement` (when implemented).
 *
 * @param t Where the cases run (a `Deno.TestContext`).
 * @param make A fresh, empty store per case.
 * @throws {StoreContractError} From the case the store fails.
 */
export async function rateLimitStoreContract(
  t: ContractContext,
  make: StoreFactory<RateLimitStore>,
): Promise<void> {
  await runCases(t, make, RATE_LIMIT_CASES);
}
