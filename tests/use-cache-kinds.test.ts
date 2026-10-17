// Next.js 16's `"use cache"` handler kinds and nesting rules: `"use cache: private"` (may read
// cookies()/headers(), never stored on the server, deduplicated within one request),
// `"use cache: remote"` (a shared entry like `"use cache"`), the transform that emits the kind,
// nested-cache tag/lifetime propagation, the revalidate-inside-a-cache error and next/cache's
// `navigation()` / `prefetch()` / `io()`. Expectations follow Next.js 16's
// `use-cache-wrapper.ts`, `cache-life.ts`, `revalidate.ts` and `cache-stages.ts`.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { toFileUrl } from "@std/path";
import { transformUseCache } from "../src/build/use-cache-transform.ts";
import {
  __useCache,
  cacheLife,
  cacheTag,
  inMemoryCacheStore,
  revalidatePath,
  revalidateTag,
  setCacheStore,
  unstable_cache,
  updateTag,
} from "../src/server/cache.ts";
import {
  connection,
  cookies,
  createRequestContext,
  headers,
  runWithContext,
} from "../src/server/request-context.ts";
import { isPostpone, withPrerender } from "../src/runtime/prerender.ts";
import {
  io,
  navigation,
  prefetch,
  unstable_navigation,
  unstable_prefetch,
} from "../src/compat/next/cache.ts";

const MOD = "file:///proj/kinds.ts";

/** A request carrying `cookie`. */
function request(cookie = "sid=a"): ReturnType<typeof createRequestContext> {
  return createRequestContext(new Request("http://x/", { headers: { cookie, "x-user": "u1" } }));
}

// ---- transform -------------------------------------------------------------------

Deno.test("transform: `use cache: private` / `: remote` pass their kind; bare `use cache` passes none", async () => {
  const { code } = await transformUseCache(
    `export async function a() { "use cache: private"; return 1; }\n` +
      `export async function b() { "use cache: remote"; return 2; }\n` +
      `export async function c() { "use cache"; return 3; }\n` +
      `export async function d() { "use cache:custom-handler"; return 4; }\n`,
    MOD,
  );
  assertStringIncludes(code, `return 1; }, { kind: "private" });`);
  assertStringIncludes(code, `return 2; }, { kind: "remote" });`);
  assertStringIncludes(code, `return 3; }, {});`);
  assertStringIncludes(code, `return 4; }, { kind: "custom-handler" });`);
});

Deno.test("transform: a module-level kind applies to every function; a function's own wins", async () => {
  const { code } = await transformUseCache(
    `"use cache: private";\n` +
      `export async function a() { return 1; }\n` +
      `export const b = async () => { "use cache"; return 2; };\n`,
    MOD,
  );
  assertStringIncludes(code, `return 1; }, { kind: "private" });`);
  assertStringIncludes(code, `return 2; }, {});`);
});

Deno.test("transform: a cached method carries its kind beside the bound values", async () => {
  const { code } = await transformUseCache(
    `export function make(n) {\n` +
      `  return { async get() { "use cache: private"; return n; } };\n` +
      `}\n`,
    MOD,
  );
  assertStringIncludes(code, `{ kind: "private", bound: () => [n] }`);
});

Deno.test("transform: a string that isn't a cache directive is left alone", async () => {
  const { changed } = await transformUseCache(
    `export async function a() { "use cache please"; return 1; }\n`,
    MOD,
  );
  assert(!changed);
});

// ---- "use cache: private" ----------------------------------------------------------

