// The per-process cache behind `prebuildDenextRuntime`: one build per distinct runtime, written
// wherever a later prebuild wants it — and a rebuild whenever any input changes: an option-level
// one (framework root, import map, dependency-age policy, classComponents, the denext patch) or
// a local source file the build read.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import {
  __runtimeBuildsForTests,
  cachedRuntime,
  inputsUnchanged,
  type PrebuiltRuntime,
  type RuntimeCacheInputs,
  runtimeCacheKey,
  stampInputs,
} from "../src/build/runtime-prebuild-cache.ts";
import { prebuildDenextRuntime, withEsbuild } from "../src/build/next-compat.ts";
import type { DenextPatchSet } from "../src/build/patches.ts";

const BASE: RuntimeCacheInputs = {
  rootUrl: "file:///fw/",
  classComponents: false,
  imports: { "@std/path": "jsr:@std/path@1", "denext": "file:///fw/mod.ts" },
  depAge: undefined,
  patch: null,
};

const patchOf = (line: string): DenextPatchSet =>
  new Map([["src/a.ts", {
    oldPath: "denext/src/a.ts",
    newPath: "denext/src/a.ts",
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`+${line}`] }],
  }]]) as unknown as DenextPatchSet;

Deno.test("the key changes with every option-level input, and only with them", () => {
  const key = runtimeCacheKey(BASE);
  const reordered = runtimeCacheKey({
    ...BASE,
    imports: { "denext": "file:///fw/mod.ts", "@std/path": "jsr:@std/path@1" },
  });
  assertEquals(reordered, key, "the import map's order is not an input");
  const variants: Record<string, Partial<RuntimeCacheInputs>> = {
    "framework root": { rootUrl: "https://jsr.io/@denext/denext/4.0.1/" },
    "classComponents": { classComponents: true },
    "an import map entry": { imports: { ...BASE.imports, "@std/path": "jsr:@std/path@2" } },
    "a new import map entry": { imports: { ...BASE.imports, "x": "npm:x@1" } },
    "the dependency-age policy": { depAge: { minimumDependencyAge: "P2D" } },
    "a denext patch": { patch: patchOf("a") },
  };
  const seen = new Set([key]);
  for (const [what, change] of Object.entries(variants)) {
    const changed = runtimeCacheKey({ ...BASE, ...change });
    assert(!seen.has(changed), `${what}: the key did not change`);
    seen.add(changed);
  }
  assertNotEquals(
    runtimeCacheKey({ ...BASE, patch: patchOf("a") }),
    runtimeCacheKey({ ...BASE, patch: patchOf("b") }),
    "the patch's content, not only its presence",
  );
});

Deno.test("a local input's stamp changes with its content, its mtime, or its removal", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_runtime_cache_" });
  try {
    const file = join(dir, "a.ts");
    await Deno.writeTextFile(file, "export const a = 1;\n");
    const inputs = ["a.ts", `file://${file}`, "https://jsr.io/@std/path/1.1.6/mod.ts"];
    const stamps = await stampInputs(inputs, dir);
    assertEquals([...stamps.keys()], [file], "local inputs only, relative or file:, deduped");
    assert(await inputsUnchanged(stamps), "nothing changed yet");
    await Deno.writeTextFile(file, "export const a = 22;\n");
    assert(!(await inputsUnchanged(stamps)), "an edit is a change");
    const edited = await stampInputs(["a.ts"], dir);
    await Deno.utime(file, new Date(), new Date(Date.now() + 60_000));
    assert(!(await inputsUnchanged(edited)), "a touch alone is a change");
    await Deno.remove(file);
    assert(!(await inputsUnchanged(edited)), "a removal is a change");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cachedRuntime: one build per key, shared by concurrent callers, rebuilt when stale or failed", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_runtime_cache_" });
  try {
    const input = join(dir, "in.ts");
    await Deno.writeTextFile(input, "1");
    let built = 0;
    const build = async (): Promise<PrebuiltRuntime> => {
      built++;
      return {
        files: [{ path: "x.js", contents: new TextEncoder().encode(String(built)) }],
        stamps: await stampInputs([input], dir),
      };
    };
    const key = `test-${crypto.randomUUID()}`;
    const [a, b] = await Promise.all([cachedRuntime(key, build), cachedRuntime(key, build)]);
    assertEquals(built, 1, "concurrent callers share one build");
    assert(a === b);
    assert(await cachedRuntime(key, build) === a, "a later caller gets it too");
    assertEquals(built, 1);
    await Deno.writeTextFile(input, "22");
    const rebuilt = await cachedRuntime(key, build);
    assertEquals(built, 2, "a changed input rebuilds");
    assert(rebuilt !== a);
    const failKey = `test-${crypto.randomUUID()}`;
    let attempts = 0;
    const flaky = () => (++attempts === 1 ? Promise.reject(new Error("boom")) : build());
    await cachedRuntime(failKey, flaky).catch(() => {});
    await cachedRuntime(failKey, flaky);
    assertEquals(attempts, 2, "a failed build is not remembered");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Every file under `dir`, relative path → content. */
async function tree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (rel: string) => {
    for await (const e of Deno.readDir(join(dir, rel))) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) await walk(path);
      else out.set(path, await Deno.readTextFile(join(dir, path)));
    }
  };
  await walk("");
  return out;
}

Deno.test("prebuildDenextRuntime: built once per process, rebuilt for another option or an edited source", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_runtime_cache_" });
  // An input of every runtime build: the framework's own `denext/result` entry.
  const source = new URL("../src/result.ts", import.meta.url);
  const original = await Deno.stat(source);
  try {
    await withEsbuild(async () => {
      const start = __runtimeBuildsForTests();
      await prebuildDenextRuntime({ outDir: join(dir, "a"), classComponents: true });
      assertEquals(__runtimeBuildsForTests() - start, 1, "the first prebuild builds");
      await prebuildDenextRuntime({ outDir: join(dir, "b"), classComponents: true });
      assertEquals(__runtimeBuildsForTests() - start, 1, "the same runtime is not built again");
      const first = await tree(join(dir, "a"));
      assert(first.size > 0, "the runtime has files");
      assertEquals(await tree(join(dir, "b")), first, "and is written in full wherever asked");
      await prebuildDenextRuntime({ outDir: join(dir, "c"), classComponents: false });
      assertEquals(__runtimeBuildsForTests() - start, 2, "another classComponents is built");
      // Touch a framework source: the cached runtime is stale, so the next prebuild builds.
      await Deno.utime(source, new Date(), new Date(Date.now() + 60_000));
      await prebuildDenextRuntime({ outDir: join(dir, "d"), classComponents: true });
      assertEquals(__runtimeBuildsForTests() - start, 3, "an edited source rebuilds");
    });
  } finally {
    await Deno.utime(source, original.atime ?? new Date(), original.mtime ?? new Date());
    await Deno.remove(dir, { recursive: true });
  }
});
