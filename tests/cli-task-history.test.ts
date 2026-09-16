// `denext task <name>` and run history.
//
// This verb never boots the scheduler, so without installing the recorder itself a manual run
// would record nothing while the identical task on a schedule recorded fine — false exactly where
// someone would look first. That asymmetry is what these tests exist to prevent.
//
// The verb is driven in-process with `console` and `Deno.exit` stubbed, as
// `tests/cli-commands-verb.test.ts` does: the failure path calls `Deno.exit(1)`, which would
// otherwise kill the test runner.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { CommandContext } from "../src/cli/command.ts";
import { taskCommand } from "../src/cli/commands/task.ts";
import { clearTasks } from "../src/server/tasks.ts";
import { readTaskHistory } from "../src/server/task-history.ts";

/** A project with one task, and whatever config the test needs. */
async function project(config: string | null): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_cli_history_" });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  await Deno.mkdir(join(dir, "tasks"), { recursive: true });
  const server = new URL("../src/server/tasks.ts", import.meta.url).href;
  await Deno.writeTextFile(
    join(dir, "tasks/cleanup.ts"),
    `import { defineTask } from "${server}";\nexport default defineTask({ handler: () => "swept" });\n`,
  );
  if (config !== null) await Deno.writeTextFile(join(dir, "denext.config.ts"), config);
  return dir;
}

/** Run the verb, with console and `Deno.exit` stubbed. */
async function invoke(dir: string, over: Partial<CommandContext> = {}): Promise<number[]> {
  const codes: number[] = [];
  const log = console.log;
  const err = console.error;
  const exit = Deno.exit;
  console.log = () => {};
  console.error = () => {};
  Deno.exit = ((code?: number): never => {
    codes.push(code ?? 0);
    throw new Error("__exit__");
  }) as typeof Deno.exit;
  try {
    await taskCommand.run({
      positionals: [],
      flags: {},
      global: { cwd: dir, json: false, verbose: false, quiet: false } as CommandContext["global"],
      rest: [],
      ...over,
    });
  } catch (error) {
    assert(String(error).includes("__exit__"), `unexpected throw: ${error}`);
  } finally {
    console.log = log;
    console.error = err;
    Deno.exit = exit;
  }
  return codes;
}

Deno.test("a manual CLI run is recorded, exactly like a scheduled one", async () => {
  clearTasks();
  const dir = await project("export default { tasks: { history: true } };\n");
  try {
    assertEquals(await invoke(dir, { positionals: ["cleanup"] }), []);
    const history = readTaskHistory({ path: join(dir, ".denext", "tasks.db") });
    assert(history.available, history.reason ?? "");
    assertEquals(history.recent.length, 1);
    assertEquals(history.recent[0].task, "cleanup");
    assertEquals(history.recent[0].ok, true);
    // The trigger is what distinguishes it from the scheduler's own runs.
    assertEquals(history.recent[0].trigger, "manual");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("with history off, running a task from the CLI writes nothing", async () => {
  clearTasks();
  const dir = await project(null);
  try {
    assertEquals(await invoke(dir, { positionals: ["cleanup"] }), []);
    let present = true;
    try {
      await Deno.stat(join(dir, ".denext", "tasks.db"));
    } catch {
      present = false;
    }
    assert(!present, "a CLI run must not create a history file nobody asked for");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("--list --json reports whether history is on, resolved rather than guessed", async () => {
  clearTasks();
  const dir = await project("export default { tasks: { history: true } };\n");
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void printed.push(args.map(String).join(" "));
  try {
    await taskCommand.run({
      positionals: [],
      flags: { list: true },
      global: { cwd: dir, json: true, verbose: false, quiet: false } as CommandContext["global"],
      rest: [],
    });
    // `denext ui` cannot evaluate denext.config.ts, so it reads this instead of parsing source.
    const doc = JSON.parse(printed.join("\n"));
    assertEquals(doc.history, true);
    assertEquals(doc.tasks.map((t: { name: string }) => t.name), ["cleanup"]);
  } finally {
    console.log = log;
    await Deno.remove(dir, { recursive: true });
  }
});