Deno.test("private: reads cookies() and headers(), never stores, dedupes within one request", async () => {
  const store = inMemoryCacheStore();
  setCacheStore(store);
  let runs = 0;
  const greet = __useCache("k#greet", async (name: string) => {
    runs++;
    const sid = (await cookies()).get("sid")?.value;
    return `${name}:${sid}:${(await headers()).get("x-user")}`;
  }, { kind: "private" });

  const ctx = request("sid=a");
  await runWithContext(ctx, async () => {
    assertEquals(await greet("hi"), "hi:a:u1");
    assertEquals(await greet("hi"), "hi:a:u1");
    assertEquals(runs, 1, "a matching call in the same request reuses the result");
    assertEquals(await greet("yo"), "yo:a:u1");
    assertEquals(runs, 2, "other arguments run again");
  });
  assert(ctx.usedDynamicApi, "a private cache makes the render dynamic (never page-cached)");
  // Another request (another user) runs it again with its own cookies.
  assertEquals(await runWithContext(request("sid=b"), () => greet("hi")), "hi:b:u1");
  assertEquals(runs, 3);
  assertEquals(await store.getData(JSON.stringify(["k#greet", ["hi"]])), undefined, "not stored");
});

Deno.test("private: cacheLife and cacheTag are allowed inside", async () => {
  const f = __useCache("k#life", () => {
    cacheLife({ stale: 60 });
    cacheTag("recommendations-1");
    return Promise.resolve("ok");
  }, { kind: "private" });
  assertEquals(await runWithContext(request(), () => f()), "ok");
});

Deno.test("private: connection() and cookie writes are refused inside", async () => {
  const conn = __useCache("k#conn", async () => {
    await connection();
    return 1;
  }, { kind: "private" });
  await assertRejects(
    () => runWithContext(request(), () => conn()),
    Error,
    '`connection()` can\'t be called inside `"use cache: private"`',
  );
  const write = __useCache("k#write", async () => {
    (await cookies()).set("x", "1");
    return 1;
  }, { kind: "private" });
  await assertRejects(
    () => runWithContext(request(), () => write()),
    Error,
    'can\'t be called inside `"use cache: private"`',
  );
});

Deno.test("private: refused inside `use cache`, inside unstable_cache and outside a request", async () => {
  setCacheStore(inMemoryCacheStore());
  const priv = __useCache("k#p", () => Promise.resolve(1), { kind: "private" });
  const inPublic = __useCache("k#pub", () => priv(), {});
  await assertRejects(
    () => runWithContext(request(), () => inPublic()),
    Error,
    'can\'t be nested inside `"use cache"`',
  );
  const inUnstable = unstable_cache(() => priv(), ["k#u"]);
  await assertRejects(
    () => runWithContext(request(), () => inUnstable()),
    Error,
    "can't be used inside `unstable_cache()`",
  );
  await assertRejects(() => priv(), Error, "needs an active request");
});

Deno.test("private: a private function may call another private one and a shared one", async () => {
  setCacheStore(inMemoryCacheStore());
  let sharedRuns = 0;
  const shared = __useCache("k#shared", (n: number) => {
    sharedRuns++;
    return Promise.resolve(n * 2);
  }, {});
  const inner = __useCache("k#inner", async () => (await cookies()).get("sid")?.value, {
    kind: "private",
  });
  const outer = __useCache("k#outer", async () => `${await inner()}-${await shared(2)}`, {
    kind: "private",
  });
  assertEquals(await runWithContext(request("sid=z"), () => outer()), "z-4");
  assertEquals(await runWithContext(request("sid=y"), () => outer()), "y-4");
  assertEquals(sharedRuns, 1, "the shared entry nested in a private one is still shared");
  // ...and the shared function's own scope refuses request data again.
  const leaky = __useCache("k#leaky", async () => (await cookies()).get("sid")?.value, {});
  const viaPrivate = __useCache("k#via", () => leaky(), { kind: "private" });
  await assertRejects(
    () => runWithContext(request(), () => viaPrivate()),
    Error,
    'can\'t be read inside `"use cache"`',
  );
});

Deno.test("private: a PPR prerender postpones it to a per-request hole", async () => {
  let ran = false;
  const f = __useCache("k#ppr", () => {
    ran = true;
    return Promise.resolve(1);
  }, { kind: "private" });
  const err = await runWithContext(request(), () => withPrerender(() => f()))
    .then(() => null, (e) => e);
  assert(isPostpone(err), "postponed");
  assert(!ran, "the body did not run in the prerender");
});

