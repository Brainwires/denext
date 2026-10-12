// `denext job <name>` and run history.
//
// This verb never boots the scheduler, so without installing the recorder itself a manual run
// would record nothing while the identical job on a schedule recorded fine — false exactly where
// someone would look first. That asymmetry is what these tests exist to prevent.
//
// The verb is driven in-process with `console` and `Deno.exit` stubbed, as
// `tests/cli-commands-verb.test.ts` does: the failure path calls `Deno.exit(1)`, which would
// otherwise kill the test runner.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { CommandContext } from "../src/cli/command.ts";
import { jobCommand } from "../src/cli/commands/job.ts";
import { clearJobs } from "../src/server/jobs.ts";
import { readJobHistory } from "../src/server/job-history.ts";

/** A project with one job, and whatever config the test needs. */
async function project(config: string | null): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_cli_history_" });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  await Deno.mkdir(join(dir, "jobs"), { recursive: true });
  const server = new URL("../src/server/jobs.ts", import.meta.url).href;
  await Deno.writeTextFile(
    join(dir, "jobs/cleanup.ts"),
    `import { defineJob } from "${server}";\nexport default defineJob({ handler: () => "swept" });\n`,
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
    await jobCommand.run({
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
  clearJobs();
  const dir = await project("export default { jobs: { history: true } };\n");
  try {
    assertEquals(await invoke(dir, { positionals: ["cleanup"] }), []);
    const history = readJobHistory({ path: join(dir, ".denext", "jobs.db") });
    assert(history.available, history.reason ?? "");
    assertEquals(history.recent.length, 1);
    assertEquals(history.recent[0].job, "cleanup");
    assertEquals(history.recent[0].ok, true);
    // The trigger is what distinguishes it from the scheduler's own runs.
    assertEquals(history.recent[0].trigger, "manual");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("with history off, running a job from the CLI writes nothing", async () => {
  clearJobs();
  const dir = await project(null);
  try {
    assertEquals(await invoke(dir, { positionals: ["cleanup"] }), []);
    let present = true;
    try {
      await Deno.stat(join(dir, ".denext", "jobs.db"));
    } catch {
      present = false;
    }
    assert(!present, "a CLI run must not create a history file nobody asked for");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("--list --json reports whether history is on, resolved rather than guessed", async () => {
  clearJobs();
  const dir = await project("export default { jobs: { history: true } };\n");
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void printed.push(args.map(String).join(" "));
  try {
    await jobCommand.run({
      positionals: [],
      flags: { list: true },
      global: { cwd: dir, json: true, verbose: false, quiet: false } as CommandContext["global"],
      rest: [],
    });
    // `denext ui` cannot evaluate denext.config.ts, so it reads this instead of parsing source.
    const doc = JSON.parse(printed.join("\n"));
    assertEquals(doc.history, true);
    assertEquals(doc.jobs.map((t: { name: string }) => t.name), ["cleanup"]);
  } finally {
    console.log = log;
    await Deno.remove(dir, { recursive: true });
  }
});

/** Run the verb with `--json`, returning what it printed as one document. */
async function invokeJson(dir: string, flags: Record<string, unknown>): Promise<unknown> {
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void printed.push(args.map(String).join(" "));
  try {
    await jobCommand.run({
      positionals: [],
      flags,
      global: { cwd: dir, json: true, verbose: false, quiet: false } as CommandContext["global"],
      rest: [],
    } as CommandContext);
  } finally {
    console.log = log;
  }
  return JSON.parse(printed.join("\n"));
}

/** A config whose history goes to the app's own store (a SQLite file of its choosing). */
function customStoreConfig(): string {
  const history = new URL("../src/server/job-history.ts", import.meta.url).href;
  return `import { sqliteJobHistoryStore } from "${history}";\n` +
    "export default { jobs: { history: { store: sqliteJobHistoryStore({ path: " +
    "new URL('./custom.db', import.meta.url).pathname }) } } };\n";
}

Deno.test("a custom store: runs land in it; --history and --clear-history go through it", async () => {
  clearJobs();
  const dir = await project(customStoreConfig());
  try {
    const listing = await invokeJson(dir, { list: true }) as Record<string, unknown>;
    assertEquals([listing.history, listing.historyStore], [true, "custom"]);
    clearJobs();
    assertEquals(await invoke(dir, { positionals: ["cleanup"] }), []);
    let jobsDb = true;
    try {
      await Deno.stat(join(dir, ".denext", "jobs.db"));
    } catch {
      jobsDb = false;
    }
    assert(!jobsDb, "the default file is not written when a store is configured");
    const read = await invokeJson(dir, { history: true }) as {
      enabled: boolean;
      available: boolean;
      recent: { job: string; trigger: string }[];
    };
    assertEquals([read.enabled, read.available], [true, true]);
    assertEquals(read.recent.map((r) => [r.job, r.trigger]), [["cleanup", "manual"]]);
    assertEquals(await invokeJson(dir, { "clear-history": true }), {
      enabled: true,
      cleared: true,
    });
    const after = await invokeJson(dir, { history: true }) as { recent: unknown[] };
    assertEquals(after.recent, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("--read-only: --history tells the store, --clear-history is refused before it", async () => {
  clearJobs();
  const history = new URL("../src/server/job-history.ts", import.meta.url).href;
  // A store of the app's own that writes down how it was read, and what it was asked to clear.
  const dir = await project(`import { sqliteJobHistoryStore } from "${history}";
const inner = sqliteJobHistoryStore({ path: new URL("./custom.db", import.meta.url).pathname });
const note = (line) => Deno.writeTextFileSync(new URL("./calls.log", import.meta.url), line + "\\n", { append: true });
export default { jobs: { history: { store: {
  record: (run) => inner.record(run),
  read: (options) => { note("read " + JSON.stringify(options)); return inner.read(options); },
  listRuns: (job, options) => inner.listRuns(job, options),
  prune: (options) => inner.prune(options),
  clear: () => { note("clear"); return inner.clear(); },
  close: () => inner.close(),
} } } };
`);
  try {
    assertEquals(await invoke(dir, { positionals: ["cleanup"] }), []);
    const read = await invokeJson(dir, { history: true, "read-only": true }) as {
      available: boolean;
      recent: unknown[];
    };
    assertEquals([read.available, read.recent.length], [true, 1]);
    assertEquals(await invokeJson(dir, { "clear-history": true, "read-only": true }), {
      enabled: true,
      cleared: false,
      reason: "read-only",
    });
    const calls = (await Deno.readTextFile(join(dir, "calls.log"))).trim().split("\n");
    assertEquals(calls, ['read {"windowDays":7,"readOnly":true}'], "never asked to clear");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("--history with history off is an answer, and the default store says default", async () => {
  clearJobs();
  const dir = await project(null);
  try {
    assertEquals(await invokeJson(dir, { history: true }), {
      enabled: false,
      available: false,
      windowDays: 7,
    });
    const listing = await invokeJson(dir, { list: true }) as Record<string, unknown>;
    assertEquals([listing.history, listing.historyStore], [false, "default"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
