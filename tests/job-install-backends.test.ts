// `denext job install`'s backends one by one, against the fake scheduler host: the calendars each
// one writes for every day selector, the system scope, the tool failures and refusals, and the
// uninstall paths. Nothing is installed: every tool run is answered by the fake.

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { crontabBackend } from "../src/cli/job-install/crontab.ts";
import type { RunOptions, SchedulerTool, ToolResult } from "../src/cli/job-install/host.ts";
import { denextCommand, jobSlug, runJobInstall } from "../src/cli/job-install/install.ts";
import { launchdBackend, launchdIntervals } from "../src/cli/job-install/launchd.ts";
import { schtasksBackend } from "../src/cli/job-install/schtasks.ts";
import {
  type BackendContext,
  check,
  type EntrySpec,
  markedSlug,
  marker,
  pad2,
  xmlEscape,
} from "../src/cli/job-install/spec.ts";
import { onCalendarValues, systemdBackend } from "../src/cli/job-install/systemd.ts";
import { ScheduleTranslationError, translateSchedules } from "../src/cli/job-install/translate.ts";
import { FakeHost, ID, OTHER_ID, PROJECT, request } from "./_job-install-fake.ts";

/** The fake host, with chosen tool runs answering a failure instead. */
class FailingHost extends FakeHost {
  /** `"<tool> <first args>"` prefix → the result that run gets. */
  readonly failures = new Map<string, ToolResult>();
  /** Paths whose read answers `null` although the directory lists them. */
  readonly unreadable = new Set<string>();

  override run(
    tool: SchedulerTool,
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<ToolResult> {
    const line = `${tool} ${args.join(" ")}`;
    for (const [prefix, result] of this.failures) {
      if (line.startsWith(prefix)) {
        this.ran.push({ tool, args });
        return Promise.resolve(result);
      }
    }
    return super.run(tool, args, options);
  }
  override readTextFile(path: string): Promise<string | null> {
    return this.unreadable.has(path) ? Promise.resolve(null) : super.readTextFile(path);
  }
}

const failed = (stderr: string, code = 1): ToolResult => ({ code, stdout: "", stderr });

/** One job's entry, translated at UTC. */
function entry(job: string, crons: string[]): EntrySpec {
  return {
    job,
    slug: jobSlug(job),
    crons,
    schedule: translateSchedules(crons, [0]),
    argv: ["/opt/denext", "job", job],
    logFile: `${PROJECT}/.denext/logs/${jobSlug(job)}.log`,
  };
}

/** The backend context for the test project. */
function ctx(over: Partial<BackendContext> = {}): BackendContext {
  return { project: request().project, scope: "user", ...over };
}

/** The text of a written file (Task Scheduler's is UTF-16LE with a BOM). */
function textOf(data: string | Uint8Array | undefined): string {
  if (data === undefined || typeof data === "string") return data ?? "";
  return new TextDecoder("utf-16le").decode(data.subarray(2));
}

Deno.test("spec: the marker round-trips for its own project only; check names the failure", () => {
  assertEquals(markedSlug(`# ${marker(ID, "cleanup")}`, ID), "cleanup");
  assertEquals(markedSlug(`# ${marker(OTHER_ID, "cleanup")}`, ID), null);
  assertEquals(markedSlug("no marker here", ID), null);
  assertEquals(markedSlug("denext-managed project=zz job=x", ID), null);
  check({ code: 0, stdout: "", stderr: "ignored" }, "anything");
  const messageOf = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      return (err as Error).message;
    }
    return "";
  };
  assertEquals(
    messageOf(() => check({ code: 2, stdout: "", stderr: "  bad thing\n" }, "crontab -")),
    "denext: crontab - failed (exit 2): bad thing",
  );
  assertEquals(
    messageOf(() => check({ code: 1, stdout: "only stdout", stderr: "" }, "schtasks /Query")),
    "denext: schtasks /Query failed (exit 1): only stdout",
  );
  assertEquals(
    messageOf(() => check({ code: 5, stdout: " ", stderr: "" }, "systemctl enable")),
    "denext: systemctl enable failed (exit 5)",
  );
  assertEquals(
    xmlEscape(`<a href="x">Tom & 'Jerry'</a>`),
    "&lt;a href=&quot;x&quot;&gt;Tom &amp; &apos;Jerry&apos;&lt;/a&gt;",
  );
  assertEquals([pad2(0), pad2(7), pad2(42), pad2(123)], ["00", "07", "42", "123"]);
});

