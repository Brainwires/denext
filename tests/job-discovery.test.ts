import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { bootScheduledJobs, discoverJobs } from "../src/server/job-loader.ts";
import { clearJobs, getJob, jobNames, runJob } from "../src/server/jobs.ts";
import { readJobHistory } from "../src/server/job-history.ts";
import { removeTempDir } from "./helpers/temp.ts";

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext-jobs-" });
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, body);
  }
  return dir;
}

const JOB = (extra = "") =>
  `import { defineJob } from "${new URL("../src/server/jobs.ts", import.meta.url).href}";\n` +
  `export default defineJob({ handler: (ctx) => ({ ran: ctx.name, payload: ctx.payload }), ${extra} });\n`;

Deno.test("discoverJobs registers every jobs/ file by its path-name, incl. nested", async () => {
  clearJobs();
  const dir = await fixture({
    "jobs/cleanup.ts": JOB('description: "purge stale rows"'),
    "jobs/reports/daily.ts": JOB('schedule: "0 6 * * *"'),
    "jobs/_helper.ts": JOB(), // underscore-prefixed → skipped
    "jobs/notajob.ts": `export const x = 1;\n`, // no default defineJob → skipped
  });
  const names = await discoverJobs(join(dir, "jobs"));
  assertEquals(names, ["cleanup", "reports/daily"]);
  assertEquals(jobNames(), ["cleanup", "reports/daily"]);
  assertEquals(getJob("cleanup")?.description, "purge stale rows");
  const out = await runJob("cleanup", { n: 1 });
  assertEquals(out, { ran: "cleanup", payload: { n: 1 } });
  await removeTempDir(dir);
});

Deno.test("discoverJobs on a missing jobs/ dir returns [] (no error)", async () => {
  clearJobs();
  const dir = await Deno.makeTempDir({ prefix: "denext-nojobs-" });
  assertEquals(await discoverJobs(join(dir, "jobs")), []);
  await removeTempDir(dir);
});

Deno.test("bootScheduledJobs discovers + schedules; a disposer stops the scheduler", async () => {
  clearJobs();
  const dir = await fixture({ "jobs/warm.ts": JOB() });
  // No Deno.cron here → userland scheduler; the disposer must clear its timer so the test
  // doesn't leak an op.
  const dispose = await bootScheduledJobs(dir, { scheduledJobs: { "0 0 * * *": "warm" } });
  assertEquals(typeof dispose, "function");
  assert(jobNames().includes("warm"));
  dispose();
  await removeTempDir(dir);
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
  clearJobs();
  const dir = await fixture({ "jobs/cleanup.ts": JOB() });
  const out = join(dir, ".denext");
  try {
    // Off: no recorder, and — the part that matters — no file is created. An app that did not
    // ask for history must not start writing one merely because it upgraded.
    const stop = await bootScheduledJobs(dir, undefined, out);
    await runJob("cleanup");
    stop();
    assertEquals(await present(join(out, "jobs.db")), false, "nothing is written when off");

    // On: the very same run is recorded.
    clearJobs();
    const stopOn = await bootScheduledJobs(dir, { jobs: { history: true } }, out);
    await runJob("cleanup");
    stopOn();

    const history = readJobHistory({ path: join(out, "jobs.db") });
    assert(history.available, history.reason ?? "");
    assertEquals(history.recent.length, 1);
    assertEquals(history.recent[0].job, "cleanup");
    assertEquals(history.recent[0].ok, true);
    assertEquals(history.recent[0].trigger, "manual");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("the disposer stops recording, so a later run is not attributed to a dead boot", async () => {
  clearJobs();
  const dir = await fixture({ "jobs/cleanup.ts": JOB() });
  const out = join(dir, ".denext");
  try {
    const stop = await bootScheduledJobs(dir, { jobs: { history: true } }, out);
    await runJob("cleanup");
    stop(); // releases the recorder AND the database handle

    await runJob("cleanup"); // after disposal: runs fine, records nothing
    const history = readJobHistory({ path: join(out, "jobs.db") });
    assertEquals(history.recent.length, 1, "only the run made while recording was kept");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("history is recorded on Deno Deploy too, but the caveat is said out loud", async () => {
  clearJobs();
  const dir = await fixture({ "jobs/cleanup.ts": JOB() });
  const out = join(dir, ".denext");
  const had = Deno.env.get("DENO_DEPLOYMENT_ID");
  Deno.env.set("DENO_DEPLOYMENT_ID", "test-deployment");
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    // Not refused: the app asked explicitly. But the file is per-isolate and ephemeral there, so
    // silently showing a resetting fragment would be worse than saying so.
    const stop = await bootScheduledJobs(dir, { jobs: { history: true } }, out);
    await runJob("cleanup");
    stop();
    assertEquals(warnings.length, 1, warnings.join(" | "));
    assert(warnings[0].includes("per-isolate"), warnings[0]);
    assertEquals(readJobHistory({ path: join(out, "jobs.db") }).recent.length, 1);
  } finally {
    console.warn = realWarn;
    if (had === undefined) Deno.env.delete("DENO_DEPLOYMENT_ID");
    else Deno.env.set("DENO_DEPLOYMENT_ID", had);
    await removeTempDir(dir);
  }
});
