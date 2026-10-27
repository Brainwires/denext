// tests/helpers/watchdog.ts: under `watchTests(ms)` a test that runs past `ms` fails, naming the
// subprocesses its file started that have not finished, instead of holding the run until the CI
// job's timeout; the file's other tests run as before.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { runBounded } from "./helpers/bounded-command.ts";
import { removeTempDir } from "./helpers/temp.ts";
import {
  boundArgsForTest,
  deadlineFrom,
  exitedOutputForTest,
  parseCimJson,
  parseGetProcess,
  parsePs,
  processSnapshot,
  processTree,
  registrationSite,
  stallMessage,
} from "./helpers/watchdog.ts";

const WATCHDOG = new URL("./helpers/watchdog.ts", import.meta.url).href;

/** A test file: one test stalls on a subprocess's output, the others finish. */
const STALLING = `import { watchTests } from ${JSON.stringify(WATCHDOG)};
watchTests(1_000);
Deno.test({ name: "stalls", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  await new Deno.Command(Deno.execPath(), {
    args: ["eval", "await new Promise((r) => setTimeout(r, 30000))"], stdout: "piped",
  }).output();
} });
Deno.test("finishes", async () => { await new Promise((r) => setTimeout(r, 10)); });
Deno.test("with options", { sanitizeOps: true }, () => {});
Deno.test(function namedFunction() {});
Deno.test.ignore("ignored", () => { throw new Error("ran"); });
`;