Deno.test("launchd: every day selector, the empty dictionary, and the system scope", async () => {
  const intervals = (cron: string) =>
    launchdIntervals(translateSchedules([cron], [0]).rules, [cron]);
  assertEquals(intervals("* * * * *"), [{}]);
  assertEquals(intervals("0 9 1 6 *"), [{ Month: 6, Day: 1, Hour: 9, Minute: 0 }]);
  assertEquals(intervals("30 * * * 1"), [{ Weekday: 1, Minute: 30 }]);
  assertEquals(intervals("0 9 1 * 1"), [
    { Day: 1, Hour: 9, Minute: 0 },
    { Weekday: 1, Hour: 9, Minute: 0 },
  ]);
  assertEquals(intervals("0 9 * 6 *"), [{ Month: 6, Hour: 9, Minute: 0 }]);

  const host = new FakeHost("darwin", "/Users/u", { SUDO_USER: "alice", USER: "root" });
  await runJobInstall(
    request({ scope: "system", schedules: [{ cron: "* * * * *", job: "cleanup" }] }),
    host,
  );
  const path = `/Library/LaunchDaemons/dev.denext.job.${ID}.cleanup.plist`;
  const plist = String(host.files.get(path));
  assertStringIncludes(plist, "<key>UserName</key>\n  <string>alice</string>");
  assertStringIncludes(plist, "    <dict/>");
  assertEquals(host.changes().map((r) => r.args.join(" ")), [`bootstrap system ${path}`]);
});

Deno.test("launchd: --system needs an account to run as", async () => {
  await assertRejects(
    () => runJobInstall(request({ scope: "system" }), new FakeHost("darwin", "/Users/u")),
    Error,
    "--system needs $USER",
  );
});

Deno.test("launchd: unreadable and foreign files are not ours; a failed bootstrap says why", async () => {
  const host = new FailingHost("darwin", "/Users/u");
  const agents = "/Users/u/Library/LaunchAgents";
  const unreadable = `${agents}/dev.denext.job.${ID}.gone.plist`;
  const notPlist = `${agents}/dev.denext.job.${ID}.notes.txt`;
  host.files.set(unreadable, `<!-- ${marker(ID, "gone")} -->`);
  host.unreadable.add(unreadable);
  host.files.set(notPlist, `<!-- ${marker(ID, "notes")} -->`);
  assertEquals(await launchdBackend.list(host, ctx()), []);
  // Removing a slug that isn't installed does nothing.
  await launchdBackend.remove(host, ctx(), ["ghost"]);
  assertEquals(host.ran, []);
  host.failures.set("launchctl bootstrap", failed("Bootstrap failed: 5: Input/output error"));
  const err = await assertRejects(
    () => launchdBackend.install(host, ctx(), [entry("cleanup", ["0 3 * * *"])]),
    Error,
    "launchctl bootstrap",
  );
  assertStringIncludes(err.message, "Input/output error");
});

Deno.test("systemd: either-day and month calendars, XDG_CONFIG_HOME, re-install and uninstall", async () => {
  const values = (cron: string) => onCalendarValues(translateSchedules([cron], [0]).rules);
  assertEquals(values("0 9 1 * 1"), ["*-*-01 09:00:00 UTC", "Mon *-*-* 09:00:00 UTC"]);
  assertEquals(values("0 9 * 6 *"), ["*-06-* 09:00:00 UTC"]);

  const host = new FakeHost("linux", "/home/u", { XDG_CONFIG_HOME: "/cfg" });
  const dir = "/cfg/systemd/user";
  host.files.set(`${dir}/unrelated.timer`, "[Timer]");
  host.files.set(`${dir}/denext-job-${ID}-cleanup.service`, `# ${marker(ID, "cleanup")}`);
  await runJobInstall(request(), host);
  const nested = jobSlug("reports/daily");
  assert(host.files.has(`${dir}/denext-job-${ID}-cleanup.timer`));
  assertEquals(await systemdBackend.list(host, ctx()), ["cleanup", nested].sort());
  host.ran.length = 0;

  // The named job only: its units go, the other job's stay.
  const one = await runJobInstall(request({ mode: "uninstall", names: ["cleanup"] }), host);
  assertEquals(one.removed, [{ backend: "systemd", slug: "cleanup" }]);
  assertEquals(host.changes().map((r) => r.args.join(" ")), [
    `--user disable --now denext-job-${ID}-cleanup.timer`,
    "--user daemon-reload",
  ]);
  assertFalse(host.files.has(`${dir}/denext-job-${ID}-cleanup.timer`));
  assertFalse(host.files.has(`${dir}/denext-job-${ID}-cleanup.service`));
  assert(host.files.has(`${dir}/denext-job-${ID}-${nested}.timer`));
  assert(host.files.has(`${dir}/unrelated.timer`));

  // Nothing to remove, nothing to install: no systemctl run at all.
  host.ran.length = 0;
  await systemdBackend.remove(host, ctx(), ["ghost"]);
  await systemdBackend.install(host, ctx(), []);
  assertEquals(host.changes(), []);
  assertFalse(await systemdBackend.available(new FakeHost("darwin", "/Users/u"), ctx()));
});

