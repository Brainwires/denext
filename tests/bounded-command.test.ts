// tests/helpers/bounded-command.ts: a subprocess with a deadline. At the deadline the whole tree
// is killed, a grandchild holding the inherited pipes included, and the call returns with what
// the child printed — where `Deno.Command#output()` would wait for those pipes to close.

import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { boundedOutput, runBounded } from "./helpers/bounded-command.ts";
import { removeTempDir } from "./helpers/temp.ts";

/**
 * A script that spawns a grandchild (inheriting stdout) that listens on a loopback port for as long
 * as it lives and writes the port to `portFile`, says so once the port is on disk, then waits
 * forever itself.
 */
function hangingTree(portFile: string): string {
  const grandchild = `const l = Deno.listen({ hostname: "127.0.0.1", port: 0 }); ` +
    `Deno.writeTextFileSync(${JSON.stringify(portFile + ".tmp")}, String(l.addr.port)); ` +
    `Deno.renameSync(${JSON.stringify(portFile + ".tmp")}, ${JSON.stringify(portFile)}); ` +
    `for await (const c of l) c.close();`;
  return `new Deno.Command(Deno.execPath(), { args: ["eval", ${JSON.stringify(grandchild)}], ` +
    `stdout: "inherit", stderr: "inherit" }).spawn();\n` +
    `while (true) { try { Deno.statSync(${JSON.stringify(portFile)}); break; } catch { ` +
    `await new Promise((r) => setTimeout(r, 50)); } }\n` +
    `console.log("phase: waiting on the grandchild");\n` +
    `await new Promise(() => setInterval(() => {}, 1000));\n`;
}

/**
 * Whether the process listening on `port` has gone: its listener refuses a connection. Polled
 * until it does (a kill takes effect a moment after it is sent) or `ms` passes.
 */
async function listenerGone(port: number, ms = 30_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    try {
      (await Deno.connect({ hostname: "127.0.0.1", port })).close();
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Long enough for two Deno processes to start on a loaded machine. */
const DEADLINE_MS = 30_000;

Deno.test("runBounded: a child that finishes in time reports its exit and output", async () => {
  const r = await runBounded(Deno.execPath(), ["eval", "console.log('hi'); Deno.exit(3)"], {
    timeoutMs: 60_000,
  });
  assertEquals([r.success, r.timedOut], [false, false]);
  assertStringIncludes(r.output, "hi");
});

Deno.test("runBounded: at the deadline the whole tree is killed and the output so far returned", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_bounded_" });
  const portFile = join(dir, "port");
  const script = join(dir, "tree.ts");
  await Deno.writeTextFile(script, hangingTree(portFile));
  try {
    const t0 = Date.now();
    const r = await runBounded(Deno.execPath(), ["run", "-A", script], { timeoutMs: DEADLINE_MS });
    assert(r.timedOut, "the deadline passed");
    assertEquals(r.success, false);
    assertStringIncludes(r.output, "phase: waiting on the grandchild", "the tree was running");
    assert(
      Date.now() - t0 < DEADLINE_MS + 15_000,
      `returned ${Date.now() - t0} ms after the start`,
    );
    // The grandchild is gone: its listener refuses connections (a sign of its death, not a
    // heartbeat that a loaded machine may merely have slowed).
    assert(
      await listenerGone(Number(await Deno.readTextFile(portFile))),
      "the grandchild still runs",
    );
  } finally {
    await removeTempDir(dir);
  }
});

/**
 * A script that starts a grandchild holding its stdout (writing its pid to `pidFile`), says it is
 * done, and exits at once: the pipe stays open after the exit, as when a process another thread
 * spawned inherited this child's pipe handle. The grandchild is detached: on Windows Deno puts an
 * attached child in a job object that is killed with its parent.
 */
function exitingWithHeldPipes(pidFile: string): string {
  return `const g = new Deno.Command(Deno.execPath(), { args: ["eval", ` +
    `"await new Promise((r) => setTimeout(r, 120000))"], stdout: "inherit", stderr: "inherit", detached: true }).spawn();\n` +
    `Deno.writeTextFileSync(${JSON.stringify(pidFile)}, String(g.pid));\n` +
    `console.log("phase: done");\nDeno.exit(0);\n`;
}

Deno.test("runBounded: a child that exits while another process holds its pipes returns after a short drain", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_bounded_held_" });
  const pidFile = join(dir, "pid");
  const script = join(dir, "exits.ts");
  await Deno.writeTextFile(script, exitingWithHeldPipes(pidFile));
  try {
    const t0 = Date.now();
    const r = await runBounded(Deno.execPath(), ["run", "-A", script], {
      timeoutMs: 90_000,
      drainMs: 1_000,
    });
    assertEquals([r.success, r.timedOut, r.pipesHeld], [true, false, true]);
    assertStringIncludes(r.stdout, "phase: done");
    assertEquals(r.stderr, "");
    assert(Date.now() - t0 < 60_000, `returned ${Date.now() - t0} ms after the start`);
  } finally {
    try {
      Deno.kill(Number(await Deno.readTextFile(pidFile)), "SIGKILL");
    } catch { /* gone, or never started */ }
    await removeTempDir(dir);
  }
});

Deno.test("boundedOutput: a child that exits in time gives output()'s shape", async () => {
  const out = await boundedOutput(Deno.execPath(), {
    args: ["eval", "console.log('out'); console.error('err'); Deno.exit(4)"],
  });
  assertEquals([out.code, out.success, out.signal], [4, false, null]);
  assertEquals(new TextDecoder().decode(out.stdout), "out\n");
  assertEquals(new TextDecoder().decode(out.stderr), "err\n");
});

Deno.test("boundedOutput: a stalled child fails with its pid and what it printed", async () => {
  const err = await assertRejects(
    () =>
      boundedOutput(Deno.execPath(), {
        args: [
          "eval",
          "console.log('phase: stalled'); await new Promise(() => setInterval(() => {}, 1000));",
        ],
        timeoutMs: 15_000,
      }),
    Error,
  );
  assertMatch(err.message, /\(pid \d+\) still running after 15000 ms; its tree was killed/);
  assertStringIncludes(err.message, "phase: stalled");
});
