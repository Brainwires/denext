// `denext task <name>` — run a background task on demand, or `denext task --list` to see them.
// Discovers `tasks/**` the same way the server does at boot, then runs the named task (or lists).
// Loads the app modules (`loadsModules: true`), so the CLI entrypoint runs the env + CSS/module
// re-exec gate first. The positional is the TASK name (not a directory) — resolve the project
// from `--cwd`/cwd, never from the positional.

import { resolve } from "@std/path";
import { join } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import { resolveProject } from "../../build/paths.ts";
import { discoverTasks } from "../../server/task-loader.ts";
import { getTask, runTask, taskNames } from "../../server/tasks.ts";

async function loadTasks(ctx: CommandContext): Promise<string[]> {
  const paths = await resolveProject(resolve(ctx.global.cwd ?? "."));
  return discoverTasks(join(paths.projectDir, "tasks"));
}

function listTasks(names: string[], hint: boolean): void {
  if (names.length === 0) {
    console.log("No tasks found. Add tasks/<name>.ts exporting `defineTask(...)`.");
    return;
  }
  console.log(`${names.length} task(s):`);
  for (const n of names) {
    const desc = getTask(n)?.description;
    console.log(`  ${n}${desc ? `  —  ${desc}` : ""}`);
  }
  if (hint) console.log("\nRun one with:  denext task <name>");
}

export const taskCommand: CommandSpec = {
  name: "task",
  summary: "Run a background task by name, or list them (--list)",
  loadsModules: true,
  flags: [
    { name: "list", alias: "l", type: "boolean", help: "List the app's tasks and exit" },
    {
      name: "payload",
      type: "string",
      valueName: "<json>",
      help: "JSON passed to the task's ctx.payload",
    },
  ],
  positionals: [{ name: "name", help: "Task name (its path under tasks/, e.g. cleanup)" }],
  // The positional is the TASK name, not a directory — resolve the project from `--cwd`/cwd so
  // the CLI's module-loading gate doesn't treat the task name as the project dir.
  moduleDir: (ctx) => resolve(ctx.global.cwd ?? "."),
  usage: "denext task <name> [--payload '<json>']\ndenext task --list",
  run: async (ctx: CommandContext) => {
    const names = await loadTasks(ctx);
    const name = ctx.positionals[0];
    if (ctx.flags.list === true || !name) {
      listTasks(names, !name && ctx.flags.list !== true);
      return;
    }
    if (!getTask(name)) {
      console.error(`denext: no task "${name}" (known: ${taskNames().join(", ") || "none"})`);
      Deno.exit(1);
    }
    let payload: unknown;
    if (typeof ctx.flags.payload === "string") {
      try {
        payload = JSON.parse(ctx.flags.payload);
      } catch {
        console.error("denext: --payload must be valid JSON");
        Deno.exit(1);
      }
    }
    console.log(`running task "${name}"…`);
    const started = performance.now();
    try {
      const result = await runTask(name, payload, { trigger: "manual" });
      console.log(`✓ "${name}" finished in ${Math.round(performance.now() - started)} ms`);
      if (result !== undefined) console.log(result);
    } catch (err) {
      console.error(`✗ task "${name}" failed:`, err);
      Deno.exit(1);
    }
  },
};
