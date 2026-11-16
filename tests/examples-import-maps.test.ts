// Every `@denext/...` module an example imports is mapped in that example's own deno.json: an
// example is copied out of the repo as a starting point, and an unmapped subpath (the
// pages-router example's `@denext/pages-router/head`) fails to resolve the moment it runs.

import { assertEquals } from "@std/assert";
import { fromFileUrl, join, relative } from "@std/path";

const EXAMPLES = fromFileUrl(new URL("../examples/", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".denext", "dist", "out", "ios", "android", "vendor"]);
const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)["'](@denext\/[^"']+)["']/g;

async function sourceFiles(dir: string, out: string[] = []): Promise<string[]> {
  for await (const e of Deno.readDir(dir)) {
    const path = join(dir, e.name);
    if (e.isDirectory) {
      if (!SKIP_DIRS.has(e.name)) await sourceFiles(path, out);
    } else if (/\.(?:ts|tsx|mts)$/.test(e.name)) out.push(path);
  }
  return out;
}

/** Whether an import map resolves `specifier` (an exact key, or a `prefix/` key). */
export function mapResolves(imports: Record<string, string>, specifier: string): boolean {
  return specifier in imports ||
    Object.keys(imports).some((k) => k.endsWith("/") && specifier.startsWith(k));
}

Deno.test("examples: every @denext/* import is mapped in the example's deno.json", async () => {
  const unmapped: string[] = [];
  let checked = 0;
  for await (const e of Deno.readDir(EXAMPLES)) {
    if (!e.isDirectory) continue;
    const dir = join(EXAMPLES, e.name);
    let imports: Record<string, string>;
    try {
      imports = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))).imports ?? {};
    } catch {
      continue; // no deno.json: not a Deno example
    }
    checked++;
    for (const file of await sourceFiles(dir)) {
      for (const m of (await Deno.readTextFile(file)).matchAll(IMPORT)) {
        if (!mapResolves(imports, m[1])) {
          unmapped.push(`${e.name}/${relative(dir, file)}: ${m[1]}`);
        }
      }
    }
  }
  assertEquals(checked > 20, true, `only ${checked} examples found`);
  assertEquals(unmapped.sort(), []);
});

Deno.test("mapResolves: exact keys and trailing-slash prefixes", () => {
  const imports = { "@denext/a": "./a.ts", "@denext/b/": "./b/" };
  assertEquals(mapResolves(imports, "@denext/a"), true);
  assertEquals(mapResolves(imports, "@denext/a/head"), false);
  assertEquals(mapResolves(imports, "@denext/b/x.ts"), true);
});
