// Part B: the `"use cache"` directive — the build-time AST transform
// (src/build/use-cache-transform.ts) and its runtime executor `__useCache`
// (src/server/cache.ts).

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
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

Deno.test("B1: a name-referenced default export is cached and keeps its binding", async () => {
  // `Page` is referenced by another statement: the wrapper re-binds the name and
  // exports it as the default, so both the reference and the default are the cache.
  const { code, changed } = await transformUseCache(
    `export default async function Page(){ "use cache"; return 1; }\nconsole.log(Page.name);`,
    MOD,
  );
  assert(changed);
  await assertParses(code);
  assertStringIncludes(code, "const Page = _dnxUseCache(");
  assertStringIncludes(code, "export { Page as default }");
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

Deno.test("B2: a follower escapes on its own abort even while the leader body hangs", async () => {
  // The coalesced follower must not be pinned by a hung leader body once its OWN request
  // aborts — it races the wait against the request signal (matches `unstable_cache`).
  setCacheStore(inMemoryCacheStore());
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started = false;
  const f = __useCache("m#follower-abort", async () => {
    started = true;
    await gate;
    return "v";
  });

  const leaderP = runWithContext(createRequestContext(new Request("http://x/")), () => f());
  while (!started) await new Promise((r) => setTimeout(r, 1));

  const ac = new AbortController();
  ac.abort();
  const followerP = runWithContext(
    createRequestContext(new Request("http://x/"), ac.signal),
    () => f(),
  );
  const err = await assertRejects(() => followerP);
  assertEquals((err as { name?: string }).name, "AbortError", "follower unwinds via its signal");

  release();
  assertEquals(await leaderP, "v");
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

// ---- B3: cached COMPONENTS (element-tree results, element-tree arguments) ------------

Deno.test("B3: a result that doesn't survive JSON stays live in-process (a cached component's tree)", async () => {
  const { clearLiveCacheResults, isJsonSafe } = await import("../src/server/cache.ts");
  setCacheStore(inMemoryCacheStore());
  clearLiveCacheResults();
  let n = 0;
  // What a cached layout returns: an element tree whose `type` is a component function.
  const Comp = () => null;
  const f = __useCache(
    "m#tree",
    (id: number) => Promise.resolve({ type: Comp, props: { id, n: ++n } }),
  );
  const ctx = createRequestContext(new Request("http://x/"));
  await runWithContext(ctx, async () => {
    const first = await f(1);
    const again = await f(1);
    assertEquals(again.type, Comp, "the hit hands back the live tree, component function intact");
    assertEquals(again.props.n, first.props.n, "computed once");
    assertEquals((await f(2)).props.n, 2, "different args compute");
  });
  assertEquals(isJsonSafe({ a: [1, "x", { b: null }] }), true);
  assertEquals(isJsonSafe({ type: Comp }), false);
  assertEquals(isJsonSafe([undefined]), false);
  assertEquals(isJsonSafe(new Map()), false);
});

Deno.test("B3: non-serializable ARGUMENTS bypass the cache (children trees can't key an entry)", async () => {
  setCacheStore(inMemoryCacheStore());
  let n = 0;
  const Layout = __useCache("m#layout", (props: { children: unknown }) => {
    cacheTag("layout");
    return Promise.resolve({ n: ++n, children: props.children });
  });
  const ctx = createRequestContext(new Request("http://x/"));
  await runWithContext(ctx, async () => {
    const PageA = () => null;
    const PageB = () => null;
    const a = await Layout({ children: { type: PageA, props: {} } });
    const b = await Layout({ children: { type: PageB, props: {} } });
    assertEquals(a.n, 1);
    assertEquals(b.n, 2, "ran again — a lossy key must not serve page A's tree to page B");
    assertEquals((b.children as { type: unknown }).type, PageB);
  });
});

Deno.test("B3: a live component result is dropped by revalidateTag and by expiry", async () => {
  const { clearLiveCacheResults, revalidateTag } = await import("../src/server/cache.ts");
  setCacheStore(inMemoryCacheStore());
  clearLiveCacheResults();
  let n = 0;
  const Comp = () => null;
  const f = __useCache("m#live-tag", () => {
    cacheTag("widgets");
    return Promise.resolve({ type: Comp, n: ++n });
  });
  const ctx = createRequestContext(new Request("http://x/"));
  await runWithContext(ctx, async () => {
    assertEquals((await f()).n, 1);
    assertEquals((await f()).n, 1, "live hit");
  });
  await revalidateTag("widgets");
  const ctx2 = createRequestContext(new Request("http://x/"));
  await runWithContext(ctx2, async () => {
    assertEquals((await f()).n, 2, "recomputed after the tag was invalidated");
  });
});

Deno.test("B3: a stale non-serializable result revives into the live store, not durably (no stuck recompute)", async () => {
  // Regression: `reviveStaleUseCache` used to always `setData` durably, even for a
  // component-tree value that belongs in the in-process `liveResults` map. The stale
  // live entry (its `staleAt` frozen in the past) was never replaced, so `lookupLive`
  // (checked before the durable store) kept serving it and re-triggering the background
  // recompute on every request — a value that revalidated forever.
  const { clearLiveCacheResults } = await import("../src/server/cache.ts");
  setCacheStore(inMemoryCacheStore());
  clearLiveCacheResults();
  const Comp = () => null;
  let n = 0;
  const f = __useCache("m#revive-live", () => {
    // First compute is born stale; the revalidated value has a long fresh window.
    const revalidate = n === 0 ? 0 : 3600;
    cacheLife({ revalidate, expire: 3600 });
    return Promise.resolve({ type: Comp, n: ++n });
  });
  const drain = (ctx: ReturnType<typeof createRequestContext>) =>
    Promise.all(ctx.deferred.map((d) => d()));

  const ctx1 = createRequestContext(new Request("http://x/"));
  await runWithContext(ctx1, async () => {
    assertEquals((await f()).n, 1, "first request computes the (immediately stale) tree");
    assertEquals((await f()).n, 1, "same request serves the stale value while a revive is queued");
  });
  await drain(ctx1); // run the background revalidation → n becomes 2

  const ctx2 = createRequestContext(new Request("http://x/"));
  await runWithContext(ctx2, async () => {
    // With the fix, the revived (fresh) tree is now the live entry: a plain hit, no
    // further recompute. With the bug, the live entry was still the original stale n=1,
    // so this served 1 and queued yet another revive.
    assertEquals((await f()).n, 2, "the revived fresh tree replaced the stale live entry");
    assertEquals((await f()).n, 2, "and it stays a fresh hit — not re-revalidated");
    assertEquals(ctx2.deferred.length, 0, "no new revive was queued for a fresh live entry");
  });
});

// ---- B5: methods (class static / object literal) and `this` rules ------------------

Deno.test("B5: a static class method is cached, keyed on class + method", async () => {
  const { code, changed } = await transformUseCache(
    `export class Repo {\n  static async get(id: string): Promise<string> { "use cache"; return id; }\n}`,
    MOD,
  );
  assert(changed);
  await assertParses(code);
  assertStringIncludes(code, "static get = _dnxUseCache(");
  const ids = [...code.matchAll(/_dnxUseCache\("([^"]+)"/g)].map((m) => m[1]);
  assertEquals(ids.length, 1);
  assertStringIncludes(ids[0], "#Repo.get");
});

Deno.test("B5: an object-literal method is cached, keyed on object + key", async () => {
  const { code, changed } = await transformUseCache(
    `export const api = {\n  async get(id) { "use cache"; return id; },\n  ["x-y"]: async (q) => { "use cache"; return q; },\n  plain() { return 1; },\n};`,
    MOD,
  );
  assert(changed);
  await assertParses(code);
  assertStringIncludes(code, "get: _dnxUseCache(");
  const ids = [...code.matchAll(/_dnxUseCache\("([^"]+)"/g)].map((m) => m[1]);
  assertEquals(ids.length, 2, "the plain method stays a method");
  assertStringIncludes(ids[0], "#api.get");
  assert(ids[0] !== ids[1]);
});

Deno.test("B5: an inline `use cache` instance method is a build error (as in Next.js)", async () => {
  await assertRejects(
    () => transformUseCache(`export class A { async m() { "use cache"; return 1; } }`, MOD),
    Error,
    'It is not allowed to define inline "use cache" annotated class instance methods',
  );
});

Deno.test("B5: `this`, `super` and `arguments` are build errors in a cached function", async () => {
  for (
    const [src, expr] of [
      [`export const o = { async m() { "use cache"; return this.x; } };`, "this"],
      [
        `class B { static n() { return 1; } }\nexport class C extends B { static async m() { "use cache"; return super.n(); } }`,
        "super",
      ],
      [`export async function f() { "use cache"; return arguments.length; }`, "arguments"],
      [`export async function g() { "use cache"; const h = () => this; return h(); }`, "this"],
    ]
  ) {
    await assertRejects(
      () => transformUseCache(src, MOD),
      Error,
      `"use cache" functions cannot use \`${expr}\``,
    );
  }
  // A nested (non-arrow) function rebinds `this`/`arguments`: allowed, like Next.js.
  const { changed } = await transformUseCache(
    `export async function f() { "use cache"; return [1].map(function () { return arguments.length + (this ? 1 : 0); }); }`,
    MOD,
  );
  assert(changed);
});

Deno.test("B5: `__useCache` keys on bound (closed-over) values", async () => {
  setCacheStore(inMemoryCacheStore());
  let n = 0;
  let prefix = "a";
  const f = __useCache("m#bound", (k: string) => Promise.resolve(`${prefix}${k}${++n}`), {
    bound: () => [prefix],
  });
  const ctx = createRequestContext(new Request("http://x/"));
  await runWithContext(ctx, async () => {
    assertEquals(await f("k"), "ak1");
    assertEquals(await f("k"), "ak1", "same bound value: a hit");
    prefix = "b";
    assertEquals(await f("k"), "bk2", "a different bound value is a different entry");
  });
});

/** Transform `src` as `name.ts` in a temp dir, import it and hand the module to `run`. */
async function withTransformed<M>(
  name: string,
  src: string,
  run: (mod: M) => Promise<void>,
): Promise<void> {
  setCacheStore(inMemoryCacheStore());
  const dir = await Deno.makeTempDir();
  try {
    const url = toFileUrl(`${dir}/${name}.ts`).href;
    const { code, changed } = await transformUseCache(src, url);
    assert(changed);
    const outPath = `${dir}/${name}.transformed.ts`;
    await Deno.writeTextFile(outPath, code);
    await run(await import(toFileUrl(outPath).href) as M);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Run `fn` inside a fresh request context. */
function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  return runWithContext(createRequestContext(new Request("http://x/")), fn);
}

Deno.test("integration B5: static, object and factory methods cache across requests", async () => {
  type Mod = {
    Repo: { get(k: string): Promise<string> };
    api: { get(k: string): Promise<string> };
    make(p: string): { get(k: string): Promise<string> };
    calls(): number;
  };
  await withTransformed<Mod>(
    "methods",
    `let n = 0;\n` +
      `export class Repo { static async get(k: string) { "use cache"; n++; return "r" + k; } }\n` +
      `export const api = { async get(k: string) { "use cache"; n++; return "o" + k; } };\n` +
      `export function make(p: string) {\n` +
      `  return { async get(k: string) { "use cache"; n++; return p + k; } };\n` +
      `}\n` +
      `export function calls() { return n; }\n`,
    async (mod) => {
      assertEquals(await inRequest(() => mod.Repo.get("1")), "r1");
      assertEquals(await inRequest(() => mod.Repo.get("1")), "r1");
      assertEquals(mod.calls(), 1, "the static method's body ran once across requests");
      assertEquals(await inRequest(() => mod.api.get("1")), "o1");
      assertEquals(await inRequest(() => mod.api.get("1")), "o1");
      assertEquals(mod.calls(), 2, "the object method's body ran once across requests");
      assertEquals(await inRequest(() => mod.make("a").get("1")), "a1");
      assertEquals(await inRequest(() => mod.make("a").get("1")), "a1");
      assertEquals(mod.calls(), 3, "a fresh factory object with the same closure is a hit");
      assertEquals(await inRequest(() => mod.make("b").get("1")), "b1", "closure is in the key");
      assertEquals(mod.calls(), 4);
    },
  );
});

Deno.test("integration B5: a name-referenced default export caches both ways in", async () => {
  type Mod = {
    default(k: string): Promise<string>;
    viaName(k: string): Promise<string>;
    calls(): number;
  };
  await withTransformed<Mod>(
    "page",
    `let n = 0;\n` +
      `export default async function load(k: string) { "use cache"; n++; return "v" + k; }\n` +
      `export const viaName = (k: string) => load(k);\n` +
      `export function calls() { return n; }\n`,
    async (mod) => {
      assertEquals(await inRequest(() => mod.default("1")), "v1");
      assertEquals(await inRequest(() => mod.viaName("1")), "v1");
      assertEquals(mod.calls(), 1, "the default and the named reference share one entry");
    },
  );
});
