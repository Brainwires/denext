// firstPartyTsxPlugin (src/build/spa-onload.ts) transforms only the app's own source. esbuild
// hands `onLoad` a module's real path, so a project directory given through a symlink (macOS's
// `/var` → `/private/var` temp dirs, a linked checkout) used to look like "outside the project"
// and every module was skipped untransformed. The comparison is on real paths now.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import * as esbuild from "../src/build/esbuild/mod.ts";
import { firstPartyTsxPlugin } from "../src/build/spa-onload.ts";
import { SYMLINK_GATE } from "./helpers/symlink.ts";

async function bundleWith(projectDir: string, entry: string): Promise<string> {
  const plugin = firstPartyTsxPlugin(
    "test-mark",
    projectDir,
    (source) => source.replace("UNTOUCHED", "TRANSFORMED"),
  );
  try {
    const out = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      jsx: "automatic",
      plugins: [plugin],
    });
    return out.outputFiles[0].text;
  } finally {
    await esbuild.stop();
  }
}

Deno.test({
  name: SYMLINK_GATE.name(
    "firstPartyTsxPlugin: a project reached through a symlink is still first-party",
  ),
  ignore: SYMLINK_GATE.ignore,
}, async () => {
  const base = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_spa_onload_" }));
  try {
    const real = join(base, "real");
    await Deno.mkdir(real);
    await Deno.writeTextFile(join(real, "index.tsx"), 'export const mark = "UNTOUCHED";\n');
    const link = join(base, "link");
    await Deno.symlink(real, link);

    // The project root as a symlink, the entry through it (esbuild resolves it to `real`).
    assertEquals((await bundleWith(link, join(link, "index.tsx"))).includes("TRANSFORMED"), true);
    // The real root still works, and a sibling outside the project is still skipped.
    assertEquals((await bundleWith(real, join(real, "index.tsx"))).includes("TRANSFORMED"), true);
    const other = join(base, "other");
    await Deno.mkdir(other);
    assertEquals((await bundleWith(other, join(link, "index.tsx"))).includes("UNTOUCHED"), true);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("firstPartyTsxPlugin: a project root that can't be resolved compares as written", async () => {
  const base = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_spa_onload_" }));
  try {
    await Deno.writeTextFile(join(base, "index.tsx"), 'export const mark = "UNTOUCHED";\n');
    const out = await bundleWith(join(base, "missing"), join(base, "index.tsx"));
    assertEquals(out.includes("UNTOUCHED"), true);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
