// Additional branch coverage for src/build/module-config.ts: trailing-slash
// preservation in absolutized imports, the stale-lock steal path in
// acquireFwdepsInstall, and the nodeModulesDir false/auto passthrough branches
// in mergeModuleConfig. (The pure/merge basics live in module-config.test.ts.)

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  acquireFwdepsInstall,
  mergeModuleConfig,
  readImportsAbsolute,
} from "../src/build/module-config.ts";

Deno.test("readImportsAbsolute: preserves a trailing slash on a prefix mapping", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: {
          "denext/": "../src/", // prefix mapping — must keep its trailing slash
          "denext": "../mod.ts", // plain file — no trailing slash
        },
      }),
    );
    const map = await readImportsAbsolute(join(dir, "deno.json"));
    assert(map["denext/"].startsWith("file://"), "prefix value absolutized");
    assert(map["denext/"].endsWith("/"), "trailing slash preserved on prefix mapping");
    assert(map["denext"].endsWith("/mod.ts"), "plain file has no spurious slash");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("acquireFwdepsInstall: steals a stale lock (crashed holder) and acquires", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_stale_" });
  const lock = join(dir, ".install.lock");
  try {
    // A pre-existing lock whose mtime is well past the 120s stale timeout — as if a
    // prior holder crashed mid-install. Not cached, so the caller must acquire.
    (await Deno.open(lock, { createNew: true, write: true })).close();
    const oldTime = new Date(Date.now() - 200_000);
    await Deno.utime(lock, oldTime, oldTime);

    // isCached is always false → the loop can't skip; it must steal the stale lock
    // and re-acquire it (returning true).
    assertEquals(await acquireFwdepsInstall(lock, () => Promise.resolve(false)), true);
    assert(await Deno.stat(lock).then(() => true, () => false), "lock re-acquired after steal");

    await Deno.remove(lock).catch(() => {});
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mergeModuleConfig: nodeModulesDir false is dropped, 'auto' is carried", () => {
  assertEquals(
    mergeModuleConfig({}, {}, { nodeModulesDir: false as unknown }).nodeModulesDir,
    undefined,
  );
  assertEquals(
    mergeModuleConfig({}, {}, { nodeModulesDir: "auto" }).nodeModulesDir,
    "auto",
  );
});
