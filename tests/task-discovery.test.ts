import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { bootScheduledTasks, discoverTasks } from "../src/server/task-loader.ts";
import { clearTasks, getTask, runTask, taskNames } from "../src/server/tasks.ts";
import { readTaskHistory } from "../src/server/task-history.ts";

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

/** Whether a path exists. */
async function present(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("run history is off unless the project asks — and then it records", async () => {
  clearTasks();
  const dir = await fixture({ "tasks/cleanup.ts": TASK() });
  const out = join(dir, ".denext");
  try {
    // Off: no recorder, and — the part that matters — no file is created. An app that did not
    // ask for history must not start writing one merely because it upgraded.
    const stop = await bootScheduledTasks(dir, undefined, out);
    await runTask("cleanup");
    stop();
    assertEquals(await present(join(out, "tasks.db")), false, "nothing is written when off");

    // On: the very same run is recorded.
    clearTasks();
    const stopOn = await bootScheduledTasks(dir, { tasks: { history: true } }, out);
    await runTask("cleanup");
    stopOn();

    const history = readTaskHistory({ path: join(out, "tasks.db") });
    assert(history.available, history.reason ?? "");
    assertEquals(history.recent.length, 1);
    assertEquals(history.recent[0].task, "cleanup");
    assertEquals(history.recent[0].ok, true);
    assertEquals(history.recent[0].trigger, "manual");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the disposer stops recording, so a later run is not attributed to a dead boot", async () => {
  clearTasks();
  const dir = await fixture({ "tasks/cleanup.ts": TASK() });
  const out = join(dir, ".denext");
  try {
    const stop = await bootScheduledTasks(dir, { tasks: { history: true } }, out);
    await runTask("cleanup");
    stop(); // releases the recorder AND the database handle

    await runTask("cleanup"); // after disposal: runs fine, records nothing
    const history = readTaskHistory({ path: join(out, "tasks.db") });
    assertEquals(history.recent.length, 1, "only the run made while recording was kept");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("history is recorded on Deno Deploy too, but the caveat is said out loud", async () => {
  clearTasks();
  const dir = await fixture({ "tasks/cleanup.ts": TASK() });
  const out = join(dir, ".denext");
  const had = Deno.env.get("DENO_DEPLOYMENT_ID");
  Deno.env.set("DENO_DEPLOYMENT_ID", "test-deployment");
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    // Not refused: the app asked explicitly. But the file is per-isolate and ephemeral there, so
    // silently showing a resetting fragment would be worse than saying so.
    const stop = await bootScheduledTasks(dir, { tasks: { history: true } }, out);
    await runTask("cleanup");
    stop();
    assertEquals(warnings.length, 1, warnings.join(" | "));
    assert(warnings[0].includes("per-isolate"), warnings[0]);
    assertEquals(readTaskHistory({ path: join(out, "tasks.db") }).recent.length, 1);
  } finally {
    console.warn = realWarn;
    if (had === undefined) Deno.env.delete("DENO_DEPLOYMENT_ID");
    else Deno.env.set("DENO_DEPLOYMENT_ID", had);
    await Deno.remove(dir, { recursive: true });
  }
});