Deno.test("private: a failed run is not reused within the request", async () => {
  let n = 0;
  const f = __useCache("k#fail", () => {
    n++;
    return n === 1 ? Promise.reject(new Error("first")) : Promise.resolve(n);
  }, { kind: "private" });
  await runWithContext(request(), async () => {
    await assertRejects(() => f(), Error, "first");
    assertEquals(await f(), 2);
  });
});

// ---- "use cache: remote" -------------------------------------------------------------

Deno.test("remote: a shared entry in the configured store, refusing request data like `use cache`", async () => {
  const store = inMemoryCacheStore();
  setCacheStore(store);
  let runs = 0;
  const f = __useCache("k#remote", (lang: string) => {
    runs++;
    return Promise.resolve(`content-${lang}`);
  }, { kind: "remote" });
  assertEquals(await runWithContext(request("sid=a"), () => f("en")), "content-en");
  assertEquals(await runWithContext(request("sid=b"), () => f("en")), "content-en");
  assertEquals(runs, 1, "shared across requests");
  assert(await store.getData(JSON.stringify(["k#remote", ["en"]])), "stored in the cache store");
  const leaky = __useCache("k#remote-leak", async () => (await cookies()).get("sid"), {
    kind: "remote",
  });
  await assertRejects(
    () => runWithContext(request(), () => leaky()),
    Error,
    "can't be read inside",
  );
});

// ---- nesting: tags and lifetimes reach the outer entry ---------------------------------

Deno.test("nested: an inner entry's tags reach the outer one, so revalidateTag(inner) purges both", async () => {
  setCacheStore(inMemoryCacheStore());
  let innerRuns = 0;
  let outerRuns = 0;
  const inner = __useCache("k#n-inner", () => {
    innerRuns++;
    cacheTag("posts");
    return Promise.resolve(innerRuns);
  }, {});
  const outer = __useCache("k#n-outer", async () => {
    outerRuns++;
    return `outer(${await inner()})`;
  }, {});
  assertEquals(await runWithContext(request(), () => outer()), "outer(1)");
  assertEquals(await runWithContext(request(), () => outer()), "outer(1)");
  assertEquals(outerRuns, 1);
  await revalidateTag("posts");
  assertEquals(await runWithContext(request(), () => outer()), "outer(2)", "both recomputed");
  assertEquals(outerRuns, 2);
});

Deno.test("nested: an outer entry lives no longer than its inner one unless it sets cacheLife", async () => {
  const store = inMemoryCacheStore();
  setCacheStore(store);
  const inner = __useCache("k#l-inner", () => {
    cacheLife("minutes"); // revalidate 60, expire 3600
    return Promise.resolve(1);
  }, {});
  const outer = __useCache("k#l-outer", () => inner(), {});
  const explicit = __useCache("k#l-explicit", () => {
    cacheLife("days");
    return inner();
  }, {});
  const t0 = Date.now();
  await runWithContext(request(), async () => {
    await outer();
    await explicit();
  });
  const o = await store.getData(JSON.stringify(["k#l-outer", []]));
  assert(
    o && o.expiresAt <= Date.now() + 3600_000 && o.expiresAt >= t0 + 3599_000,
    "expire ≤ inner's",
  );
  assert(o.staleAt! <= Date.now() + 60_000, "revalidate ≤ inner's");
  const e = await store.getData(JSON.stringify(["k#l-explicit", []]));
  assert(e && e.expiresAt >= t0 + 604800_000, "an explicit cacheLife wins over the nested one");
});

// ---- revalidating from inside a cached function -----------------------------------------

Deno.test("revalidateTag / revalidatePath / updateTag throw inside a cached function", async () => {
  setCacheStore(inMemoryCacheStore());
  for (
    const [label, call] of [
      ["revalidateTag", () => revalidateTag("x", "max")],
      ["revalidatePath", () => revalidatePath("/x")],
      ["updateTag", () => updateTag("x")],
    ] as const
  ) {
    const f = __useCache(`k#rv-${label}`, async () => {
      await call();
      return 1;
    }, {});
    await assertRejects(
      () => runWithContext(request(), () => f()),
      Error,
      "can't be called inside a cached function",
    );
  }
  // Outside a cache scope they work as before.
  await runWithContext(request(), () => revalidateTag("x", "max"));
});

