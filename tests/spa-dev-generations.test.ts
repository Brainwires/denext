// The SPA dev server's bundled loop keeps the generation before the current one: a page loaded
// just before a rebuild (a source edit, or a watch event that arrives late) still asks for its own
// chunks, which esbuild names by content, so the new build may not have them.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { serveFromGenerations } from "../src/build/spa/dev-handler.ts";
import { pruneGenerations } from "../src/build/spa/dev-state.ts";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "denext_spa_gens_" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("serveFromGenerations: the current build first, then the one before it", async () => {
  await withDir(async (root) => {
    const current = join(root, "2");
    const previous = join(root, "1");
    await Deno.mkdir(current);
    await Deno.mkdir(previous);
    await Deno.writeTextFile(join(current, "index.js"), "current entry");
    await Deno.writeTextFile(join(previous, "index.js"), "previous entry");
    await Deno.writeTextFile(join(previous, "chunk-OLD.js"), "old chunk");
    // In both: the current one's.
    assertEquals(
      await (await serveFromGenerations([current, previous], "/index.js"))!.text(),
      "current entry",
    );
    // Only in the previous build (the rebuild renamed it): still served.
    assertEquals(
      await (await serveFromGenerations([current, previous], "/chunk-OLD.js"))!.text(),
      "old chunk",
    );
    // No previous build yet, or a file neither has.
    assertEquals(await serveFromGenerations([current, null], "/chunk-OLD.js"), null);
    assertEquals(await serveFromGenerations([current, previous], "/chunk-NONE.js"), null);
  });
});

Deno.test("pruneGenerations: keeps the named generations of its target and every other target's", async () => {
  await withDir(async (root) => {
    for (const name of ["1", "2", "3", "2-ios", "3-ios", "3-macos"]) {
      await Deno.mkdir(join(root, name));
    }
    await pruneGenerations(root, ["3", "2"], "web");
    const names = () => [...Deno.readDirSync(root)].map((e) => e.name).sort();
    assertEquals(names(), ["2", "2-ios", "3", "3-ios", "3-macos"]);
    await pruneGenerations(root, ["3-ios"], "ios");
    assertEquals(names(), ["2", "3", "3-ios", "3-macos"]);
  });
});
