// In-process SSR dispatch for the typed API client (src/server/api-dispatcher.ts): a call made
// inside a request context never touches the network — it runs as a sub-request through the
// full pipeline under the caller's identity, and a cacheable GET rides the tag-aware cache.

import { assert, assertEquals } from "@std/assert";
import { createApiClient, isApiClientError } from "../src/runtime/api-client.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { revalidateTag } from "../src/server/cache.ts";
import { batchApp, counters, ORIGIN } from "./helpers/batch-app.ts";

/** A fetch that must never be reached. */
const noNetwork = (() => {
  throw new Error("network fetch must not be used for an in-process call");
}) as unknown as typeof fetch;

/** A fetch that records it was used (for the fall-back cases). */
function recordingFetch(): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = ((input: URL | RequestInfo) => {
    calls.push(String(input));
    return Promise.resolve(Response.json({ external: true }));
  }) as typeof fetch;
  return { fetch: impl, calls };
}

type S = {
  "/api/echo": { GET: { response: { q: string; cookie: string | null } } };
  "/api/when": { GET: { response: { at: Date } } };
  "/api/boom": { GET: { response: unknown; errors: "conflict" } };
  "/api/dynamic": { GET: { response: { theme: string | null } } };
  "/api/count": { GET: { response: { n: number } } };
  "/api/self": { GET: { response: unknown } };
};

/** Run `fn` inside a request context for a page request carrying `cookie`. */
function asRequest<T>(
  cookie: string,
  fn: (ctx: ReturnType<typeof createRequestContext>) => Promise<T>,
): Promise<T> {
  const ctx = createRequestContext(new Request(`${ORIGIN}/page`, { headers: { cookie } }));
  return runWithContext(ctx, () => fn(ctx));
}

Deno.test("in-process: a server-side call runs through the pipeline with the caller's cookies, no network", async () => {
  batchApp(); // createApp installs the dispatcher
  await asRequest("session=abc; theme=dark", async () => {
    const api = createApiClient<S>({ fetch: noNetwork });
    const echo = await api("/api/echo", "GET", { query: { x: "1" } });
    assertEquals(echo, { q: "?x=1", cookie: "session=abc; theme=dark" });
    const when = await api("/api/when", "GET");
    assert(when.at instanceof Date, "the codec applies in-process too");
    const err = await api("/api/boom", "GET").catch((e) => e);
    assert(isApiClientError(err));
    assertEquals([err.status, err.code], [409, "conflict"]);
  });
});

Deno.test("in-process: a dynamic-API read inside the route marks the PARENT render dynamic", async () => {
  batchApp();
  await asRequest("theme=dark", async (ctx) => {
    const api = createApiClient<S>({ fetch: noNetwork });
    assertEquals(await api("/api/dynamic", "GET"), { theme: "dark" });
    assertEquals(ctx.usedDynamicApi, true, "the page must not be cached as static now");
  });
});

Deno.test("in-process: `next.tags` caches the call under the tag; revalidateTag purges it", async () => {
  batchApp();
  counters.count = 0;
  await asRequest("u=1", async (ctx) => {
    const api = createApiClient<S>({ fetch: noNetwork });
    const a = await api("/api/count", "GET", { next: { tags: ["counter"] } });
    const b = await api("/api/count", "GET", { next: { tags: ["counter"] }, dedupe: false });
    assertEquals([a.n, b.n], [1, 1], "the second call is a cache hit");
    assert(ctx.collectedTags?.has("counter"), "the page collected the tag");
    await revalidateTag("counter");
    const c = await api("/api/count", "GET", { next: { tags: ["counter"] }, dedupe: false });
    assertEquals(c.n, 2, "purged by the tag");
    // Without cache options the call is uncached, like fetch.
    const d = await api("/api/count", "GET", { dedupe: false });
    const e = await api("/api/count", "GET", { dedupe: false });
    assertEquals([d.n, e.n], [3, 4]);
  });
});

Deno.test("in-process: the cache key includes the caller's cookie — two users never share an entry", async () => {
  batchApp();
  counters.count = 0;
  const call = (cookie: string) =>
    asRequest(
      cookie,
      () =>
        createApiClient<S>({ fetch: noNetwork })("/api/count", "GET", {
          next: { tags: ["per-user"] },
        }),
    );
  assertEquals((await call("session=alice")).n, 1);
  assertEquals((await call("session=alice")).n, 1, "same user: hit");
  assertEquals((await call("session=bob")).n, 2, "other user: miss");
});

Deno.test("in-process: the cache key ignores non-identity headers (UA, XFF) — no per-request entry minting", async () => {
  batchApp();
  counters.count = 0;
  const call = (headers: Record<string, string>) => {
    const ctx = createRequestContext(new Request(`${ORIGIN}/page`, { headers }));
    return runWithContext(
      ctx,
      () =>
        createApiClient<S>({ fetch: noNetwork })("/api/count", "GET", {
          next: { tags: ["by-ua"] },
        }),
    );
  };
  const cookie = "session=carol";
  assertEquals((await call({ cookie, "user-agent": "one" })).n, 1);
  assertEquals(
    (await call({ cookie, "user-agent": "two", "x-forwarded-for": "9.9.9.9" })).n,
    1,
    "same user: hit",
  );
  assertEquals(
    (await call({ cookie: "session=dave", "user-agent": "one" })).n,
    2,
    "other user: miss",
  );
});

Deno.test("in-process: a route calling itself terminates (508 Loop Detected)", async () => {
  batchApp();
  await asRequest("", async () => {
    const api = createApiClient<S>({ fetch: noNetwork });
    const err = await api("/api/self", "GET").catch((e) => e);
    assert(isApiClientError(err));
    // The leaf call is the 508; each enclosing plain handler receives that as a thrown error and
    // answers a redacted 500 — either way the recursion ends instead of hanging or overflowing.
    assert(err.status === 508 || err.status === 500, `terminated with ${err.status}`);
  });
});

Deno.test("in-process: outside a request, a foreign origin, or a reserved path fall back to fetch", async () => {
  batchApp();
  const { fetch, calls } = recordingFetch();
  const api = createApiClient<S>({ fetch, batch: false });
  await api("/api/echo", "GET"); // no request context
  await asRequest("", async () => {
    const foreign = createApiClient<S>({ fetch, base: "https://other.example", batch: false });
    await foreign("/api/echo", "GET");
    await api("/_denext/live" as "/api/echo", "GET"); // reserved: never in-process
  });
  assertEquals(calls, ["/api/echo", "https://other.example/api/echo", "/_denext/live"]);
});