Deno.test("systemd: a failed systemctl stops the install with its message", async () => {
  const host = new FailingHost("linux", "/home/u");
  host.failures.set("systemctl --user enable", failed("Unit file is masked."));
  await assertRejects(
    () => runJobInstall(request(), host),
    Error,
    "systemctl enable failed (exit 1): Unit file is masked.",
  );
  host.failures.clear();
  await runJobInstall(request(), host);
  host.failures.set("systemctl --user daemon-reload", failed("Access denied"));
  await assertRejects(
    () => runJobInstall(request({ mode: "uninstall" }), host),
    Error,
    "systemctl daemon-reload failed",
  );
});

Deno.test("Linux --system takes systemd only; with no system manager it is refused", async () => {
  const host = new FakeHost("linux", "/home/u", { USER: "bob" });
  await runJobInstall(request({ scope: "system" }), host);
  const service = String(host.files.get(`/etc/systemd/system/denext-job-${ID}-cleanup.service`));
  assertStringIncludes(service, "User=bob");
  assert(host.changes().every((r) => r.args[0] !== "--user"));
  const down = new FakeHost("linux", "/home/u", { USER: "bob" });
  down.systemdSystem = false;
  const err = await assertRejects(
    () => runJobInstall(request({ scope: "system" }), down),
    Error,
    "no system scheduler here (linux)",
  );
  assertFalse(err.message.includes("crontab"));
  await assertRejects(
    () => runJobInstall(request(), new FakeHost("freebsd", "/home/u")),
    Error,
    "no user scheduler here (freebsd): launchd on macOS, a systemd user manager or crontab",
  );
});

Deno.test("crontab: no crontab program, a failing one, and remove without a crontab", async () => {
  const none = new FakeHost("linux", "/home/u");
  none.crontab = null;
  assertFalse(await crontabBackend.available(none, ctx()));
  assertEquals(await crontabBackend.list(none, ctx()), []);
  await crontabBackend.remove(none, ctx(), ["cleanup"]);
  // `crontab -` on a machine without crontab: the install says so.
  await assertRejects(
    () => crontabBackend.install(none, ctx(), [entry("cleanup", ["0 3 * * *"])]),
    Error,
    "crontab - failed (exit 127)",
  );
  assertFalse(await crontabBackend.available(new FakeHost("windows", "C:\\Users\\u"), ctx()));
  assertFalse(
    await crontabBackend.available(new FakeHost("linux", "/home/u"), ctx({ scope: "system" })),
  );

  const broken = new FailingHost("linux", "/home/u");
  broken.failures.set("crontab -l", failed("crontab: permission denied", 1));
  await assertRejects(
    () => crontabBackend.available(broken, ctx()),
    Error,
    "crontab -l failed (exit 1): crontab: permission denied",
  );
  const refused = new FailingHost("linux", "/home/u");
  refused.failures.set("crontab -", failed("crontab: errors in crontab file"));
  await assertRejects(
    () => crontabBackend.install(refused, ctx(), [entry("cleanup", ["0 3 * * *"])]),
    Error,
    "errors in crontab file",
  );
});

Deno.test("Task Scheduler: every day selector's schedule element", async () => {
  const host = new FakeHost("windows", "C:\\Users\\u", { USERNAME: "u", USERDOMAIN: "CORP" });
  const xmlOf = async (cron: string) => {
    await schtasksBackend.install(host, ctx(), [entry("cleanup", [cron])]);
    const create = host.ran.findLast((r) => r.args[0] === "/Create");
    assert(create);
    // The XML file is removed after /Create; the fake keeps what was written in `written`.
    return written.get(create.args[create.args.indexOf("/XML") + 1]) ?? "";
  };
  const written = new Map<string, string>();
  const write = host.writeFile.bind(host);
  host.writeFile = (path, data) => {
    written.set(path, textOf(data));
    return write(path, data);
  };
  const dom = await xmlOf("0 9 1,15 6 *");
  assertStringIncludes(
    dom,
    "<ScheduleByMonth><DaysOfMonth><Day>1</Day><Day>15</Day></DaysOfMonth>",
  );
  assertStringIncludes(dom, "<Months><June /></Months>");
  assertStringIncludes(dom, "<UserId>CORP\\u</UserId>");
  assertStringIncludes(dom, "<LogonType>InteractiveToken</LogonType>");
  const weekly = await xmlOf("0 9 * * 1,5");
  assertStringIncludes(
    weekly,
    "<ScheduleByWeek><WeeksInterval>1</WeeksInterval><DaysOfWeek><Monday /><Friday /></DaysOfWeek>",
  );
  const monthWeekday = await xmlOf("0 9 * 1,12 0");
  assertStringIncludes(monthWeekday, "<ScheduleByMonthDayOfWeek><Weeks><Week>1</Week>");
  assertStringIncludes(
    monthWeekday,
    "<Week>Last</Week></Weeks><DaysOfWeek><Sunday /></DaysOfWeek>",
  );
  assertStringIncludes(monthWeekday, "<Months><January /><December /></Months>");
  const monthOnly = await xmlOf("0 9 * 3 *");
  assertStringIncludes(monthOnly, "<Day>1</Day>");
  assertStringIncludes(monthOnly, "<Day>31</Day></DaysOfMonth><Months><March /></Months>");
  const either = await xmlOf("0 9 1 * 1");
  assertStringIncludes(either, "<Day>1</Day></DaysOfMonth><Months><January />");
  assertStringIncludes(either, "<December /></Months></ScheduleByMonth>");
  assertStringIncludes(either, "<DaysOfWeek><Monday /></DaysOfWeek></ScheduleByWeek>");
  assertEquals(either.match(/<CalendarTrigger>/g)?.length, 2);
});

