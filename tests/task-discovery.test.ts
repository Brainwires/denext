import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { bootScheduledTasks, discoverTasks } from "../src/server/task-loader.ts";
import { clearTasks, getTask, runTask, taskNames } from "../src/server/tasks.ts";

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext-tasks-" });
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, body);
  }
  return dir;
}

const TASK = (extra = "") =>
  `import { defineTask } from "${new URL("../src/server/tasks.ts", import.meta.url).href}";\n` +
  `export default defineTask({ handler: (ctx) => ({ ran: ctx.name, payload: ctx.payload }), ${extra} });\n`;

Deno.test("discoverTasks registers every tasks/ file by its path-name, incl. nested", async () => {
  clearTasks();
  const dir = await fixture({
    "tasks/cleanup.ts": TASK('description: "purge stale rows"'),
    "tasks/reports/daily.ts": TASK('schedule: "0 6 * * *"'),
    "tasks/_helper.ts": TASK(), // underscore-prefixed → skipped
    "tasks/notatask.ts": `export const x = 1;\n`, // no default defineTask → skipped
  });
  const names = await discoverTasks(join(dir, "tasks"));
  assertEquals(names, ["cleanup", "reports/daily"]);
  assertEquals(taskNames(), ["cleanup", "reports/daily"]);
  assertEquals(getTask("cleanup")?.description, "purge stale rows");
  const out = await runTask("cleanup", { n: 1 });
  assertEquals(out, { ran: "cleanup", payload: { n: 1 } });
  await Deno.remove(dir, { recursive: true });
});

Deno.test("discoverTasks on a missing tasks/ dir returns [] (no error)", async () => {
  clearTasks();
  const dir = await Deno.makeTempDir({ prefix: "denext-notasks-" });
  assertEquals(await discoverTasks(join(dir, "tasks")), []);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("bootScheduledTasks discovers + schedules; a disposer stops the scheduler", async () => {
  clearTasks();
  const dir = await fixture({ "tasks/warm.ts": TASK() });
  // No Deno.cron here → userland scheduler; the disposer must clear its timer so the test
  // doesn't leak an op.
  const dispose = await bootScheduledTasks(dir, { scheduledTasks: { "0 0 * * *": "warm" } });
  assertEquals(typeof dispose, "function");
  assert(taskNames().includes("warm"));
  dispose();
  await Deno.remove(dir, { recursive: true });
});
