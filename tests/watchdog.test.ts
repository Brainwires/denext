// tests/helpers/watchdog.ts: under `watchTests(ms)` a test that runs past `ms` fails, naming the
// subprocesses its file started that have not finished, instead of holding the run until the CI
// job's timeout; the file's other tests run as before.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { runBounded } from "./helpers/bounded-command.ts";
import { removeTempDir } from "./helpers/temp.ts";
import { exitedOutputForTest } from "./helpers/watchdog.ts";

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
    assertStringIncludes(r.output, "3 passed");
    assertStringIncludes(r.output, "1 failed");
    assertStringIncludes(r.output, "1 ignored");
    assertStringIncludes(r.output, "namedFunction");
    assert(Date.now() - t0 < 100_000, `took ${Date.now() - t0} ms`);
  } finally {
    await removeTempDir(dir);
  }
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