Deno.test("Task Scheduler: --system is S4U; too many triggers is refused; tool failures", async () => {
  const host = new FakeHost("windows", "C:\\Users\\u", { USERNAME: "u" });
  const written: string[] = [];
  const write = host.writeFile.bind(host);
  host.writeFile = (path, data) => {
    written.push(textOf(data));
    return write(path, data);
  };
  // Windows needs no $USER for --system: the task runs as the installing account.
  await runJobInstall(
    request({ scope: "system", schedules: [{ cron: "0 3 * * *", job: "cleanup" }] }),
    host,
  );
  assertStringIncludes(written[0], "<LogonType>S4U</LogonType>");
  assertStringIncludes(written[0], "<UserId>u</UserId>");
  assertEquals(host.files.size, 0, "the XML file is removed after /Create");

  const scattered = "1,2,4,7,11,16,22,29,37,46,56 0-22 * * *";
  let refused: unknown;
  try {
    schtasksBackend.validate(entry("cleanup", [scattered]));
  } catch (err) {
    refused = err;
  }
  assert(refused instanceof ScheduleTranslationError);
  assertStringIncludes(refused.message, "Task Scheduler triggers (at most 48)");

  const failing = new FailingHost("windows", "C:\\Users\\u");
  failing.failures.set("schtasks /Query", failed("ERROR: Access is denied."));
  await assertRejects(
    () => schtasksBackend.list(failing, ctx()),
    Error,
    "schtasks /Query failed (exit 1): ERROR: Access is denied.",
  );
  failing.failures.clear();
  failing.failures.set("schtasks /Create", failed("ERROR: The task XML is malformed."));
  await assertRejects(
    () => schtasksBackend.install(failing, ctx(), [entry("cleanup", ["0 3 * * *"])]),
    Error,
    "The task XML is malformed.",
  );
  assertEquals(failing.files.size, 0, "the XML file is removed even when /Create fails");
  failing.failures.clear();
  failing.failures.set("schtasks /Delete", failed("ERROR: The system cannot find the file."));
  await assertRejects(
    () => schtasksBackend.remove(failing, ctx(), ["cleanup"]),
    Error,
    `schtasks /Delete \\denext\\${ID}\\cleanup failed`,
  );
});

Deno.test("an invalid cron is refused with nothing changed", async () => {
  const host = new FakeHost("darwin", "/Users/u");
  await assertRejects(
    () => runJobInstall(request({ schedules: [{ cron: "61 * * * *", job: "cleanup" }] }), host),
    Error,
    "out of range",
  );
  assertEquals(host.changes(), []);
  assertEquals(host.files.size, 0);
});

Deno.test("denextCommand without any home names $DENEXT_INSTALL in its warning", () => {
  const fallback = denextCommand({
    os: "linux",
    env: () => undefined,
    standalone: false,
    execPath: "/cache/deno",
    cliModule: "/src/cli.ts",
    isFile: () => true,
  });
  assertEquals(fallback.argv, ["/cache/deno", "run", "-A", "/src/cli.ts"]);
  assertStringIncludes(fallback.warning ?? "", "no installed denext binary at $DENEXT_INSTALL/bin");
  const profile = denextCommand({
    os: "windows",
    env: (n) => (n === "USERPROFILE" ? "C:\\Users\\u" : undefined),
    standalone: false,
    execPath: "C:\\deno.exe",
    cliModule: "C:\\src\\cli.ts",
    isFile: (p) => p.endsWith("denext.exe"),
  });
  assertEquals(profile.warning, undefined);
  assertStringIncludes(profile.argv[0], "denext.exe");
});
