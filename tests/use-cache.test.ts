// Part B: the `"use cache"` directive — the build-time AST transform
// (src/build/use-cache-transform.ts) and its runtime executor `__useCache`
// (src/server/cache.ts).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { toFileUrl } from "@std/path";
import { transformUseCache } from "../src/build/use-cache-transform.ts";
import { swcParse } from "../src/build/swc-ast.ts";
import {
  __useCache,
  cacheLife,
  cacheTag,
  inMemoryCacheStore,
  setCacheStore,
  updateTag,
} from "../src/server/cache.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";

const MOD = "file:///proj/mod.ts";

/** Assert that `code` re-parses cleanly (the transform never emits broken source). */
async function assertParses(code: string): Promise<void> {
  const parse = await swcParse();
  await parse("0;\n" + code); // throws on a syntax error
}

// ---- B1: build-time transform ---------------------------------------------

Deno.test("B1: function-body directive on a non-exported declaration is wrapped", async () => {
  const { code, changed } = await transformUseCache(
    `async function getPosts(tag) { "use cache"; return tag; }\nexport { getPosts };`,
    MOD,
  );
  assert(changed);
  await assertParses(code);
  assertStringIncludes(code, "const getPosts = _dnxUseCache(");
  assertStringIncludes(code, "__useCache as _dnxUseCache");
});

Deno.test("B1: exported function declaration becomes an exported cache wrapper", async () => {
  const { code, changed } = await transformUseCache(
    `export async function getUser(id) { "use cache"; return id; }`,
    MOD,
  );
  assert(changed);
  await assertParses(code);
  assertStringIncludes(code, "export const getUser = _dnxUseCache(");
});

Deno.test("B1: exported const arrow is wrapped in place (binding preserved)", async () => {
  const { code, changed } = await transformUseCache(
    `export const getThing = async (x) => { "use cache"; return x; };`,
    MOD,
  );
  assert(changed);
  await assertParses(code);
  assertStringIncludes(code, "export const getThing = _dnxUseCache(");
});

Deno.test("B1: named default export function is wrapped", async () => {
  const { code, changed } = await transformUseCache(
    `export default async function Page(props) { "use cache"; return props; }`,
    MOD,
  );
  assert(changed);
  await assertParses(code);
  assertStringIncludes(code, "export default _dnxUseCache(");
});

Deno.test("B1: a name-referenced default export is left untouched (correctness)", async () => {
  // `Page` is referenced by another statement, so demoting it to an expression
  // would break that reference — the transform must bail.
  const { changed } = await transformUseCache(
    `export default async function Page(){ "use cache"; return 1; }\nconsole.log(Page.name);`,
    MOD,
  );
  assertEquals(changed, false);
});

Deno.test("B1: module-top directive caches every top-level function", async () => {
  const { code, changed } = await transformUseCache(
    `"use cache";\nimport { db } from "./db.ts";\n` +
      `export async function a() { return db(); }\nexport const b = async () => 2;`,
    MOD,
  );
  assert(changed);
  await assertParses(code);
  assertStringIncludes(code, "export const a = _dnxUseCache(");
  assertStringIncludes(code, "export const b = _dnxUseCache(");
  // Relative import specifiers are rewritten to absolute (output lives in a temp dir).
  assertStringIncludes(code, "/proj/db.ts");
});

Deno.test("B1: a module with no directive is returned unchanged", async () => {
  const src = `export async function plain() { return 1; }`;
  const { code, changed } = await transformUseCache(src, MOD);
  assertEquals(changed, false);
  assertEquals(code, src);
});

