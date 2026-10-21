// The production server's module loader answers a path it has loaded with the same promise: a
// request's page and layouts are asked for on every request, and each ask used to resolve the
// path to a URL and go through `import()` again.

import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { memoizeLoader } from "../src/server/default-loader.ts";
import { prodLoader } from "../src/build/prod-server/app.ts";
import type { BuildInfo } from "../src/build/prod-server/manifest.ts";
import type { ProjectPaths } from "../src/build/paths.ts";

Deno.test("memoizeLoader loads each path once and shares the promise", async () => {
  const calls: string[] = [];
  const load = memoizeLoader((path) => {
    calls.push(path);
    return Promise.resolve({ path });
  });
  const first = load("/app/page.tsx");
  assertStrictEquals(load("/app/page.tsx"), first);
  assertEquals(await first, { path: "/app/page.tsx" });
  for (let i = 0; i < 100; i++) await load(i % 2 ? "/app/page.tsx" : "/app/layout.tsx");
  assertEquals(calls, ["/app/page.tsx", "/app/layout.tsx"]);
});

Deno.test("memoizeLoader forgets a failed load, so the next call retries it", async () => {
  let attempt = 0;
  const load = memoizeLoader(() => {
    attempt++;
    return attempt === 1 ? Promise.reject(new Error("syntax error")) : Promise.resolve("ok");
  });
  await assertRejects(() => load("/app/broken.tsx"), Error, "syntax error");
  await Promise.resolve(); // the memo drops the failed load in its own rejection handler
  assertEquals(await load("/app/broken.tsx"), "ok");
  assertEquals(await load("/app/broken.tsx"), "ok");
  assertEquals(attempt, 2);
});

Deno.test("prodLoader's loader is memoized: the same module path is one load", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-prod-loader-" });
  try {
    const file = join(dir, "page.ts");
    await Deno.writeTextFile(file, "export const answer = 42;\n");
    const paths = { projectDir: dir, outDir: join(dir, ".denext") } as ProjectPaths;
    const info = {
      nextCompat: false,
      compatModuleMap: new Map(),
      // Copies recorded for this project, with nothing to redirect: the plain module loader.
      serverCopies: { root: toFileUrl(dir).href, redirects: {}, copies: {}, relocatable: true },
    } as unknown as BuildInfo;
    const load = await prodLoader(paths, info);
    const first = load(file);
    assertStrictEquals(load(file), first, "a second ask reuses the first load");
    const mod = await first as { answer: number };
    assertEquals(mod.answer, 42);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
