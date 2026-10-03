// Unbundled dev, compat mode: the npm dependency bundle is built from a crawl of the app's
// import graph, not from whatever module requests happened to arrive first. It used to rebuild
// (and reload the page) each time a request found a few more packages: T3 Code's graph found
// them a handful at a time and the page reloaded every few seconds without ever rendering.

import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import * as esbuild from "esbuild";
import { createUnbundledState, depSlug } from "../src/build/dev-unbundled/state.ts";
import { ensureNpmBundle, prewarmNpmBundle } from "../src/build/dev-unbundled/deps.ts";

const pkg = (name: string) => ({
  [`node_modules/${name}/package.json`]: JSON.stringify({ name, main: "index.js" }),
  [`node_modules/${name}/index.js`]: `export const name = ${JSON.stringify(name)};`,
});

const FILES: Record<string, string> = {
  "deno.json": "{}",
  ...pkg("pkg-a"),
  ...pkg("pkg-b"),
  ...pkg("pkg-c"),
  ...pkg("pkg-d"),
  ...pkg("pkg-late"),
  "src/main.ts":
    'import { name } from "pkg-a";\nimport { b } from "./one/b.ts";\nexport const all = [name, b];',
  "src/one/b.ts":
    'import { name } from "pkg-b";\nimport { c } from "../two/c.ts";\nexport const b = [name, c];',
  "src/two/c.ts":
    'import { name } from "pkg-c";\nexport const c = [name, () => import("./lazy.ts")];',
  "src/two/lazy.ts": 'import { name } from "pkg-d";\nexport const lazy = name;',
};

async function project() {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-npm-prewarm-" }));
  for (const [rel, text] of Object.entries(FILES)) {
    await Deno.mkdir(dirname(join(dir, rel)), { recursive: true });
    await Deno.writeTextFile(join(dir, rel), text);
  }
  let reloads = 0;
  const st = createUnbundledState({
    projectDir: dir,
    appDir: join(dir, "src"),
    configPath: join(dir, "deno.json"),
    outDir: join(dir, "out"),
    compat: true,
    spaEntry: join(dir, "src/main.ts"),
    onDepsRebuilt: () => reloads++,
  });
  return { dir, st, reloads: () => reloads };
}

Deno.test("compat dev: the graph crawl puts every package at depth in ONE npm build, no reload", async () => {
  const { dir, st, reloads } = await project();
  try {
    prewarmNpmBundle(st, [join(dir, "src/main.ts")]);
    // The page's first npm request arrives while the crawl is still running.
    await ensureNpmBundle(st);
    assertEquals(st.npmBuilds, 1);
    for (const spec of ["pkg-a", "pkg-b", "pkg-c", "pkg-d"]) {
      assert(st.npmBuilt.has(spec), `${spec} in the first build`);
      Deno.statSync(join(st.npmDir, `${depSlug(spec)}.js`));
    }
    // Every later request of the page finds the bundle current.
    await Promise.all([ensureNpmBundle(st), ensureNpmBundle(st)]);
    assertEquals(st.npmBuilds, 1);
    assertEquals(reloads(), 0);
    // An entry already crawled is not crawled again.
    prewarmNpmBundle(st, [join(dir, "src/main.ts")]);
    assertEquals(st.npmCrawl, null);
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("compat dev: packages found after the page loaded rebuild once and reload once", async () => {
  const { dir, st, reloads } = await project();
  try {
    prewarmNpmBundle(st, [join(dir, "src/main.ts")]);
    await ensureNpmBundle(st);
    assertEquals(st.npmBuilds, 1);
    // A lazily loaded module finds a new package, then another arrives mid-burst.
    st.npmSpecs.add("pkg-late");
    const first = ensureNpmBundle(st);
    const second = ensureNpmBundle(st);
    st.npmSpecs.add(join(dir, "node_modules/pkg-a/index.js"));
    await Promise.all([first, second, ensureNpmBundle(st)]);
    assert(st.npmBuilt.has("pkg-late"));
    assertEquals(st.npmBuilds, 2, "one coalesced rebuild");
    assertEquals(reloads(), 1, "one reload");
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
