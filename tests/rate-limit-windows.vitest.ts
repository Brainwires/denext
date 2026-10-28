// Rate-limit windows at their exact edges, on Vitest's fake clock (denext's Deno toolchain;
// CONTRIBUTING.md → Vitest files): a window is fixed from its first count (later counts never
// stretch it), it closes exactly at `resetAt`, and `Retry-After` counts down in whole seconds,
// rounded up and never below 1 — for the auth limiter and the `rateLimit()` API middleware alike.
// The limiters' keys, budgets and eviction are tests/auth-rate-limit.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter, inMemoryRateLimitStore } from "../packages/auth/src/rate-limit.ts";
import { rateLimit } from "../src/server/api-middleware.ts";
import type { ApiMiddlewareInput } from "../src/server/define-api.ts";
import { ApiError } from "../src/server/api-error.ts";

const T0 = new Date("2026-01-01T00:00:00Z").getTime();

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Move the clock to `ms` after T0. */
const at = (ms: number) => vi.setSystemTime(T0 + ms);

describe("inMemoryRateLimitStore windows", () => {
  it("a window is fixed from its first count: later counts do not stretch it", async () => {
    const store = inMemoryRateLimitStore();
    expect(await store.increment("k", 10_000)).toEqual({ count: 1, resetAt: T0 + 10_000 });
    at(9_000);
    expect(await store.increment("k", 10_000)).toEqual({ count: 2, resetAt: T0 + 10_000 });
  });

  it("closes exactly at resetAt: live a millisecond before, gone at it", async () => {
    const store = inMemoryRateLimitStore();
    await store.increment("k", 10_000);
    at(9_999);
    expect((await store.get("k"))?.count).toBe(1);
    at(10_000);
    expect(await store.get("k")).toBeUndefined();
    expect(await store.increment("k", 10_000), "the next count opens a fresh window").toEqual({
      count: 1,
      resetAt: T0 + 20_000,
    });
  });

  it("decrement gives a unit back inside the window, and is a no-op on an expired one", async () => {
    const store = inMemoryRateLimitStore();
    await store.increment("k", 10_000);
    await store.increment("k", 10_000);
    await store.decrement?.("k");
    expect((await store.get("k"))?.count).toBe(1);
    at(10_000);
    await store.decrement?.("k");
    expect(await store.get("k")).toBeUndefined();
  });
});

describe("createRateLimiter retry-after", () => {
  it("counts down in whole seconds, rounded up, never below 1, then lifts at the window's end", async () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 30_000 });
    await limiter.fail("k");
    expect(await limiter.lockedOut("k")).toBe(30);
    at(1);
    expect(await limiter.lockedOut("k"), "29.999 s rounds up").toBe(30);
    at(1_000);
    expect(await limiter.lockedOut("k")).toBe(29);
    at(29_000);
    expect(await limiter.lockedOut("k")).toBe(1);
    at(29_999);
    expect(await limiter.lockedOut("k"), "a millisecond left is still 1 s").toBe(1);
    at(30_000);
    expect(await limiter.lockedOut("k")).toBeNull();
  });

  it("hit admits `max` per window, refuses the next with the time left, and resets with the window", async () => {
    const limiter = createRateLimiter({ max: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) expect(await limiter.hit("k")).toBeNull();
    at(45_000);
    expect(await limiter.hit("k"), "the 4th hit, 15 s before the window ends").toBe(15);
    at(60_000);
    expect(await limiter.hit("k"), "a new window, a new budget").toBeNull();
  });
});

describe("rateLimit() API middleware", () => {
  /** A minimal middleware input; the limiter here keys on a fixed `key`. */
  const input = {
    request: new Request("https://app.test/api/x"),
    method: "GET",
  } as unknown as ApiMiddlewareInput<object>;

  /** Run the middleware once, returning the 429 it threw (or null when it let the call through). */
  async function call(mw: ReturnType<typeof rateLimit>): Promise<ApiError | null> {
    try {
      await mw(input);
      return null;
    } catch (err) {
      if (err instanceof ApiError) return err;
      throw err;
    }
  }

  it("the (max+1)th call in a window is a 429 whose retry-after is the time left, rounded up", async () => {
    const mw = rateLimit({ max: 2, windowMs: 10_000, key: () => "k" });
    expect(await call(mw)).toBeNull();
    at(2_500);
    expect(await call(mw)).toBeNull();
    at(7_500);
    const refused = await call(mw);
    expect(refused?.status).toBe(429);
    expect(refused?.code).toBe("rate_limited");
    expect(refused?.data).toEqual({ retryAfter: 3 }); // 2.5 s left → 3
    expect(new Headers(refused?.headers).get("retry-after")).toBe("3");
    at(9_999);
    expect((await call(mw))?.data, "never below 1 s").toEqual({ retryAfter: 1 });
    at(10_000);
    expect(await call(mw), "the window closed: the budget is back").toBeNull();
  });
});
