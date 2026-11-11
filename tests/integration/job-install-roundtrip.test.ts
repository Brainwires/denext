// `denext job install` for real: a throwaway app's job installed into this machine's own scheduler
// (launchd on macOS, a systemd user timer or the crontab on Linux, Task Scheduler on Windows),
// started through the scheduler, its marker file checked, then uninstalled and checked gone.
// tests/job-install.test.ts covers what each backend writes against a fake host; this is the one
// test that installs, fires and removes a real entry.
//
// Opt-in: it changes the user's scheduler, so it runs only with DENEXT_JOB_INSTALL_E2E=1 (e2e.yml's
// `job-install` legs). DENEXT_JOB_INSTALL_E2E_BACKEND=<launchd|systemd|crontab|schtasks> makes a
// different backend (or none) a failure; without it a Linux machine with neither a systemd user
// manager nor `crontab` skips with a notice, and a crontab with no cron daemon running skips only
// the firing check. Whatever fails, the entry and the app are removed.
//
// The entry fires through the scheduler's own run-now (`launchctl kickstart`, `systemctl --user
// start`, `schtasks /Run`); cron has none, so the job's every-minute schedule fires it.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { type SchedulerTool, schedulerToolPath } from "../../src/cli/job-install/host.ts";
import { jobSlug, projectId } from "../../src/cli/job-install/install.ts";

const ENABLED = Deno.env.get("DENEXT_JOB_INSTALL_E2E") === "1";
const REQUIRED_BACKEND = Deno.env.get("DENEXT_JOB_INSTALL_E2E_BACKEND") || undefined;
const REPO = new URL("../../", import.meta.url);
const CLI = new URL("cli.ts", REPO);
const JOB = "roundtrip";
const FIRE_TIMEOUT_MS = 240_000;

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a program; `127` when it is not installed. */
async function run(cmd: string, args: string[], opts: Deno.CommandOptions = {}): Promise<Run> {
  try {
    const out = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped", ...opts })
      .output();
    const text = (b: Uint8Array) => new TextDecoder().decode(b);
    return { code: out.code, stdout: text(out.stdout), stderr: text(out.stderr) };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return { code: 127, stdout: "", stderr: String(err) };
    throw err;
  }
}

/** Runs a scheduler tool the way `denext job install` finds it. */
function tool(name: SchedulerTool, args: string[]): Promise<Run> {
  const path = schedulerToolPath(name);
  return path ? run(path, args) : Promise.resolve({ code: 127, stdout: "", stderr: "not found" });
}

/** A throwaway app with one job, scheduled every minute, that writes `fired.txt` beside it. */
async function sandbox(): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-job-install-e2e-" }));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ imports: { "denext/server": new URL("src/server/mod.ts", REPO).href } }),
  );
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    `export default { scheduledJobs: { "* * * * *": [${JSON.stringify(JOB)}] } };\n`,
  );
  await Deno.mkdir(join(dir, "jobs"));
  await Deno.writeTextFile(
    join(dir, "jobs", `${JOB}.ts`),
    `import { defineJob } from "denext/server";\n` +
      `export default defineJob({\n` +
      `  description: "job install round trip marker",\n` +
      `  handler: async () => {\n` +
      `    await Deno.writeTextFile(new URL("../fired.txt", import.meta.url), new Date().toISOString());\n` +
      `  },\n` +
      `});\n`,
  );
  return dir;
}

/**
 * `denext job install [--uninstall] --json` in `dir`. The entries run this Deno on this checkout's
 * CLI: DENEXT_INSTALL points at an empty folder, so an installed `denext` binary (another
 * version) is never the one the scheduler starts.
 */
async function jobInstall(dir: string, noBin: string, extra: string[] = []): Promise<Run> {
  return await run(
    Deno.execPath(),
    ["run", "-A", fromFileUrl(CLI), "job", "install", ...extra, "--json"],
    { cwd: dir, env: { DENEXT_INSTALL: noBin, NO_COLOR: "1" } },
  );
}

