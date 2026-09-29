// `features` on the SPA's denext-native (`deno bundle`) path: the flags are seeded at the top of
// the entry and every app module calling `feature("KEY")` is folded and redirected through the
// import map (src/build/spa/features.ts).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { spaFeatureFold } from "../src/build/spa/features.ts";

Deno.test("spaFeatureFold: seeds the flags and folds app modules; skips vendored folders", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_spa_fold_test_" });
  try {
    const src =
      `import { feature } from "denext/feature";\nexport const on = feature("PROBE") ? 1 : 0;\n`;
    await Deno.mkdir(join(dir, "src"));
    await Deno.mkdir(join(dir, "node_modules/x"), { recursive: true });
    await Deno.writeTextFile(join(dir, "src/probe.ts"), src);
    await Deno.writeTextFile(join(dir, "src/plain.ts"), "export const x = 1;\n");
    await Deno.writeTextFile(join(dir, "node_modules/x/index.js"), src);
    const fold = await spaFeatureFold(dir, { PROBE: true });
    assertEquals(fold.seed, 'globalThis.__DENEXT_FEATURES__ = {"PROBE":true};\n');
    const keys = Object.keys(fold.importMap);
    assertEquals(keys, [toFileUrl(join(dir, "src/probe.ts")).href]);
    const folded = await Deno.readTextFile(fromFileUrl(fold.importMap[keys[0]]));
    assertStringIncludes(folded, "true ? 1 : 0");
    await fold.cleanup();
    assert(!(await Deno.stat(fromFileUrl(fold.importMap[keys[0]])).then(() => true, () => false)));

    const dev = await spaFeatureFold(dir, { PROBE: true }, false);
    assertEquals([dev.seed.length > 0, Object.keys(dev.importMap).length], [true, 0]);
    assertEquals((await spaFeatureFold(dir, {})).seed, "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
