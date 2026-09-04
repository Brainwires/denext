// Package-dir resolution for the compat bundler: `exports` maps per condition set, the
// legacy `module`/`main` fallbacks (browser prefers ESM, SSR prefers the Node build),
// subpaths, and a dir without a package.json.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  BROWSER_CONDITIONS,
  resolveInPackageDir,
  SSR_CONDITIONS,
} from "../src/build/next-compat.ts";

async function pkg(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir();
  for (const [name, text] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), text);
  }
  return dir;
}

Deno.test("resolveInPackageDir honors the exports map per condition set", async () => {
  const dir = await pkg({
    "package.json": JSON.stringify({
      exports: { ".": { browser: "./browser.js", node: "./node.js", default: "./index.js" } },
    }),
    "browser.js": "",
    "node.js": "",
    "index.js": "",
  });
  assertEquals(
    await resolveInPackageDir(dir, "", BROWSER_CONDITIONS),
    await Deno.realPath(join(dir, "browser.js")),
  );
  assertEquals(
    await resolveInPackageDir(dir, "", SSR_CONDITIONS),
    await Deno.realPath(join(dir, "node.js")),
  );
});

Deno.test("resolveInPackageDir: without exports the browser prefers module, SSR prefers main", async () => {
  const dir = await pkg({
    "package.json": JSON.stringify({ module: "./esm.mjs", main: "./cjs.cjs" }),
    "esm.mjs": "",
    "cjs.cjs": "",
  });
  assertEquals(
    await resolveInPackageDir(dir, "", BROWSER_CONDITIONS),
    await Deno.realPath(join(dir, "esm.mjs")),
  );
  assertEquals(
    await resolveInPackageDir(dir, "", SSR_CONDITIONS),
    await Deno.realPath(join(dir, "cjs.cjs")),
  );
});

Deno.test("resolveInPackageDir: a subpath probes extensions and index files; a missing file is null", async () => {
  const dir = await pkg({
    "package.json": JSON.stringify({ main: "index.js" }),
    "index.js": "",
    "util/index.ts": "",
  });
  assertEquals(
    await resolveInPackageDir(dir, "/util"),
    await Deno.realPath(join(dir, "util", "index.ts")),
  );
  assertEquals(await resolveInPackageDir(dir, "/nope"), null);
  assertEquals(await resolveInPackageDir(await Deno.makeTempDir(), ""), null, "no package.json");
});