/** Where a backend keeps the entry, how to run it now, and how to see it. */
interface Entry {
  /** Whether the scheduler holds the entry. */
  present(): Promise<boolean>;
  /** Starts it through the scheduler (`null`: no run-now; wait for the schedule). */
  runNow: (() => Promise<Run>) | null;
  /** What the scheduler says about it, for a failure's message. */
  describe(): Promise<string>;
  /** Removes it without denext (the cleanup of last resort). */
  forceRemove(): Promise<void>;
}

/** The entry `backend` holds for the job of project `id`. */
function entryFor(backend: string, id: string, slug: string, home: string): Entry {
  if (backend === "launchd") {
    const label = `dev.denext.job.${id}.${slug}`;
    const target = `gui/${Deno.uid()}/${label}`;
    const plist = join(home, "Library", "LaunchAgents", `${label}.plist`);
    return {
      present: async () => (await tool("launchctl", ["print", target])).code === 0,
      runNow: () => tool("launchctl", ["kickstart", target]),
      describe: async () => (await tool("launchctl", ["print", target])).stdout,
      forceRemove: async () => {
        await tool("launchctl", ["bootout", target]);
        await Deno.remove(plist).catch(() => {});
      },
    };
  }
  if (backend === "systemd") {
    const unit = `denext-job-${id}-${slug}`;
    const dir = join(Deno.env.get("XDG_CONFIG_HOME") || join(home, ".config"), "systemd", "user");
    return {
      present: async () =>
        (await tool("systemctl", ["--user", "is-enabled", `${unit}.timer`])).code === 0,
      runNow: () => tool("systemctl", ["--user", "start", `${unit}.service`]),
      describe: async () => {
        const status = await tool("systemctl", ["--user", "status", "--no-pager", `${unit}.*`]);
        const journal = await run("journalctl", ["--user", "--no-pager", "-n", "50", "-u", unit]);
        return `${status.stdout}${status.stderr}\n${journal.stdout}${journal.stderr}`;
      },
      forceRemove: async () => {
        await tool("systemctl", ["--user", "disable", "--now", `${unit}.timer`]);
        for (const ext of ["timer", "service"]) {
          await Deno.remove(join(dir, `${unit}.${ext}`)).catch(() => {});
        }
        await tool("systemctl", ["--user", "daemon-reload"]);
      },
    };
  }
  if (backend === "crontab") {
    const marker = `denext-managed project=${id} job=${slug}`;
    return {
      present: async () => (await tool("crontab", ["-l"])).stdout.includes(marker),
      runNow: null,
      describe: async () => (await tool("crontab", ["-l"])).stdout,
      // denext's uninstall is the only editor of the user's crontab here: nothing else to do.
      forceRemove: () => Promise.resolve(),
    };
  }
  const name = `\\denext\\${id}\\${slug}`;
  return {
    present: async () => (await tool("schtasks", ["/Query", "/TN", name])).code === 0,
    runNow: () => tool("schtasks", ["/Run", "/TN", name]),
    describe: async () => {
      const r = await tool("schtasks", ["/Query", "/TN", name, "/V", "/FO", "LIST"]);
      return r.stdout + r.stderr;
    },
    forceRemove: async () => void await tool("schtasks", ["/Delete", "/TN", name, "/F"]),
  };
}

/** Whether a cron daemon is running here (crontab entries fire only then). */
async function cronRunning(): Promise<boolean> {
  for (const name of ["cron", "crond", "cronie"]) {
    if ((await run("pgrep", ["-x", name])).code === 0) return true;
  }
  return false;
}

/** Waits for `path` to exist. */
async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await Deno.stat(path);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

/** A GitHub Actions notice (plain text elsewhere). */
function notice(message: string): void {
  console.log(Deno.env.get("GITHUB_ACTIONS") ? `::notice::${message}` : `note: ${message}`);
}

/** The throwaway app and the entry it installs, for the steps below and the cleanup. */
interface RoundTrip {
  readonly dir: string;
  readonly noBin: string;
  readonly id: string;
  readonly slug: string;
  /** Set once `denext job install` succeeded: the entry must be removed, whatever fails next. */
  installed: boolean;
  entry: Entry | null;
}

