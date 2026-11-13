// `denext job install`: the files and commands each OS scheduler gets, against a fake scheduler
// host — no test installs anything. Where the OS's own validator is on this machine the generated
// files go through it too (`plutil -lint` for launchd, `systemd-analyze calendar` for timers).

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { basename, join } from "@std/path";
import type { CommandContext } from "../src/cli/command.ts";
import { type JobInstallDeps, jobInstallVerb } from "../src/cli/commands/job-install.ts";
import { jobCommand } from "../src/cli/commands/job.ts";
import { crontabSlugs, withoutBlocks } from "../src/cli/job-install/crontab.ts";
import { dryRunHost, type DryRunStep, type SchedulerHost } from "../src/cli/job-install/host.ts";
import {
  denextCommand,
  jobSlug,
  projectId,
  runJobInstall,
} from "../src/cli/job-install/install.ts";
import { launchdIntervals } from "../src/cli/job-install/launchd.ts";
import { taskSlugs, windowsArg } from "../src/cli/job-install/schtasks.ts";
import { onCalendarValues } from "../src/cli/job-install/systemd.ts";
import { translateSchedules } from "../src/cli/job-install/translate.ts";
import { splitWindowsCommandLine } from "../src/cli/windows-command-line.ts";
import { clearJobs } from "../src/server/jobs.ts";
import { FakeHost, ID, OTHER_ID, PROJECT, request } from "./_job-install-fake.ts";

/** The XML's tags balance (a cheap well-formedness check; Deno has no XML parser). */
function assertBalancedXml(xml: string): void {
  const stack: string[] = [];
  for (const m of xml.matchAll(/<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>/g)) {
    const [, close, name, selfClose] = m;
    if (selfClose) continue;
    if (close) assertEquals(stack.pop(), name, `unbalanced </${name}>`);
    else stack.push(name);
  }
  assertEquals(stack, [], "unclosed tags");
}

/** A tool on this machine, or `null`. */
function tool(path: string): string | null {
  try {
    return Deno.statSync(path).isFile ? path : null;
  } catch {
    return null;
  }
}

Deno.test("jobSlug keeps a plain name and fingerprints a changed one", () => {
  assertEquals(jobSlug("cleanup"), "cleanup");
  const nested = jobSlug("reports/daily");
  assert(/^reports-daily-[0-9a-f]{6}$/.test(nested), nested);
  // Two names that fold alike still differ.
  assert(jobSlug("a/b") !== jobSlug("a-b"));
});

