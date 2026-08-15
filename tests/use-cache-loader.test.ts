// Part B3: the server-side `use cache` loader — transitive transformation so a
// directive-free module that imports a cached helper still hits the cache.

import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { createUseCacheLoader } from "../src/build/use-cache-loader.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { inMemoryCacheStore, setCacheStore } from "../src/server/cache.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";

const base: ModuleLoader = (p) => import(p.startsWith("file:") ? p : toFileUrl(p).href);

Deno.test("B3: a directive-free module reaches its cached helper through the loader", async () => {
  setCacheStore(inMemoryCacheStore());
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "lib"));
    // The helper opts into caching; `count` observes how many times the body ran.
    await Deno.writeTextFile(
      join(dir, "lib", "data.ts"),
      `let calls = 0;\n` +
        `export async function getPosts() { "use cache"; calls++; return calls; }\n` +
        `export function count() { return calls; }\n`,
    );
    // The page has NO directive; it merely imports the cached helper.
    await Deno.writeTextFile(
      join(dir, "page.ts"),
      `import { count, getPosts } from "./lib/data.ts";\n` +
        `export async function render() { return await getPosts(); }\n` +
        `export { count };\n`,
    );

    const load = createUseCacheLoader(base, {
      projectDir: dir,
      cacheDir: join(dir, ".cache"),
    });
    const mod = await load(join(dir, "page.ts")) as {
      render: () => Promise<number>;
      count: () => number;
    };

    const r1 = await runWithContext(
      createRequestContext(new Request("http://x/1")),
      () => mod.render(),
    );
    const r2 = await runWithContext(
      createRequestContext(new Request("http://x/2")),
      () => mod.render(),
    );
    assertEquals(r1, 1, "first request computes");
    assertEquals(r2, 1, "second request is a cache hit");
    assertEquals(mod.count(), 1, "the cached body ran exactly once across requests");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("B3: a project with no `use cache` anywhere loads the original module", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "plain.ts"),
      `export const value = 42;\n`,
    );
    const cacheDir = join(dir, ".cache");
    const load = createUseCacheLoader(base, { projectDir: dir, cacheDir });
    const mod = await load(join(dir, "plain.ts")) as { value: number };
    assertEquals(mod.value, 42);
    // No transformed copies were materialized.
    assert(
      !(await Deno.stat(cacheDir).then(() => true).catch(() => false)),
      "no cache dir created when nothing is cached",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