/** Installs the entry; `false` when this Linux machine has no scheduler at all (a skip). */
async function install(rt: RoundTrip): Promise<boolean> {
  const out = await jobInstall(rt.dir, rt.noBin);
  rt.installed = out.code === 0;
  if (!rt.installed) {
    const noScheduler = /no user scheduler here/.test(out.stderr);
    if (noScheduler && Deno.build.os === "linux" && !REQUIRED_BACKEND) {
      notice(
        "job install round trip skipped: no systemd user manager and no crontab on this Linux " +
          `machine (${out.stderr.trim()})`,
      );
      return false;
    }
    throw new Error(`job install failed (${out.code}):\n${out.stderr}`);
  }
  const report = JSON.parse(out.stdout) as { backend: string; installed: { slug: string }[] };
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  rt.entry = entryFor(report.backend, rt.id, rt.slug, home);
  console.log(`backend: ${report.backend}, project ${rt.id}, sandbox ${rt.dir}`);
  if (REQUIRED_BACKEND) assertEquals(report.backend, REQUIRED_BACKEND);
  assertEquals(report.installed.map((e) => e.slug), [rt.slug]);
  assert(await rt.entry.present(), `the ${report.backend} entry is not there after install`);
  return true;
}

/** Fires the entry through the scheduler and waits for the job's marker (when it can fire). */
async function fire(rt: RoundTrip, entry: Entry): Promise<void> {
  if (entry.runNow) {
    const started = await entry.runNow();
    assertEquals(started.code, 0, `run-now failed: ${started.stderr}${started.stdout}`);
  } else if (!(await cronRunning())) {
    notice(
      "job install round trip: the crontab entry was installed and is removed below, but no " +
        "cron daemon runs here, so its firing is not checked",
    );
    return;
  }
  const marker = join(rt.dir, "fired.txt");
  if (!(await waitForFile(marker, FIRE_TIMEOUT_MS))) {
    const log = await Deno.readTextFile(join(rt.dir, ".denext", "logs", "jobs", `${rt.slug}.log`))
      .catch(() => "(no job log)");
    throw new Error(
      `the job did not write its marker within ${FIRE_TIMEOUT_MS / 1000}s.\n` +
        `job log:\n${log}\nscheduler:\n${await entry.describe()}`,
    );
  }
  console.log(`fired: ${await Deno.readTextFile(marker)}`);
}

/** Uninstalls through denext and checks the scheduler no longer holds the entry. */
async function uninstall(rt: RoundTrip, entry: Entry): Promise<void> {
  const removed = await jobInstall(rt.dir, rt.noBin, ["--uninstall"]);
  assertEquals(removed.code, 0, `uninstall failed:\n${removed.stderr}`);
  const removal = JSON.parse(removed.stdout) as { removed: { slug: string }[] };
  assertEquals(removal.removed.map((r) => r.slug), [rt.slug]);
  assert(!(await entry.present()), "the entry is still there after uninstall");
  rt.installed = false;
}

/** After a failure: denext's own uninstall, then the scheduler's tools; then the app. */
async function cleanUp(rt: RoundTrip): Promise<void> {
  if (rt.installed) {
    await jobInstall(rt.dir, rt.noBin, ["--uninstall"]).catch(() => {});
    if (rt.entry && await rt.entry.present().catch(() => true)) {
      await rt.entry.forceRemove().catch(() => {});
    }
  }
  await Deno.remove(rt.dir, { recursive: true }).catch(() => {});
  await Deno.remove(rt.noBin, { recursive: true }).catch(() => {});
}

Deno.test({
  name: "denext job install: a real entry installs, fires through the scheduler and uninstalls",
  ignore: !ENABLED,
  // The scheduler's processes are not this test's to account for.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await sandbox();
    const rt: RoundTrip = {
      dir,
      noBin: await Deno.makeTempDir({ prefix: "denext-no-install-" }),
      id: await projectId(dir),
      slug: jobSlug(JOB),
      installed: false,
      entry: null,
    };
    try {
      if (!(await install(rt)) || !rt.entry) return;
      await fire(rt, rt.entry);
      await uninstall(rt, rt.entry);
    } finally {
      await cleanUp(rt);
    }
  },
});