Deno.test("watchTests: a stalled test fails at its deadline, naming the open subprocess", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_watchdog_" });
  const file = join(dir, "stall.test.ts");
  await Deno.writeTextFile(file, STALLING);
  try {
    const t0 = Date.now();
    const r = await runBounded(Deno.execPath(), ["test", "-A", "--no-check", file], {
      timeoutMs: 120_000,
      env: { NO_COLOR: "1" },
    });
    assert(!r.timedOut, r.output);
    assert(!r.success, "the stalled test failed the run");
    assertStringIncludes(r.output, `"stalls" still running after 1 s`);
    assertStringIncludes(r.output, "Subprocesses this file started that have not finished:");
    assertStringIncludes(r.output, "eval await new Promise");
    // The open subprocess is said to be still running (not exited with its pipes held open), and
    // the OS's view of this test process's children is in the report.
    assertStringIncludes(r.output, "still running");
    assert(
      /Processes under this test process \(pid \d+\):\n\s+- pid \d+: .*eval/.test(r.output) ||
        r.output.includes("The OS listing has no parent pids here"),
      r.output,
    );
    assertStringIncludes(r.output, "3 passed");
    assertStringIncludes(r.output, "1 failed");
    assertStringIncludes(r.output, "1 ignored");
    assertStringIncludes(r.output, "namedFunction");
    // Every test is reported at its own registration in the test file, never at the wrapper, and
    // the stall names the file and line as well as the test.
    const located = r.output.split("\n").filter((l) => / => \S+:\d+:\d+$/.test(l));
    assert(located.length > 0, r.output);
    for (const line of located) {
      assert(!line.includes("watchdog.ts"), `reported at the wrapper: ${line}`);
      assertStringIncludes(line, "stall.test.ts:");
    }
    assertStringIncludes(r.output, "stall.test.ts:3:6");
    assert(/stall\.test\.ts:3:\d+: "stalls" still running/.test(r.output), r.output);
    assert(Date.now() - t0 < 100_000, `took ${Date.now() - t0} ms`);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("watchdog: a test's registration site is the first frame outside the wrapper", () => {
  const self = WATCHDOG;
  const stack = [
    "Error",
    `    at Object.test (${self}:401:5)`,
    `    at ${self}:12:3`,
    "    at file:///repo/tests/foo.test.ts:42:6",
    "    at ext:core/01_core.js:10:1",
  ].join("\n");
  assertEquals(registrationSite(stack), "file:///repo/tests/foo.test.ts:42:6");
  assertEquals(
    registrationSite(`Error\n    at x (${self}:1:1)\n    at y (file:///C:/a/b.test.ts:7:2)`),
    "file:///C:/a/b.test.ts:7:2",
  );
  assertEquals(registrationSite(`Error\n    at x (${self}:1:1)`), undefined);
  assertEquals(registrationSite(undefined), undefined);
  // The location rides on the wrapped function; a helper's own location (bdd) is kept.
  const [, fn] = boundArgsForTest(["t", () => {}], 0, "file:///x.test.ts:1:1") as [
    string,
    Record<symbol, unknown>,
  ];
  assertEquals(fn[Symbol.for("Deno.test.location")], "file:///x.test.ts:1:1");
  const own = Object.assign(() => {}, { [Symbol.for("Deno.test.location")]: "file:///own.ts:2:2" });
  const [def] = boundArgsForTest([{ name: "t", fn: own }], 1000, "file:///x.test.ts:1:1") as [
    { fn: Record<symbol, unknown> },
  ];
  assertEquals(def.fn[Symbol.for("Deno.test.location")], "file:///own.ts:2:2");
});

const PRELOAD = new URL("./helpers/watchdog-preload.ts", import.meta.url).href;

/** A test file that never opts in: one test stalls on a child that never ends. */
const UNWATCHED =
  `Deno.test({ name: "stalls", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  await new Deno.Command(Deno.execPath(), {
    args: ["eval", "await new Promise((r) => setTimeout(r, 120000))"],
  }).output();
} });
Deno.test("finishes", async () => {
  const out = await new Deno.Command(Deno.execPath(), { args: ["eval", "console.log(42)"] }).output();
  if (new TextDecoder().decode(out.stdout).trim() !== "42") throw new Error("output() changed");
});
`;

/** A test file that opts in under the preload: its own deadline, and no second wrapper. */
const OPTED_IN = `import { watchTests } from ${JSON.stringify(WATCHDOG)};
const before = Deno.test;
watchTests(1_000);
const same = Deno.test === before;
Deno.test("wrapped once", () => { if (!same) throw new Error("watchTests wrapped Deno.test again"); });
Deno.test({ name: "stalls", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  await new Promise((r) => setTimeout(r, 30000));
} });
`;

/** Run `source` as a test file with the global watchdog preloaded and `deadline` in the env. */
async function runPreloaded(source: string, deadline: string) {
  const dir = await Deno.makeTempDir({ prefix: "denext_watchdog_global_" });
  const file = join(dir, "global.test.ts");
  await Deno.writeTextFile(file, source);
  try {
    return await runBounded(
      Deno.execPath(),
      ["test", "-A", "--no-check", "--preload", PRELOAD, file],
      { timeoutMs: 150_000, env: { NO_COLOR: "1", DENEXT_TEST_DEADLINE_MS: deadline } },
    );
  } finally {
    await removeTempDir(dir);
  }
}

Deno.test("watchdog preload: a file that never calls watchTests still fails a stalled test at the deadline", async () => {
  const t0 = Date.now();
  // Far enough off that the other test's own `deno eval` finishes first on a loaded machine.
  const r = await runPreloaded(UNWATCHED, "15000");
  assert(!r.timedOut, r.output);
  assert(!r.success, "the stalled test failed the run");
  assertStringIncludes(r.output, `"stalls" still running after 15 s`);
  assertStringIncludes(r.output, "Subprocesses this file started that have not finished:");
  assertStringIncludes(r.output, "eval await new Promise");
  assertStringIncludes(r.output, "still running");
  // output() keeps its own semantics under the global watchdog.
  assertStringIncludes(r.output, "1 passed");
  assertStringIncludes(r.output, "1 failed");
  assert(Date.now() - t0 < 130_000, `took ${Date.now() - t0} ms`);
});

Deno.test("watchdog preload: a file's own watchTests(ms) sets its deadline without wrapping twice", async () => {
  // The preload's deadline is far off: only the file's own 1 s can fail the stalled test.
  const r = await runPreloaded(OPTED_IN, "600000");
  assert(!r.timedOut, r.output);
  assertStringIncludes(r.output, `"stalls" still running after 1 s`);
  assertStringIncludes(
    r.output,
    "No subprocess of this file is open: the stall is in this process.",
  );
  assertStringIncludes(r.output, "1 passed");
  assertStringIncludes(r.output, "1 failed");
});

Deno.test("watchdog preload: DENEXT_TEST_DEADLINE_MS sets the deadline, 0 turns it off", () => {
  assertEquals(deadlineFrom(undefined), 600_000);
  assertEquals(deadlineFrom(""), 600_000);
  assertEquals(deadlineFrom("abc"), 600_000);
  assertEquals(deadlineFrom("-5"), 600_000);
  assertEquals(deadlineFrom("1.5"), 600_000);
  assertEquals(deadlineFrom("1800000"), 1_800_000);
  assertEquals(deadlineFrom("0"), 0);
});

Deno.test("watchTests: output() returns shortly after the child exits while another process holds its stdout", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_watchdog_held_" });
  const pidFile = join(dir, "pid");
  // The child starts a grandchild that inherits its stdout and outlives it (detached: on Windows an
  // attached one is in a job object killed with its parent), then exits.
  const script = join(dir, "exits.ts");
  await Deno.writeTextFile(
    script,
    `const g = new Deno.Command(Deno.execPath(), { args: ["eval", ` +
      `"await new Promise((r) => setTimeout(r, 120000))"], stdout: "inherit", detached: true }).spawn();\n` +
      `Deno.writeTextFileSync(${JSON.stringify(pidFile)}, String(g.pid));\n` +
      `console.log("written before the exit");\nDeno.exit(3);\n`,
  );
  try {
    const t0 = Date.now();
    const out = await exitedOutputForTest(Deno.execPath(), { args: ["run", "-A", script] }, 1_000);
    assertEquals([out.success, out.code], [false, 3]);
    assertStringIncludes(new TextDecoder().decode(out.stdout), "written before the exit");
    assertEquals(new TextDecoder().decode(out.stderr), "");
    assert(Date.now() - t0 < 60_000, `took ${Date.now() - t0} ms`);
    // A pipe the caller did not ask for reads as `Deno.CommandOutput` reports it: not piped.
    const quiet = await exitedOutputForTest(Deno.execPath(), {
      args: ["eval", "1"],
      stdout: "null",
    }, 1_000);
    assertThrows(() => quiet.stdout, TypeError, "stdout is not piped");
  } finally {
    try {
      Deno.kill(Number(await Deno.readTextFile(pidFile)), "SIGKILL");
    } catch { /* gone, or never started */ }
    await removeTempDir(dir);
  }
});

Deno.test("watchdog: the OS process listings parse into pid, parent and command", () => {
  assertEquals(parsePs("  1     0 /sbin/launchd\n 4242   1 deno test -A x.ts\n\n"), [
    { pid: 1, ppid: 0, command: "/sbin/launchd" },
    { pid: 4242, ppid: 1, command: "deno test -A x.ts" },
  ]);
  assertEquals(
    parseCimJson(
      '[{"ProcessId":4,"ParentProcessId":0,"Name":"System","CommandLine":null},' +
        '{"ProcessId":9,"ParentProcessId":4,"Name":"deno.exe","CommandLine":"deno doc --json a.ts"}]',
    ),
    [
      { pid: 4, ppid: 0, command: "System" },
      { pid: 9, ppid: 4, command: "deno doc --json a.ts" },
    ],
  );
  assertEquals(parseCimJson('{"ProcessId":7,"ParentProcessId":1,"CommandLine":"x"}'), [
    { pid: 7, ppid: 1, command: "x" },
  ]);
  assertEquals(parseGetProcess("9872,deno\r\n956,esbuild\r\n\r\n"), [
    { pid: 9872, command: "deno" },
    { pid: 956, command: "esbuild" },
  ]);
});

Deno.test("watchdog: processTree lists the descendants of a pid, indented, and nothing else", () => {
  const rows = [
    { pid: 1, ppid: 0, command: "init" },
    { pid: 10, ppid: 1, command: "deno test" },
    { pid: 11, ppid: 10, command: "esbuild --service" },
    { pid: 12, ppid: 11, command: "conhost" },
    { pid: 13, ppid: 10, command: "x".repeat(400) },
    { pid: 20, ppid: 1, command: "unrelated" },
    { pid: 30, command: "no parent known" },
  ];
  const tree = processTree(rows, 10);
  assertEquals(tree.slice(0, 2), ["  - pid 11: esbuild --service", "    - pid 12: conhost"]);
  assertEquals(tree.length, 3);
  assert(tree[2].startsWith("  - pid 13: xxx") && tree[2].endsWith("…"), tree[2]);
  assertEquals(processTree(rows, 20), []);
});

Deno.test("watchdog: the stall report says when the OS listing is missing or has no children", async () => {
  const none = await stallMessage("t", 1_000, () => Promise.resolve([]));
  assertStringIncludes(none, '"t" still running after 1 s');
  assertStringIncludes(none, "The process list could not be read.");
  const failing = await stallMessage("t", 1_000, () => Promise.reject(new Error("no ps")));
  assertStringIncludes(failing, "The process list could not be read.");
  const noKids = await stallMessage(
    "t",
    1_000,
    () => Promise.resolve([{ pid: Deno.pid, ppid: 1, command: "deno" }]),
  );
  assertStringIncludes(noKids, `No process is running under this test process (pid ${Deno.pid}).`);
  const noParents = await stallMessage(
    "t",
    1_000,
    () => Promise.resolve([{ pid: Deno.pid, command: "deno.exe" }]),
  );
  assertStringIncludes(noParents, "The OS listing has no parent pids here");
  const tree = await stallMessage(
    "t",
    1_000,
    () => Promise.resolve([{ pid: 77, ppid: Deno.pid, command: "deno doc --json a.ts" }]),
  );
  assertStringIncludes(
    tree,
    `Processes under this test process (pid ${Deno.pid}):\n  - pid 77: deno doc`,
  );
});

Deno.test("watchdog: processSnapshot lists this process", async () => {
  const rows = await processSnapshot();
  // Windows without admin rights falls back to Get-Process (no parents); every listing has this pid.
  assert(rows.some((r) => r.pid === Deno.pid), `pid ${Deno.pid} missing from ${rows.length} rows`);
});