Deno.test("B1: distinct functions get distinct cache-key prefixes", async () => {
  const { code } = await transformUseCache(
    `export async function a(){ "use cache"; return 1; }\n` +
      `export async function b(){ "use cache"; return 2; }`,
    MOD,
  );
  const ids = [...code.matchAll(/_dnxUseCache\("([^"]+)"/g)].map((m) => m[1]);
  assertEquals(ids.length, 2);
  assert(ids[0] !== ids[1], "each function has a unique id");
  assertStringIncludes(ids[0], "#a");
  assertStringIncludes(ids[1], "#b");
});

// ---- B2: runtime executor `__useCache` ------------------------------------

Deno.test("B2: a cached function runs once across calls with the same args", async () => {
  setCacheStore(inMemoryCacheStore());
  let n = 0;
  const f = __useCache("m#f", (x: number) => Promise.resolve(x + ++n));
  const ctx = createRequestContext(new Request("http://x/"));
  await runWithContext(ctx, async () => {
    assertEquals(await f(10), 11, "first call computes (10 + n=1)");
    assertEquals(await f(10), 11, "second call is a cache hit (n unchanged)");
    assertEquals(await f(20), 22, "different args recompute (20 + n=2)");
  });
});

Deno.test("B2: cacheTag in the body propagates to the page and enables invalidation", async () => {
  setCacheStore(inMemoryCacheStore());
  let n = 0;
  const f = __useCache("m#tagged", () => {
    cacheTag("posts");
    return Promise.resolve(++n);
  });
  const ctx = createRequestContext(new Request("http://x/"));
  await runWithContext(ctx, async () => {
    assertEquals(await f(), 1);
    // The tag reached the enclosing render (so revalidateTag can purge the page).
    assert(ctx.collectedTags?.has("posts"), "cacheTag propagated to the page");
    // A same-request updateTag forces the next read to recompute (read-your-writes).
    await updateTag("posts");
    assertEquals(await f(), 2, "updateTag busted the cached entry");
  });
});

Deno.test("B2: cacheLife controls the entry's staleness window", async () => {
  setCacheStore(inMemoryCacheStore());
  const store = inMemoryCacheStore();
  setCacheStore(store);
  let n = 0;
  const f = __useCache("m#life", () => {
    cacheLife("max"); // revalidate 30d, expire Infinity
    return Promise.resolve(++n);
  });
  const ctx = createRequestContext(new Request("http://x/"));
  await runWithContext(ctx, async () => {
    assertEquals(await f(), 1);
    // Stored entry should carry a far-future staleAt (not stale now) and no hard expiry.
    const entry = await store.getData(JSON.stringify(["m#life", []]));
    assert(entry, "entry stored");
    assertEquals(entry!.expiresAt, Infinity, "max profile never hard-expires");
    assert(entry!.staleAt != null && entry!.staleAt > Date.now(), "not yet stale");
    assertEquals(await f(), 1, "served from cache while fresh");
  });
});

Deno.test("B2: concurrent misses are single-flighted (body runs once)", async () => {
  setCacheStore(inMemoryCacheStore());
  let running = 0;
  let peak = 0;
  const f = __useCache("m#sf", async () => {
    running++;
    peak = Math.max(peak, running);
    await Promise.resolve();
    running--;
    return 42;
  });
  const ctx = createRequestContext(new Request("http://x/"));
  await runWithContext(ctx, async () => {
    const [a, b, c] = await Promise.all([f(), f(), f()]);
    assertEquals([a, b, c], [42, 42, 42]);
    assertEquals(peak, 1, "the body never ran concurrently for the same key");
  });
});

// ---- Integration: transform + import + execute ----------------------------

Deno.test("integration: a transformed module's cached export runs once across requests", async () => {
  setCacheStore(inMemoryCacheStore());
  const dir = await Deno.makeTempDir();
  try {
    // A module whose data function opts into caching via a function-body directive.
    const src = `let calls = 0;\n` +
      `export async function load(k) { "use cache"; calls++; return { k, calls }; }\n` +
      `export function callCount() { return calls; }\n`;
    const url = toFileUrl(`${dir}/data.ts`).href;
    const { code, changed } = await transformUseCache(src, url);
    assert(changed);
    const outPath = `${dir}/data.transformed.ts`;
    await Deno.writeTextFile(outPath, code);
    const mod = await import(toFileUrl(outPath).href) as {
      load: (k: string) => Promise<{ k: string; calls: number }>;
      callCount: () => number;
    };

    // Two separate requests, same argument: the body executes exactly once.
    const first = createRequestContext(new Request("http://x/1"));
    const r1 = await runWithContext(first, () => mod.load("a"));
    const second = createRequestContext(new Request("http://x/2"));
    const r2 = await runWithContext(second, () => mod.load("a"));

    assertEquals(r1, r2, "both requests see the same cached value");
    assertEquals(mod.callCount(), 1, "the cached body ran once across both requests");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
