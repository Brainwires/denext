// A private copy of an `examples/<name>` app for a test that builds, serves or edits it.
//
// `deno test --parallel` runs many test files against the same examples at once. A test that
// writes into the checkout's example (its `.denext/` build output, an edited page) races every
// other test reading it, and the state-dir lock that serializes them adds to the stall time. A
// copy in the test run's temp dir is the test's own: the example's relative import map entries
// (`../../mod.ts`) are pointed at this checkout, its build output and lock file are left behind,
// and the copy is removed when the test process exits.

import { fromFileUrl, join, resolve, toFileUrl } from "@std/path";
import { makeTempDirUntilExit } from "./temp.ts";

const EXAMPLES = new URL("../../examples/", import.meta.url);

/** What a copy leaves behind: build output and per-checkout state, never sources. */
const SKIP = new Set([".denext", "node_modules", "out", "dist", "deno.lock"]);

/** `value` (a relative path in the example's `deno.json`) as an absolute file URL, else as is. */
function absolute(value: string, from: string): string {
  return value.startsWith("./") || value.startsWith("../")
    ? toFileUrl(resolve(from, value)).href
    : value;
}

/** Copy `from` into `to` (both directories), leaving out {@linkcode SKIP} at the top. */
async function copyTree(from: string, to: string, top = true): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    if (top && SKIP.has(entry.name)) continue;
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory) await copyTree(src, dest, false);
    else if (entry.isFile) await Deno.copyFile(src, dest);
  }
}

/**
 * Copy `examples/<name>` into a temp dir of its own (removed when the test process exits), with
 * its `deno.json` import map, lint plugins and task paths pointed at this checkout.
 *
 * @param name The example's directory name (`"hello"`).
 * @returns The copy's path.
 */
export async function copyExample(name: string): Promise<string> {
  const from = fromFileUrl(new URL(`${name}/`, EXAMPLES));
  const dir = await Deno.realPath(makeTempDirUntilExit(`denext_example_${name}_`));
  await copyTree(from, dir);
  const configPath = join(dir, "deno.json");
  const config = JSON.parse(await Deno.readTextFile(configPath));
  for (const [key, value] of Object.entries(config.imports ?? {})) {
    if (typeof value === "string") config.imports[key] = absolute(value, from);
  }
  if (Array.isArray(config.lint?.plugins)) {
    config.lint.plugins = config.lint.plugins.map((p: string) => absolute(p, from));
  }
  const cli = resolve(from, "../../cli.ts");
  for (const [task, command] of Object.entries(config.tasks ?? {})) {
    if (typeof command === "string") config.tasks[task] = command.replaceAll("../../cli.ts", cli);
  }
  await Deno.writeTextFile(configPath, JSON.stringify(config, null, 2) + "\n");
  return dir;
}
