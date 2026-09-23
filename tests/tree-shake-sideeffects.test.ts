// Item 2 (Bun-1.4 borrow): the node_modules resolver marks modules of a
// `"sideEffects": false` package so esbuild tree-shakes unused barrel re-exports. Without
// the mark, denext's own resolver hands esbuild a bare `{ path }` and it must keep them.
// A real esbuild bundle over a temp package proves the flag is causal.

import { assert } from "@std/assert";
import { join } from "@std/path";
import * as esbuild from "esbuild";
import { appResolverPlugin, catalogResolverPlugin } from "../src/build/next-compat.ts";

/** Scaffold a temp barrel package `mypkg` (index re-exports a.js + b.js). */
async function scaffold(sideEffects: boolean | undefined): Promise<{ dir: string; entry: string }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_treeshake_" });
  const pkgDir = join(dir, "node_modules", "mypkg");
  await Deno.mkdir(pkgDir, { recursive: true });
  const pkgJson: Record<string, unknown> = { name: "mypkg", module: "index.js" };
  if (sideEffects !== undefined) pkgJson.sideEffects = sideEffects;
  await Deno.writeTextFile(join(pkgDir, "package.json"), JSON.stringify(pkgJson));
  await Deno.writeTextFile(
    join(pkgDir, "index.js"),
    `export * from "./a.js";\nexport * from "./b.js";\n`,
  );
  await Deno.writeTextFile(join(pkgDir, "a.js"), `export const A = "USED_A_MARKER";\n`);
  // b.js carries a TOP-LEVEL side effect: esbuild keeps it unless the package is declared
  // side-effect-free, which is exactly what the resolver mark toggles.
  await Deno.writeTextFile(
    join(pkgDir, "b.js"),
    `export const B = "UNUSED_B_MARKER";\nglobalThis.__mypkg = "SIDE_EFFECT_RAN";\n`,
  );
  await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
  const entry = join(dir, "entry.js");
  await Deno.writeTextFile(entry, `import { A } from "mypkg";\nconsole.log(A);\n`);
  return { dir, entry };
}

async function bundleOnce(sideEffects: boolean | undefined): Promise<string> {
  const { dir, entry } = await scaffold(sideEffects);
  try {
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      treeShaking: true,
      logLevel: "silent",
      plugins: [catalogResolverPlugin(dir, "all")],
    });
    return new TextDecoder().decode(result.outputFiles![0].contents);
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("sideEffects:false drops the unused barrel re-export + its side effect", async () => {
  const out = await bundleOnce(false);
  assert(out.includes("USED_A_MARKER"), "the imported export must be kept");
  assert(!out.includes("UNUSED_B_MARKER"), "the unused barrel export must be tree-shaken");
  assert(!out.includes("SIDE_EFFECT_RAN"), "its top-level side effect must go too");
});

Deno.test("no sideEffects field keeps the side-effectful unused module (mark is causal)", async () => {
  const out = await bundleOnce(undefined);
  assert(out.includes("USED_A_MARKER"), "the imported export must be kept");
  assert(
    out.includes("SIDE_EFFECT_RAN"),
    "without the mark, the side-effectful module is retained",
  );
});

/**
 * What the compat resolver chain answers for `./b.js` imported from mypkg's barrel: esbuild's
 * own `build.resolve` runs the plugins, and its result carries the `sideEffects` flag the
 * claiming plugin set (so this observes the resolver directly, not a bundling heuristic).
 */
async function resolveRelativeInPackage(sideEffects: boolean | undefined): Promise<boolean> {
  const { dir, entry } = await scaffold(sideEffects);
  const pkgDir = join(dir, "node_modules", "mypkg");
  let seen: boolean | undefined;
  const probe: esbuild.Plugin = {
    name: "probe",
    setup(build) {
      build.onResolve({ filter: /^probe$/ }, async () => {
        const r = await build.resolve("./b.js", {
          importer: join(pkgDir, "index.js"),
          resolveDir: pkgDir,
          kind: "import-statement",
        });
        seen = r.sideEffects;
        return { path: "probe", namespace: "probe" };
      });
      build.onLoad({ filter: /.*/, namespace: "probe" }, () => ({ contents: "", loader: "js" }));
    },
  };
  try {
    await Deno.writeTextFile(entry, `import "probe";\n`);
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      logLevel: "silent",
      plugins: [
        probe,
        appResolverPlugin(join(dir, "deno.json")),
        catalogResolverPlugin(dir, "all"),
      ],
    });
    return seen!;
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("the app resolver marks a sideEffects:false package's relative imports", async () => {
  // appResolverPlugin claims the barrel's own `./b.js`; it must mark it like the node_modules
  // resolver marks the package entry, or esbuild must assume the module has side effects.
  assert((await resolveRelativeInPackage(false)) === false, "expected sideEffects: false");
});

Deno.test("the app resolver leaves a package without the declaration side-effectful", async () => {
  assert((await resolveRelativeInPackage(undefined)) === true, "expected sideEffects: true");
});
