// TanStack Router `autoCodeSplitting` on the esbuild SPA path (src/build/tanstack-code-split.ts,
// `spa.tanstackRouter`): over a copy of examples/tanstack-router, each route's component leaves
// the startup chunk for a chunk of its own, the entry shrinks, a route the splitter rewrites
// still gets denext's own source transforms, and the hook-filter matcher reads TanStack's
// filter shapes. `@tanstack/react-router` stays external (only the transform is under test; the
// full app runs in tests/e2e/tanstack-router.e2e.test.ts).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { basename, dirname, fromFileUrl, join, relative } from "@std/path";
import * as esbuild from "../src/build/esbuild/mod.ts";
import { filterAdmits, tanstackCodeSplitPlugin } from "../src/build/tanstack-code-split.ts";
import { generatorTmpDir } from "../src/build/tanstack-route-tree.ts";

const EXAMPLE = fromFileUrl(new URL("../examples/tanstack-router", import.meta.url));

/** A throwaway copy of the example's routes (the generator rewrites the route tree in place). */
async function fixture(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_tsr_split_" });
  await copy(join(EXAMPLE, "src"), join(dir, "src"));
  await copy(join(EXAMPLE, "tsr.config.json"), join(dir, "tsr.config.json"));
  return dir;
}

/** Bundle the fixture's entry; returns each output's text by file name. */
async function bundle(
  dir: string,
  plugins: esbuild.Plugin[],
  preserveSymlinks = false,
): Promise<Map<string, string>> {
  const result = await esbuild.build({
    preserveSymlinks,
    entryPoints: { index: join(dir, "src", "main.tsx") },
    outdir: join(dir, "out"),
    absWorkingDir: dir,
    bundle: true,
    splitting: true,
    format: "esm",
    minify: true,
    write: false,
    jsx: "automatic",
    external: ["@tanstack/react-router", "react", "react/jsx-runtime", "react-dom", "react-dom/*"],
    loader: { ".css": "empty" },
    plugins,
  });
  const out = new Map<string, string>();
  for (const f of result.outputFiles) out.set(basename(f.path), f.text);
  return out;
}

/** Text only the About route's component renders. */
const ABOUT_TEXT = "turns a Vite + TanStack Router app into exactly this shape";

