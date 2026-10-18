import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { importModules, privateEntriesUnder } from "../src/server/module-walk.ts";
import { conventionModules } from "../src/build/deploy-scan.ts";

/** A `jobs/`-shaped directory under `_private/.hidden/`, the way a CI temp dir can sit. */
async function convention(): Promise<{ root: string; dir: string }> {
  const root = await Deno.makeTempDir({ prefix: "denext_module_walk_" });
  const dir = join(root, "_temp", ".work", "jobs");
  for (const rel of ["a.ts", "sub/b.ts", "_private.ts", ".dot.ts", "_shared/c.ts", ".d/e.ts"]) {
    await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, rel), "export default 1;\n");
  }
  return { root, dir };
}

// The dot / underscore rule is about the modules' own paths: a project whose directory sits under
// `_temp/` or `.work/` (a CI runner's temp dir, `~/.apps/`) used to discover no job or service.
Deno.test("discovery skips dot and _private entries below the directory, never the ones above", async () => {
  const { root, dir } = await convention();
  try {
    const names: string[] = [];
    for await (const m of importModules(dir, "job")) names.push(m.name);
    assertEquals(names.sort(), ["a", "sub/b"]);
    assertEquals((await conventionModules(dir)).map((m) => m.name), ["a", "sub/b"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("privateEntriesUnder: anchored to the directory, either separator", () => {
  const posix = privateEntriesUnder("/x/_t/.w/jobs/");
  assertEquals(posix.test("/x/_t/.w/jobs/a.ts"), false);
  assertEquals(posix.test("/x/_t/.w/jobs/_p.ts"), true);
  assertEquals(posix.test("/x/_t/.w/jobs/d/.h/a.ts"), true);
  const windows = privateEntriesUnder("C:/a/_temp/jobs");
  assertEquals(windows.test("C:\\a\\_temp\\jobs\\ok.ts"), false);
  assertEquals(windows.test("C:\\a\\_temp\\jobs\\x\\_y.ts"), true);
  // Regex characters in the directory are literal.
  assertEquals(privateEntriesUnder("/p+(q)/jobs").test("/p+(q)/jobs/a.ts"), false);
});