Deno.test("revalidateTag(tag, profile) validates the profile as Next.js does", () => {
  let thrown: unknown;
  try {
    revalidateTag("x", "no-such-profile");
  } catch (e) {
    thrown = e;
  }
  assertStringIncludes(String(thrown), 'Unknown `cacheLife()` profile "no-such-profile"');
  thrown = undefined;
  try {
    revalidateTag("x", { revalidate: 10, expire: 1 });
  } catch (e) {
    thrown = e;
  }
  assertStringIncludes(String(thrown), "the expire option must be greater");
});

// ---- next/cache: navigation() / prefetch() / io() -----------------------------------------

Deno.test("navigation() / prefetch() resolve in a request and keep the render cacheable", async () => {
  const ctx = request();
  await runWithContext(ctx, async () => {
    assertEquals(await navigation(), undefined);
    assertEquals(await prefetch(), undefined);
  });
  assert(!ctx.usedDynamicApi, "the stage markers don't make the render dynamic");
});

Deno.test("navigation() / prefetch() throw outside a request and inside cached functions", async () => {
  setCacheStore(inMemoryCacheStore());
  for (const [name, fn] of [["navigation", navigation], ["prefetch", prefetch]] as const) {
    let thrown: unknown;
    try {
      fn();
    } catch (e) {
      thrown = e;
    }
    assertStringIncludes(String(thrown), `\`${name}\` was called outside a request scope`);
    const cached = __useCache(`k#stage-${name}`, async () => {
      await fn();
      return 1;
    }, {});
    await assertRejects(
      () => runWithContext(request(), () => cached()),
      Error,
      `used \`${name}()\` inside "use cache"`,
    );
    const priv = __useCache(`k#stage-p-${name}`, async () => {
      await fn();
      return 1;
    }, { kind: "private" });
    await assertRejects(
      () => runWithContext(request(), () => priv()),
      Error,
      `used \`${name}()\` inside "use cache: private"`,
    );
    const unstable = unstable_cache(async () => {
      await fn();
      return 1;
    }, [`k#stage-u-${name}`]);
    await assertRejects(
      () => runWithContext(request(), () => unstable()),
      Error,
      "inside a function cached with `unstable_cache()`",
    );
  }
});

Deno.test("the Next 16.4 canary spellings are aliases of navigation() / prefetch()", () => {
  assertEquals(unstable_navigation, navigation);
  assertEquals(unstable_prefetch, prefetch);
});

Deno.test("io() returns a promise that resolves (Next 16's signature), anywhere", async () => {
  const p = io();
  assert(p instanceof Promise);
  assertEquals(await p, undefined);
});

// ---- integration: a transformed module's private function ---------------------------------

Deno.test("integration: a transformed `use cache: private` export reads the request's cookie", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const src =
      `import { cookies } from ${
        JSON.stringify(new URL("../src/server/request-context.ts", import.meta.url).href)
      };\n` +
      `let calls = 0;\n` +
      `export async function who() { "use cache: private"; calls++; ` +
      `return (await cookies()).get("sid")?.value; }\n` +
      `export function callCount() { return calls; }\n`;
    const url = toFileUrl(`${dir}/who.ts`).href;
    const { code, changed } = await transformUseCache(src, url);
    assert(changed);
    await Deno.writeTextFile(`${dir}/who.transformed.ts`, code);
    const mod = await import(toFileUrl(`${dir}/who.transformed.ts`).href) as {
      who: () => Promise<string>;
      callCount: () => number;
    };
    assertEquals(await runWithContext(request("sid=one"), () => mod.who()), "one");
    assertEquals(await runWithContext(request("sid=two"), () => mod.who()), "two");
    assertEquals(mod.callCount(), 2, "never shared across requests");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
