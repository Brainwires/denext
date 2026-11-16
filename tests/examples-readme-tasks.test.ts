// Every `deno task <x>` / `denext task <x>` an example's README names must be a task that exists
// where the README says to run it: the example's own deno.json (the nearest one at or above the
// README, inside the example), a subdirectory's when the command is spelled `cd <dir> && … task
// <x>` on the same line, or the repo root's for a root task (`example:*`, or a line that says it
// runs from the repo root). A README that names a task the example doesn't have, or a root task
// without saying where it runs, sends a reader to a "task not found" error.

import { assertEquals } from "@std/assert";
import { walk } from "@std/fs";
import { parse } from "@std/jsonc";
import { dirname, fromFileUrl, join, relative, SEPARATOR } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const EXAMPLES = join(ROOT, "examples");

function tasksAt(dir: string): Set<string> | null {
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      const config = parse(Deno.readTextFileSync(join(dir, name))) as { tasks?: object };
      return new Set(Object.keys(config.tasks ?? {}));
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  return null;
}

/** The tasks of the nearest deno.json at or above `dir`, staying inside examples/. */
function nearestTasks(dir: string): Set<string> {
  for (let d = dir; d.startsWith(EXAMPLES + SEPARATOR); d = dirname(d)) {
    const tasks = tasksAt(d);
    if (tasks) return tasks;
  }
  return new Set();
}

/** `<readme>: <task>` for every task mention that names no task where it runs. */
export function readmeTaskOffenders(
  readme: string,
  md: string,
  rootTasks: Set<string>,
): string[] {
  const offenders: string[] = [];
  const here = dirname(readme);
  for (const line of md.split("\n")) {
    const fromRoot = /\b(?:repo|repository) root\b/i.test(line);
    for (const m of line.matchAll(/\b(?:deno|denext) task ([A-Za-z0-9:_.-]+)/g)) {
      const name = m[1].replace(/[.:]+$/, "");
      const before = line.slice(0, m.index);
      const cd = [...before.matchAll(/\bcd ([\w./-]+) &&/g)].at(-1)?.[1];
      const local = nearestTasks(cd ? join(here, cd) : here);
      const ok = name.startsWith("example:")
        ? rootTasks.has(name)
        : local.has(name) || (fromRoot && rootTasks.has(name));
      if (!ok) offenders.push(`${relative(ROOT, readme).replaceAll("\\", "/")}: ${name}`);
    }
  }
  return offenders;
}

Deno.test("example READMEs name tasks that exist where they run", async () => {
  const rootTasks = tasksAt(ROOT)!;
  const offenders: string[] = [];
  let readmes = 0;
  for await (
    const e of walk(EXAMPLES, { match: [/[\\/]README\.md$/], skip: [/node_modules/] })
  ) {
    readmes++;
    offenders.push(...readmeTaskOffenders(e.path, await Deno.readTextFile(e.path), rootTasks));
  }
  assertEquals(readmes > 40, true, `found ${readmes} READMEs`);
  assertEquals(offenders, []);
});

Deno.test("readmeTaskOffenders: a missing task, a cd, and a root task", () => {
  const readme = join(EXAMPLES, "scroll-bench", "README.md");
  const root = new Set(["test:e2e", "example:hello"]);
  assertEquals(readmeTaskOffenders(readme, "run `denext task nope`", root), [
    "examples/scroll-bench/README.md: nope",
  ]);
  assertEquals(readmeTaskOffenders(readme, "`(cd web && denext task export)`", root), []);
  assertEquals(readmeTaskOffenders(readme, "`denext task test:e2e`", root), [
    "examples/scroll-bench/README.md: test:e2e",
  ]);
  assertEquals(
    readmeTaskOffenders(readme, "From the repo root: `denext task test:e2e`", root),
    [],
  );
  assertEquals(readmeTaskOffenders(readme, "`deno task example:hello`", root), []);
});