Deno.test({
  name: "tanstack autoCodeSplitting: route components move to their own chunks; the entry shrinks",
}, async () => {
  const dir = await fixture();
  try {
    const plain = await bundle(dir, []);
    const split = await bundle(dir, [tanstackCodeSplitPlugin(dir, { autoCodeSplitting: true })]);
    // Unsplit: one output, the About component inside it.
    assertEquals([...plain.keys()], ["index.js"]);
    assertStringIncludes(plain.get("index.js")!, ABOUT_TEXT);
    // Split: the entry no longer holds the component; a lazily imported chunk does.
    const entry = split.get("index.js")!;
    assert(!entry.includes(ABOUT_TEXT), "the About component left the startup chunk");
    const chunks = [...split.entries()].filter(([name]) => name !== "index.js");
    assert(chunks.length >= 4, `one chunk per split route, got ${chunks.length}`);
    assert(chunks.some(([, text]) => text.includes(ABOUT_TEXT)), "a chunk holds About");
    assertStringIncludes(entry, "import(");
    assert(
      entry.length < plain.get("index.js")!.length,
      `entry ${entry.length} B < unsplit ${plain.get("index.js")!.length} B`,
    );
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "tanstack autoCodeSplitting: a rewritten route still gets denext's source transforms",
}, async () => {
  const dir = await fixture();
  try {
    const seen: string[] = [];
    const after = (source: string, path: string) => {
      seen.push(path);
      return Promise.resolve(source.replaceAll(ABOUT_TEXT, "TRANSFORMED"));
    };
    const out = await bundle(dir, [
      tanstackCodeSplitPlugin(dir, { autoCodeSplitting: true }, after),
    ]);
    const all = [...out.values()].join("\n");
    assert(!all.includes(ABOUT_TEXT), "the transform ran on the split About module");
    assertStringIncludes(all, "TRANSFORMED");
    assert(seen.some((p) => p.endsWith(join("routes", "about.tsx"))), "about.tsx was transformed");
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * Another name for `dir` that is not its real path: on Windows its 8.3 short name
 * (`C:\Users\LONGNA~1\…`, which esbuild keeps as given), elsewhere a symlink (which esbuild
 * keeps with `preserveSymlinks`). `null` on a Windows volume with 8.3 names turned off.
 */
async function aliasOf(dir: string, scratch: string): Promise<string | null> {
  const real = Deno.realPathSync(dir);
  if (Deno.build.os !== "windows") {
    const link = join(scratch, "alias");
    await Deno.symlink(real, link);
    return link;
  }
  // The path goes in through the environment: no command-line quoting to get wrong.
  const out = await new Deno.Command("powershell.exe", {
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:DENEXT_ALIAS_DIR).ShortPath",
    ],
    env: { DENEXT_ALIAS_DIR: real },
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).output();
  const short = new TextDecoder().decode(out.stdout).trim();
  return short && short.toLowerCase() !== real.toLowerCase() ? short : null;
}

Deno.test({
  name:
    "tanstack autoCodeSplitting: a project reached through another name for its path (Windows 8.3 short name, a symlink) is still split",
}, async () => {
  // The route generator keys its route map by the real path; esbuild reported each module by the
  // name it was reached through (an 8.3 short name on Windows), so no route matched and nothing
  // was split.
  const dir = await fixture();
  const scratch = await Deno.makeTempDir({ prefix: "denext_tsr_alias_" });
  try {
    // A long name, so Windows gives the directory a distinct 8.3 short name.
    const project = join(dir, "long-project-directory-name");
    await Deno.mkdir(project);
    for (const entry of ["src", "tsr.config.json"]) {
      await Deno.rename(join(dir, entry), join(project, entry));
    }
    const alias = await aliasOf(project, scratch);
    if (alias === null) {
      console.warn("8.3 short names are off on this volume: nothing to alias");
      return;
    }
    const split = await bundle(
      alias,
      [tanstackCodeSplitPlugin(alias, { autoCodeSplitting: true })],
      true,
    );
    const entry = split.get("index.js")!;
    assert(!entry.includes(ABOUT_TEXT), "the About component left the startup chunk");
    assert(split.size >= 5, `one chunk per split route, got ${split.size - 1}`);
  } finally {
    await esbuild.stop();
    await Deno.remove(scratch, { recursive: true });
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name:
    "tanstack autoCodeSplitting: explicit routesDirectory / generatedRouteTree; a module outside the project is left alone",
}, async () => {
  const dir = await fixture();
  const outside = await Deno.makeTempDir({ prefix: "denext_tsr_outside_" });
  try {
    // A module outside the project, imported by the entry: not the app's source, never split.
    const shared = join(outside, "shared.ts");
    await Deno.writeTextFile(shared, `export const SHARED = "outside-the-project";\n`);
    const main = join(dir, "src", "main.tsx");
    await Deno.writeTextFile(
      main,
      `import { SHARED } from ${
        JSON.stringify(relative(dirname(main), shared).replaceAll("\\", "/"))
      };\n` +
        `console.log(SHARED);\n` + await Deno.readTextFile(main),
    );
    // Route files in .ts and .jsx too: each is answered with the loader its extension needs.
    const routes = join(dir, "src", "routes");
    await Deno.writeTextFile(
      join(routes, "plain.ts"),
      `import { createFileRoute } from "@tanstack/react-router";\n` +
        `export const Route = createFileRoute("/plain")({ component: () => "plain-ts-route" });\n`,
    );
    await Deno.writeTextFile(
      join(routes, "legacy.jsx"),
      `import { createFileRoute } from "@tanstack/react-router";\n` +
        `export const Route = createFileRoute("/legacy")({ component: () => <p>legacy-jsx-route</p> });\n`,
    );
    const seen: string[] = [];
    const after = (_source: string, path: string) => (seen.push(path), Promise.resolve(null));
    const split = await bundle(dir, [
      tanstackCodeSplitPlugin(dir, {
        autoCodeSplitting: true,
        routesDirectory: "./src/routes",
        generatedRouteTree: "./src/routeTree.gen.ts",
      }, after),
    ]);
    assert(!split.get("index.js")!.includes(ABOUT_TEXT), "routes were still split");
    assertStringIncludes(split.get("index.js")!, "outside-the-project");
    const all = [...split.values()].join("\n");
    assertStringIncludes(all, "plain-ts-route");
    assertStringIncludes(all, "legacy-jsx-route");
    assert(!seen.some((p) => p.endsWith("shared.ts")), "the outside module was not answered here");
  } finally {
    await esbuild.stop();
    await Deno.remove(outside, { recursive: true });
    await Deno.remove(dir, { recursive: true });
  }
});

// A project's tracked `routeTree.gen.ts`, written by the app's OWN generator (its own
// `@tanstack/router-plugin` version and settings), must survive a denext build byte for byte when
// the route set is unchanged. denext's pinned generator orders imports and routes differently
// from older versions (T3 Code: every build flipped the order), and a Vite config's inline
// `quoteStyle` / `semicolons` never reach it, so a regenerated tree that holds the same
// statements is put back exactly as committed.

/** The fixture's tree in another generator's dress: imports reversed, double quotes, semicolons. */
function restyled(tree: string): string {
  const lines = tree.split("\n");
  const imports = lines.filter((l) => l.startsWith("import { Route as"));
  let k = imports.length;
  return lines.map((l) => l.startsWith("import { Route as") ? imports[--k] : l)
    .map((l) => l.startsWith("import ") ? l.replaceAll("'", '"') + ";" : l)
    .join("\n");
}

/** Run the plugin's setup (the generator runs there) without bundling anything. */
async function generate(dir: string): Promise<void> {
  try {
    await esbuild.build({
      stdin: { contents: "", loader: "js" },
      write: false,
      logLevel: "silent",
      plugins: [tanstackCodeSplitPlugin(dir, { autoCodeSplitting: true })],
    });
  } finally {
    await esbuild.stop();
  }
}

Deno.test({
  name: "tanstack route tree: a committed tree with the same routes stays byte-identical",
}, async () => {
  const dir = await fixture();
  const tree = join(dir, "src", "routeTree.gen.ts");
  try {
    await generate(dir);
    const committed = restyled(await Deno.readTextFile(tree));
    await Deno.writeTextFile(tree, committed);
    await generate(dir);
    assertEquals(await Deno.readTextFile(tree), committed, "the build rewrote the committed tree");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "tanstack route tree: a real route change is still written",
}, async () => {
  const dir = await fixture();
  const tree = join(dir, "src", "routeTree.gen.ts");
  try {
    await generate(dir);
    await Deno.writeTextFile(tree, restyled(await Deno.readTextFile(tree)));
    await Deno.writeTextFile(
      join(dir, "src", "routes", "contact.tsx"),
      `import { createFileRoute } from "@tanstack/react-router";\n` +
        `export const Route = createFileRoute("/contact")({ component: () => null });\n`,
    );
    await generate(dir);
    assertStringIncludes(await Deno.readTextFile(tree), "ContactRouteImport");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name:
    "tanstack route tree: the generator's scratch files stay in the project, not the working directory",
}, async () => {
  // The generator renames each file from its scratch directory into place; resolved against the
  // working directory (another file system: a /tmp tmpfs) that rename failed with EXDEV.
  const dir = await fixture();
  try {
    // A new route: the generator writes the tree (an unchanged one is left alone).
    await Deno.writeTextFile(
      join(dir, "src", "routes", "contact.tsx"),
      `import { createFileRoute } from "@tanstack/react-router";\n` +
        `export const Route = createFileRoute("/contact")({ component: () => null });\n`,
    );
    await generate(dir);
    const scratch = await Deno.stat(join(Deno.realPathSync(dir), ".tanstack", "tmp"));
    assert(scratch.isDirectory, "the generator's tmpDir is under the project");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tanstack generatorTmpDir: the project's .tanstack/tmp unless tsr.config.json or TSR_TMP_DIR names one", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_tsr_tmp_" });
  const saved = Deno.env.get("TSR_TMP_DIR");
  try {
    Deno.env.delete("TSR_TMP_DIR");
    assertEquals(await generatorTmpDir(dir), join(dir, ".tanstack", "tmp"));
    Deno.env.set("TSR_TMP_DIR", "/elsewhere");
    assertEquals(await generatorTmpDir(dir), undefined);
    Deno.env.delete("TSR_TMP_DIR");
    await Deno.writeTextFile(join(dir, "tsr.config.json"), JSON.stringify({ tmpDir: "scratch" }));
    assertEquals(await generatorTmpDir(dir), undefined);
  } finally {
    if (saved === undefined) Deno.env.delete("TSR_TMP_DIR");
    else Deno.env.set("TSR_TMP_DIR", saved);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tanstack hook filters: include / exclude / bare patterns, substring strings", () => {
  const filter = { include: /\.tsx$/, exclude: ["tsr-split", "tsr-shared"] };
  assert(filterAdmits(filter, "/app/src/routes/about.tsx"));
  assert(!filterAdmits(filter, "/app/src/routes/about.tsx?tsr-split=component"));
  assert(!filterAdmits(filter, "/app/src/routes/about.ts"));
  assert(filterAdmits(/tsr-split/, "/a.tsx?tsr-split=component"));
  assert(!filterAdmits(/tsr-split/, "/a.tsx"));
  assert(filterAdmits([/createFileRoute\s*\(/, /createRootRoute\s*\(/], "createRootRoute()"));
  assert(filterAdmits(undefined, "anything"));
  // A global RegExp's lastIndex never leaks between calls.
  const g = /x/g;
  assert(filterAdmits(g, "x"));
  assert(filterAdmits(g, "x"));
});

// Audit 3.4.0 N5: `@tanstack/router-plugin` is npm code denext runs at build time, so a new
// release must never reach a build unreviewed: the import map pins one exact version, the one
// the lock resolves.
Deno.test("@tanstack/router-plugin is pinned to one exact version", async () => {
  const root = new URL("../", import.meta.url);
  const deno = JSON.parse(await Deno.readTextFile(new URL("deno.json", root)));
  const spec: string = deno.imports["@tanstack/router-plugin"];
  const m = /^npm:@tanstack\/router-plugin@(\d+\.\d+\.\d+)$/.exec(spec);
  assert(m, `an exact version, not a range: ${spec}`);
  const lock = JSON.parse(await Deno.readTextFile(new URL("deno.lock", root)));
  assertEquals(String(lock.specifiers[spec]).split("_")[0], m[1]);
});
