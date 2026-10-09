// A native App Router client bundle carries ONE copy of denext's runtime whichever copy of denext
// the app's own `denext` import names. The build imports the running framework by URL (the
// generated entries' `denext/client-runtime`, the auto-memo compiler's `compiler-runtime`); an
// app mapped to another copy (here: the same checkout through a symlink, or a copy of it — a
// second worktree, a vendored denext) bundled that copy's hooks and reconciler next to the running
// framework's. prepareConfig now folds the app's copy into the running framework
// (src/build/app-framework-root.ts). Unbundled dev serves every `denext` specifier from the running
// framework already; the last test pins that.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { copy } from "@std/fs";
import { staticExport } from "../src/build/export.ts";
import { resolveFirstParty, rewriteSpecifier } from "../src/build/dev-unbundled/resolve.ts";
import {
  createUnbundledState,
  DEP_PREFIX,
  depSlug,
  type TransformEntry,
} from "../src/build/dev-unbundled/state.ts";

const FRAMEWORK = fromFileUrl(new URL("../", import.meta.url));

/** The hook dispatcher's own error text: one per copy of denext's hooks in a bundle. */
const DISPATCHER = "no dispatcher installed";

/** Occurrences of `needle` in `hay`. */
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

/** A second root URL for this checkout: a symlink to it, or (no symlinks) a copy of its sources. */
async function secondRoot(dir: string): Promise<string> {
  const link = join(dir, "denext");
  try {
    await Deno.symlink(FRAMEWORK, link, { type: "dir" });
  } catch {
    await Deno.mkdir(link);
    for (const name of ["src", "mod.ts", "deno.json"]) {
      await copy(join(FRAMEWORK, name), join(link, name));
    }
  }
  return toFileUrl(link).href + "/";
}

/** A native App Router app (auto-memo on) whose `denext` names `root`, with a hook island. */
async function project(dir: string, root: string): Promise<void> {
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": `${root}mod.ts`,
        "denext/jsx-runtime": `${root}src/jsx/jsx-runtime.ts`,
        "denext/server": `${root}src/server/mod.ts`,
        "denext/client": `${root}src/client/mod.ts`,
      },
    }),
  );
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    "export default { reactCompiler: true };\n",
  );
  const app = join(dir, "app");
  await Deno.mkdir(app);
  await Deno.writeTextFile(
    join(app, "counter.tsx"),
    `"use client";\nimport { useState } from "denext";\n` +
      `export function Counter() {\n  const [n, setN] = useState(0);\n` +
      `  return <button type="button" onClick={() => setN(n + 1)}>COUNTER_ISLAND {n}</button>;\n}\n`,
  );
  await Deno.writeTextFile(
    join(app, "page.tsx"),
    `import { Counter } from "./counter.tsx";\n` +
      `export default function Page() { return <main><Counter /></main>; }\n`,
  );
}

/** Every client `.js` file of an export, concatenated. */
async function clientJs(outDir: string): Promise<string> {
  const client = join(outDir, "_denext", "client");
  let js = "";
  for await (const e of Deno.readDir(client)) {
    if (e.isFile && e.name.endsWith(".js")) js += await Deno.readTextFile(join(client, e.name));
  }
  return js;
}

for (const which of ["this checkout", "another copy of denext"] as const) {
  Deno.test(`native export, app's denext is ${which}: one copy of the runtime`, async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_native_instance_" });
    try {
      const root = which === "this checkout"
        ? toFileUrl(FRAMEWORK).href.replace(/\/?$/, "/")
        : await secondRoot(dir);
      const appDir = join(dir, "app-project");
      await Deno.mkdir(appDir);
      await project(appDir, root);
      const { outDir } = await staticExport(appDir);
      assertStringIncludes(await Deno.readTextFile(join(outDir, "index.html")), "COUNTER_ISLAND");
      const js = await clientJs(outDir);
      assertStringIncludes(js, "COUNTER_ISLAND");
      assertEquals(count(js, DISPATCHER), 1, "exactly one copy of denext's hooks");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test("unbundled dev: an app's denext on another copy is served from the running framework", async () => {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "denext_native_instance_dev_" }),
  );
  try {
    const root = await secondRoot(dir);
    const appDir = join(dir, "app-project");
    await Deno.mkdir(appDir);
    await project(appDir, root);
    const st = createUnbundledState({
      projectDir: appDir,
      appDir: join(appDir, "app"),
      configPath: join(appDir, "deno.json"),
      outDir: join(appDir, ".denext"),
    });
    const page = join(appDir, "app", "page.tsx");
    const entry = { deps: [] } as unknown as TransformEntry;
    // None is a first-party (`@fs`) module: each is the running framework's prebuilt dependency.
    for (const spec of ["denext", "denext/client", "denext/jsx-runtime", "denext/server"]) {
      assertEquals(await resolveFirstParty(st, spec, page), null, spec);
      assertEquals(rewriteSpecifier(st, spec, null, entry), `${DEP_PREFIX}${depSlug(spec)}.js`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