Deno.test("launchd: one agent per job, local calendar, guard where DST moves the hour", async () => {
  const host = new FakeHost("darwin", "/Users/u");
  const report = await runJobInstall(request(), host);
  assertEquals(report.backend, "launchd");
  assertEquals(report.installed.map((e) => [e.job, e.guarded]), [
    ["cleanup", true],
    ["reports/daily", false],
  ]);
  const plist = String(
    host.files.get(`/Users/u/Library/LaunchAgents/dev.denext.job.${ID}.cleanup.plist`),
  );
  assertStringIncludes(plist, `denext-managed project=${ID} job=cleanup`);
  assertStringIncludes(plist, "<string>--if-due</string>\n    <string>0 3 * * *</string>");
  assertStringIncludes(plist, "<key>WorkingDirectory</key>\n  <string>/work/my app</string>");
  // 03:00 UTC is 21:00 (CST) or 22:00 (CDT).
  assertStringIncludes(plist, "<key>Hour</key>\n      <integer>21</integer>");
  assertStringIncludes(plist, "<key>Hour</key>\n      <integer>22</integer>");
  assertEquals(host.changes().map((r) => [r.tool, ...r.args]), [
    [
      "launchctl",
      "bootstrap",
      "gui/501",
      `/Users/u/Library/LaunchAgents/dev.denext.job.${ID}.cleanup.plist`,
    ],
    [
      "launchctl",
      "bootstrap",
      "gui/501",
      `/Users/u/Library/LaunchAgents/dev.denext.job.${ID}.${jobSlug("reports/daily")}.plist`,
    ],
  ]);
  assert(host.dirs.has(`${PROJECT}/.denext/logs/jobs`));
  const plutil = tool("/usr/bin/plutil");
  if (plutil) {
    const dir = await Deno.makeTempDir({ prefix: "denext_launchd_" });
    try {
      for (const [path, data] of host.files) {
        const file = join(dir, basename(path));
        await Deno.writeTextFile(file, String(data));
        const out = await new Deno.Command(plutil, { args: ["-lint", file] }).output();
        assert(
          out.success,
          new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr),
        );
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("launchd: a re-install replaces ours, drops the stale, leaves everyone else's", async () => {
  const host = new FakeHost("darwin", "/Users/u");
  const agents = "/Users/u/Library/LaunchAgents";
  const foreign = `${agents}/com.example.agent.plist`;
  const otherProject = `${agents}/dev.denext.job.${OTHER_ID}.cleanup.plist`;
  host.files.set(foreign, "<plist/>");
  host.files.set(otherProject, `<!-- denext-managed project=${OTHER_ID} job=cleanup -->`);
  await runJobInstall(request(), host);
  host.ran.length = 0;
  await runJobInstall(request({ schedules: [{ cron: "0 4 * * *", job: "cleanup" }] }), host);
  const nested = jobSlug("reports/daily");
  assertEquals(host.changes().map((r) => r.args.join(" ")), [
    `bootout gui/501/dev.denext.job.${ID}.${nested}`,
    `bootout gui/501/dev.denext.job.${ID}.cleanup`,
    `bootstrap gui/501 ${agents}/dev.denext.job.${ID}.cleanup.plist`,
  ]);
  assertFalse(host.files.has(`${agents}/dev.denext.job.${ID}.${nested}.plist`));
  assert(host.files.has(foreign));
  assert(host.files.has(otherProject));
  assertStringIncludes(
    String(host.files.get(`${agents}/dev.denext.job.${ID}.cleanup.plist`)),
    "0 4 * * *",
  );
});

Deno.test("uninstall removes only this project's entries, or the named job's", async () => {
  const host = new FakeHost("darwin", "/Users/u");
  const agents = "/Users/u/Library/LaunchAgents";
  const otherProject = `${agents}/dev.denext.job.${OTHER_ID}.cleanup.plist`;
  host.files.set(otherProject, `<!-- denext-managed project=${OTHER_ID} job=cleanup -->`);
  await runJobInstall(request(), host);
  const one = await runJobInstall(request({ mode: "uninstall", names: ["cleanup"] }), host);
  assertEquals(one.removed, [{ backend: "launchd", slug: "cleanup" }]);
  assertEquals(one.backend, null);
  const rest = await runJobInstall(request({ mode: "uninstall" }), host);
  assertEquals(rest.removed, [{ backend: "launchd", slug: jobSlug("reports/daily") }]);
  assertEquals([...host.files.keys()], [otherProject]);
});

Deno.test("a schedule launchd can't follow is refused with nothing changed", async () => {
  const host = new FakeHost("darwin", "/Users/u");
  const err = await assertRejects(
    () => runJobInstall(request({ schedules: [{ cron: "0 3 1 * *", job: "cleanup" }] }), host),
    Error,
    "nothing changed",
  );
  assertStringIncludes(err.message, "day-of-month");
  assertEquals(host.changes(), []);
  assertEquals(host.files.size, 0);
  // Too many calendar entries is refused too, naming the limit.
  const many = translateSchedules(["*/2 0-22 * * 1-5"], [0]);
  let refused = false;
  try {
    launchdIntervals(many.rules, ["*/2 0-22 * * 1-5"]);
  } catch (e) {
    refused = String(e).includes("launchd calendar entries");
  }
  assert(refused);
});

Deno.test("named jobs: unknown or unscheduled names are errors; others are left alone", async () => {
  const host = new FakeHost("darwin", "/Users/u");
  await assertRejects(
    () => runJobInstall(request({ names: ["nope"] }), host),
    Error,
    'no job "nope"',
  );
  await assertRejects(
    () => runJobInstall(request({ names: ["manual"] }), host),
    Error,
    "has no schedule",
  );
  await runJobInstall(request(), host);
  host.ran.length = 0;
  const report = await runJobInstall(request({ names: ["cleanup"] }), host);
  assertEquals(report.installed.map((e) => e.job), ["cleanup"]);
  assertEquals(report.removed, []);
  assert(
    host.files.has(
      `/Users/u/Library/LaunchAgents/dev.denext.job.${ID}.${jobSlug("reports/daily")}.plist`,
    ),
  );
});

Deno.test("a config schedule naming an undefined job is a warning, not a failure", async () => {
  const host = new FakeHost("darwin", "/Users/u");
  const report = await runJobInstall(
    request({
      schedules: [{ cron: "0 3 * * *", job: "ghost" }, { cron: "0 3 * * *", job: "cleanup" }],
    }),
    host,
  );
  assertEquals(report.installed.map((e) => e.job), ["cleanup"]);
  assertStringIncludes(report.warnings.join("\n"), "ghost");
});

Deno.test("systemd: UTC timers, no translation and no guard", async () => {
  const host = new FakeHost("linux", "/home/u");
  const report = await runJobInstall(request(), host);
  assertEquals(report.backend, "systemd");
  assert(report.installed.every((e) => !e.guarded));
  const dir = "/home/u/.config/systemd/user";
  const timer = String(host.files.get(`${dir}/denext-job-${ID}-cleanup.timer`));
  const service = String(host.files.get(`${dir}/denext-job-${ID}-cleanup.service`));
  assertStringIncludes(timer, "OnCalendar=*-*-* 03:00:00 UTC");
  assertStringIncludes(timer, "Persistent=false");
  assertStringIncludes(service, `ExecStart="/Users/u/.denext/bin/denext" "job" "cleanup"`);
  assertStringIncludes(service, "WorkingDirectory=/work/my app");
  assertEquals(host.changes().map((r) => r.args.join(" ")), [
    "--user daemon-reload",
    `--user enable denext-job-${ID}-cleanup.timer denext-job-${ID}-${
      jobSlug("reports/daily")
    }.timer`,
    `--user restart denext-job-${ID}-cleanup.timer denext-job-${ID}-${
      jobSlug("reports/daily")
    }.timer`,
  ]);
  const values = onCalendarValues(
    translateSchedules(["0 12 1,15 * 5", "*/15 9-17 * * 1-5"], [0]).rules,
  );
  assertEquals(values, [
    "*-*-01,15 12:00:00 UTC",
    "Fri *-*-* 12:00:00 UTC",
    "Mon,Tue,Wed,Thu,Fri *-*-* 09,10,11,12,13,14,15,16,17:00,15,30,45:00 UTC",
  ]);
  const analyze = tool("/usr/bin/systemd-analyze") ?? tool("/bin/systemd-analyze");
  if (analyze) {
    const out = await new Deno.Command(analyze, { args: ["calendar", ...values] }).output();
    assert(out.success, new TextDecoder().decode(out.stderr));
  }
});

Deno.test("systemd --system runs as the installing user", async () => {
  const host = new FakeHost("linux", "/root", { SUDO_USER: "u" });
  await runJobInstall(request({ scope: "system" }), host);
  const service = String(host.files.get(`/etc/systemd/system/denext-job-${ID}-cleanup.service`));
  assertStringIncludes(service, "User=u");
  assert(host.changes().every((r) => r.args[0] !== "--user"));
  host.systemdSystem = false;
  await assertRejects(
    () => runJobInstall(request({ scope: "system" }), host),
    Error,
    "no system scheduler",
  );
});

Deno.test("crontab fallback: our blocks only, local time, idempotent", async () => {
  const host = new FakeHost("linux", "/home/u");
  host.systemdUser = false;
  const theirs = "MAILTO=me\n0 1 * * * /usr/bin/backup\n";
  host.crontab = theirs;
  const report = await runJobInstall(request(), host);
  assertEquals(report.backend, "crontab");
  const tab = host.crontab ?? "";
  assert(tab.startsWith(theirs), tab);
  assertEquals(crontabSlugs(tab, ID), [jobSlug("reports/daily"), "cleanup"].sort());
  assertStringIncludes(
    tab,
    "0 21,22 * * * cd '/work/my app' && '/Users/u/.denext/bin/denext' 'job' 'cleanup' '--if-due' '0 3 * * *'",
  );
  assertStringIncludes(tab, `>> '/work/my app/.denext/logs/jobs/cleanup.log' 2>&1`);
  // Installing the same again writes nothing.
  host.ran.length = 0;
  await runJobInstall(request(), host);
  assertEquals(host.changes(), []);
  await runJobInstall(request({ mode: "uninstall" }), host);
  assertEquals(host.crontab, theirs);
});

Deno.test("withoutBlocks keeps every foreign line, other projects' blocks too", () => {
  const text = [
    "# mine",
    `# >>> denext-managed project=${OTHER_ID} job=a`,
    "* * * * * other",
    `# <<< denext-managed project=${OTHER_ID} job=a`,
    `# >>> denext-managed project=${ID} job=a`,
    "* * * * * ours",
    `# <<< denext-managed project=${ID} job=a`,
    "0 0 * * * tail",
  ].join("\n");
  const out = withoutBlocks(text, ID, ["a"]);
  assertFalse(out.includes("ours"));
  assertStringIncludes(out, "other");
  assertStringIncludes(out, "tail");
});

Deno.test("Task Scheduler: UTF-16 XML under \\denext\\<id>\\, local triggers, repetition", async () => {
  const host = new FakeHost("windows", "C:\\Users\\u", { USERNAME: "u", USERDOMAIN: "BOX" });
  const req = request({
    project: { dir: "C:\\work\\app", id: ID, stateDir: "C:\\work\\app\\.denext" },
    denext: ["C:\\Users\\u\\.denext\\bin\\denext.exe"],
  });
  let xml = "";
  const recorder: SchedulerHost = Object.assign(Object.create(host), {
    writeFile: (path: string, data: string | Uint8Array) => {
      if (path.endsWith(".xml") && path.includes("cleanup")) {
        const bytes = data as Uint8Array;
        assertEquals([bytes[0], bytes[1]], [0xff, 0xfe]);
        xml = new TextDecoder("utf-16le").decode(bytes.subarray(2));
      }
      return host.writeFile(path, data);
    },
  });
  await runJobInstall(req, recorder);
  assertBalancedXml(xml);
  assert(xml.startsWith(`<?xml version="1.0" encoding="UTF-16"?>`));
  assertStringIncludes(xml, `<URI>\\denext\\${ID}\\cleanup</URI>`);
  assertStringIncludes(xml, "<UserId>BOX\\u</UserId>");
  assertStringIncludes(xml, "<LogonType>InteractiveToken</LogonType>");
  assertStringIncludes(xml, "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
  // 21:00 and 22:00 local are one run, an hour apart.
  assertStringIncludes(xml, "<Repetition><Interval>PT60M</Interval><Duration>PT61M</Duration>");
  assertStringIncludes(xml, "<StartBoundary>2000-01-01T21:00:00</StartBoundary>");
  assertStringIncludes(xml, "<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>");
  const args = (/<Arguments>(.*)<\/Arguments>/.exec(xml)?.[1] ?? "").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
  assertEquals(splitWindowsCommandLine(`x ${args}`).slice(1), [
    "job",
    "cleanup",
    "--if-due",
    "0 3 * * *",
  ]);
  assertEquals(
    [...host.tasks].sort(),
    [`\\denext\\${ID}\\cleanup`, `\\denext\\${ID}\\${jobSlug("reports/daily")}`].sort(),
  );
  // The XML is only the hand-off to schtasks.
  assertEquals([...host.files.keys()], []);
  host.tasks.add(`\\denext\\${OTHER_ID}\\cleanup`);
  await runJobInstall({ ...req, mode: "uninstall" }, host);
  assertEquals([...host.tasks], [`\\denext\\${OTHER_ID}\\cleanup`]);
});

Deno.test("windowsArg round-trips through CommandLineToArgvW's rules", () => {
  const args = [
    "plain",
    "with space",
    'quo"te',
    "trail\\",
    "C:\\a b\\",
    "",
    "*/5 * * * *;0 3 * * 1",
  ];
  assertEquals(splitWindowsCommandLine(`x ${args.map(windowsArg).join(" ")}`).slice(1), args);
});

Deno.test("taskSlugs reads only this project's folder", () => {
  const listing = [
    `"\\denext\\${ID}\\cleanup","N/A","Ready"`,
    `"\\denext\\${OTHER_ID}\\cleanup","N/A","Ready"`,
    `"\\Microsoft\\Windows\\Defrag","N/A","Ready"`,
  ].join("\r\n");
  assertEquals(taskSlugs(listing, ID), ["cleanup"]);
});

Deno.test("--dry-run records every change and makes none", async () => {
  const host = new FakeHost("darwin", "/Users/u");
  const steps: DryRunStep[] = [];
  await runJobInstall(request(), dryRunHost(host, steps));
  assertEquals(host.files.size, 0);
  assertEquals(host.changes(), []);
  assertEquals(steps.filter((s) => s.kind === "write").length, 2);
  assert(steps.some((s) => s.kind === "run" && s.args[0] === "bootstrap"));
});

Deno.test("denextCommand: the binary, else the installed one, else deno run with a warning", () => {
  const base = {
    os: "darwin",
    env: (n: string) => ({ HOME: "/Users/u" } as Record<string, string>)[n],
    standalone: false,
    execPath: "/cache/deno",
    cliModule: "https://jsr.io/@denext/denext/4.14.0/cli.ts",
  };
  assertEquals(denextCommand({ ...base, standalone: true, execPath: "/opt/denext" }).argv, [
    "/opt/denext",
  ]);
  assertEquals(denextCommand({ ...base, isFile: () => true }).argv, [
    "/Users/u/.denext/bin/denext",
  ]);
  const fallback = denextCommand({ ...base, isFile: () => false });
  assertEquals(fallback.argv, ["/cache/deno", "run", "-A", base.cliModule]);
  assert(fallback.warning);
  const custom = denextCommand({
    ...base,
    os: "windows",
    env: (n) => n === "DENEXT_INSTALL" ? "D:\\dx" : undefined,
    isFile: () => true,
  });
  assertEquals(custom.argv, [join("D:\\dx", "bin", "denext.exe")]);
});

/** A project with a scheduled job and a manual one; the job writes `ran.txt` when it runs. */
async function project(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_job_install_" });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  await Deno.mkdir(join(dir, "jobs"), { recursive: true });
  const server = new URL("../src/server/jobs.ts", import.meta.url).href;
  await Deno.writeTextFile(
    join(dir, "jobs/cleanup.ts"),
    `import { defineJob } from "${server}";\nexport default defineJob({ schedule: "0 3 * * *", ` +
      `handler: () => Deno.writeTextFile(${JSON.stringify(join(dir, "ran.txt"))}, "x") });\n`,
  );
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    `export default { scheduledJobs: { "30 6 * * 1": "cleanup" } };\n`,
  );
  return dir;
}

/** Run a verb with console (and `Deno.exit`) stubbed; returns the printed lines and exit codes. */
async function quietly(fn: () => unknown): Promise<{ out: string[]; codes: number[] }> {
  const out: string[] = [];
  const codes: number[] = [];
  const { log, error } = console;
  const exit = Deno.exit;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void out.push(a.join(" "));
  Deno.exit = ((code?: number): never => {
    codes.push(code ?? 0);
    throw new Error("__exit__");
  }) as typeof Deno.exit;
  try {
    await fn();
  } catch (err) {
    assert(String(err).includes("__exit__"), String(err));
  } finally {
    console.log = log;
    console.error = error;
    Deno.exit = exit;
  }
  return { out, codes };
}

/** A command context for the project. */
function ctxFor(
  dir: string,
  positionals: string[],
  flags: CommandContext["flags"] = {},
): CommandContext {
  return {
    positionals,
    flags,
    global: { cwd: dir, json: false, verbose: false, quiet: false } as CommandContext["global"],
    rest: [],
  };
}

Deno.test("the verb merges each job's schedule with config scheduledJobs", async () => {
  const dir = await project();
  const host = new FakeHost("linux", "/home/u");
  try {
    const { out } = await quietly(async () =>
      assertEquals(
        await jobInstallVerb(ctxFor(dir, ["install"], { "dry-run": true }), {
          host,
          offsets: [0],
          denext: { argv: ["/bin/denext"] },
        }),
        0,
      )
    );
    const text = out.join("\n");
    assertStringIncludes(text, "OnCalendar=*-*-* 03:00:00 UTC");
    assertStringIncludes(text, "OnCalendar=Mon *-*-* 06:30:00 UTC");
    assertStringIncludes(text, "would install cleanup");
    assertEquals(host.files.size, 0);
  } finally {
    clearJobs();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the verb refuses --user with --system", async () => {
  const dir = await project();
  try {
    const { out } = await quietly(async () =>
      assertEquals(
        await jobInstallVerb(ctxFor(dir, ["install"], { user: true, system: true }), {
          host: new FakeHost("linux", "/home/u"),
        }),
        1,
      )
    );
    assertStringIncludes(out.join("\n"), "not both");
  } finally {
    clearJobs();
    await Deno.remove(dir, { recursive: true });
  }
});

/** Run the verb on `host` for `dir` quietly; returns its exit code and the printed text. */
async function verb(
  dir: string,
  host: SchedulerHost,
  positionals: string[],
  flags: CommandContext["flags"] = {},
  deps: Omit<JobInstallDeps, "host"> = { offsets: [0], denext: { argv: ["/bin/denext"] } },
  json = false,
): Promise<{ code: number; text: string }> {
  let code = -1;
  const ctx = ctxFor(dir, positionals, flags);
  const { out } = await quietly(async () => {
    code = await jobInstallVerb({ ...ctx, global: { ...ctx.global, json } }, { host, ...deps });
  });
  return { code, text: out.join("\n") };
}

Deno.test("the verb's --json prints the report, with a dry run's steps", async () => {
  const dir = await project();
  try {
    const dry = await verb(
      dir,
      new FakeHost("linux", "/home/u"),
      ["install"],
      {
        "dry-run": true,
      },
      undefined,
      true,
    );
    assertEquals(dry.code, 0);
    const report = JSON.parse(dry.text);
    assertEquals(report.backend, "systemd");
    assertEquals(report.installed.map((e: { job: string }) => e.job), ["cleanup"]);
    assert(report.steps.some((s: DryRunStep) => s.kind === "write"));
    const real = await verb(
      dir,
      new FakeHost("linux", "/home/u"),
      ["install"],
      {},
      undefined,
      true,
    );
    assertFalse("steps" in JSON.parse(real.text));
  } finally {
    clearJobs();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the verb prints a dry run's mkdir, run and removal steps, and the DST guard", async () => {
  const dir = await project();
  const host = new FakeHost("darwin", "/Users/u");
  try {
    const shifting = { offsets: [-360, -300], denext: { argv: ["/bin/denext"] } };
    const dry = await verb(dir, host, ["install"], { "dry-run": true }, shifting);
    assertEquals(dry.code, 0);
    assertStringIncludes(dry.text, "mkdir -p ");
    assertStringIncludes(dry.text, "launchctl bootstrap gui/501 ");
    assertStringIncludes(dry.text, "would install cleanup: 30 6 * * 1; 0 3 * * * UTC (launchd)");
    assertStringIncludes(dry.text, "local time moves (UTC-06:00, UTC-05:00)");
    // Installed for real (on the fake), then a dry-run uninstall lists the removal.
    assertEquals((await verb(dir, host, ["install"])).code, 0);
    const undo = await verb(dir, host, ["install"], { "dry-run": true, uninstall: true });
    assertStringIncludes(undo.text, "launchctl bootout gui/501/");
    assertStringIncludes(undo.text, "rm /Users/u/Library/LaunchAgents/");
    assertStringIncludes(undo.text, "would remove cleanup (launchd)");
    assert(host.files.size > 0, "a dry run removes nothing");
    // Uninstalled for real; a second uninstall has nothing to do.
    await verb(dir, host, ["install"], { uninstall: true });
    const again = await verb(dir, host, ["install"], { uninstall: true });
    assertStringIncludes(again.text, "Nothing of this project's to remove.");
  } finally {
    clearJobs();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the verb prints the crontab a dry run would write, and the fallback warning", async () => {
  const dir = await project();
  const host = new FakeHost("linux", "/home/u");
  host.systemdUser = false;
  try {
    const dry = await verb(dir, host, ["install"], { "dry-run": true }, {
      offsets: [0],
      denext: { argv: ["/cache/deno", "run", "-A", "cli.ts"], warning: "no installed denext" },
    });
    assertStringIncludes(dry.text, "denext: no installed denext");
    assertStringIncludes(dry.text, "crontab -\n# (stdin)\n");
    assertStringIncludes(dry.text, "(crontab)");
    assertEquals(host.crontab, "", "a dry run writes no crontab");
  } finally {
    clearJobs();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the verb: --system, no scheduled jobs, a config warning, and this machine's denext", async () => {
  let dir = await project();
  try {
    const system = await verb(dir, new FakeHost("linux", "/home/u", { USER: "bob" }), ["install"], {
      system: true,
      "dry-run": true,
    });
    assertEquals(system.code, 0);
    assertStringIncludes(system.text, "# write /etc/systemd/system/");
    assertStringIncludes(system.text, "User=bob");
    // A config schedule naming no job is a printed warning; with no schedule left there's
    // nothing to install (a fresh project: config and job modules are cached per path).
    clearJobs();
    await Deno.remove(dir, { recursive: true });
    dir = await Deno.makeTempDir({ prefix: "denext_job_install_" });
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await Deno.mkdir(join(dir, "jobs"));
    await Deno.writeTextFile(
      join(dir, "jobs/manual.ts"),
      `import { defineJob } from "${new URL("../src/server/jobs.ts", import.meta.url).href}";\n` +
        `export default defineJob({ handler: () => {} });\n`,
    );
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      `export default { scheduledJobs: { "0 1 * * *": "missing" } };\n`,
    );
    // No `denext` / `offsets`: the verb works out this machine's own (the fake host still
    // stands in for the scheduler).
    const none = await verb(dir, new FakeHost("linux", "/home/u"), ["install"], {}, {});
    assertEquals(none.code, 0);
    assertStringIncludes(none.text, `denext: scheduledJobs names "missing"`);
    assertStringIncludes(none.text, "No scheduled jobs to install.");
  } finally {
    clearJobs();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext job <name> --if-due runs the job only in a matching minute", async () => {
  const dir = await project();
  const ran = join(dir, "ran.txt");
  const exists = () => Deno.stat(ran).then(() => true, () => false);
  try {
    // February 31st never comes.
    await quietly(() => jobCommand.run(ctxFor(dir, ["cleanup"], { "if-due": "0 0 31 2 *" })));
    assertFalse(await exists());
    await quietly(() =>
      jobCommand.run(ctxFor(dir, ["cleanup"], { "if-due": "0 0 31 2 *;* * * * *" }))
    );
    assert(await exists());
    const bad = await quietly(() => jobCommand.run(ctxFor(dir, ["cleanup"], { "if-due": "nope" })));
    assertEquals(bad.codes, [1]);
  } finally {
    clearJobs();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("--status lists this project's entries per scheduler, changing nothing", async () => {
  const dir = await project();
  const host = new FakeHost("darwin", "/Users/u");
  try {
    const before = await verb(dir, host, ["install"], { status: true });
    assertEquals(before.code, 0);
    assertStringIncludes(before.text, "Nothing of this project's is installed (launchd).");
    assertEquals((await verb(dir, host, ["install"])).code, 0);
    // A stale entry (a job since deleted) shows by its slug, with no job name.
    const id = await projectId(await Deno.realPath(dir));
    host.files.set(
      `/Users/u/Library/LaunchAgents/dev.denext.job.${id}.gone.plist`,
      `<!-- denext-managed project=${id} job=gone -->`,
    );
    host.ran.length = 0;
    const files = host.files.size;
    const text = await verb(dir, host, ["install"], { status: true });
    assertStringIncludes(text.text, "installed cleanup (launchd)");
    assertStringIncludes(text.text, "installed gone (launchd) — no scheduled job of that name");
    const json = await verb(dir, host, ["install"], { status: true }, undefined, true);
    assertEquals(JSON.parse(json.text), {
      backend: "launchd",
      scope: "user",
      os: "darwin",
      installed: [
        { backend: "launchd", slug: "cleanup", job: "cleanup" },
        { backend: "launchd", slug: "gone" },
      ],
      warnings: [],
    });
    assertEquals(host.changes(), [], "a status read changes nothing");
    assertEquals(host.files.size, files);
    // --status is a read: with --uninstall or job names it is refused.
    const mixed = await verb(dir, host, ["install"], { status: true, uninstall: true });
    assertEquals(mixed.code, 1);
    assertStringIncludes(mixed.text, "--status takes no --uninstall, --dry-run or job names");
  } finally {
    clearJobs();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("--status says when this machine has no scheduler for the scope", async () => {
  const dir = await project();
  const host = new FakeHost("linux", "/home/u");
  host.systemdSystem = false;
  try {
    const out = await verb(dir, host, ["install"], { status: true, system: true }, undefined, true);
    assertEquals(out.code, 0);
    assertEquals(JSON.parse(out.text).backend, null);
    const text = await verb(dir, host, ["install"], { status: true, system: true });
    assertStringIncludes(text.text, "No system scheduler here (linux).");
  } finally {
    clearJobs();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("--json carries the fallback-command warning an install prints in text", async () => {
  const dir = await project();
  try {
    const out = await verb(dir, new FakeHost("linux", "/home/u"), ["install"], {
      "dry-run": true,
    }, {
      offsets: [0],
      denext: { argv: ["/cache/deno", "run", "-A", "cli.ts"], warning: "no installed denext" },
    }, true);
    assertEquals(JSON.parse(out.text).warning, "no installed denext");
  } finally {
    clearJobs();
    await Deno.remove(dir, { recursive: true });
  }
});
