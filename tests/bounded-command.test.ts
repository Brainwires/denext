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
import { boundedOutput, processTree, renderTree, runBounded } from "./helpers/bounded-command.ts";
import { inChild, pendingSpawns } from "./helpers/isolated.ts";
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
    // The tree as it stood at the deadline names the child and the grandchild it waited on.
    assertStringIncludes(r.tree, `${r.pid} `, r.tree);
    // (Command lines need Win32_Process, which a non-admin remote Windows session is refused.)
    if (!r.tree.includes("Win32_Process refused")) {
      assertStringIncludes(r.tree, "Deno.listen", r.tree);
    }
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
  assertStringIncludes(err.message, "Its process tree at the deadline:\n");
});

Deno.test("processTree: a process that finished reads as gone, and the listing never waits past its bound", async () => {
  const done = new Deno.Command(Deno.execPath(), { args: ["eval", ""], stdout: "null" }).spawn();
  await done.status;
  const gone = await processTree(done.pid, undefined, Deno.execPath());
  assert(gone.endsWith(`(pid ${done.pid} and its descendants are gone)`), gone);
  // This process: listed with its command line.
  assertStringIncludes(await processTree(Deno.pid), `${Deno.pid} `);
  // A listing given no time is abandoned with the reason, not awaited. The lister can still exit
  // before a 0 ms timer fires on a busy event loop, and then its listing is the answer.
  const hurried = await processTree(Deno.pid, 0);
  if (!/^\(no process list: .+ still running after 0 ms\)$/.test(hurried)) {
    assertStringIncludes(hurried, `${Deno.pid} `);
  }
});

Deno.test("renderTree: a recycled pid held by a look-alike process reads as gone", () => {
  // The listing in this OS's processListCommand shape (ps columns, or Win32_Process's tab rows).
  const list = ([
    [900, 1, "deno test --parallel tests/"],
    [901, 900, "deno info --json x"],
    [950, 1, "deno eval ok"],
  ] as const).map(([pid, ppid, command]) =>
    Deno.build.os === "windows"
      ? `${pid}\t${ppid}\tstarted 20261031 cpu 0.1s threads 4 handles 90\t${command}`
      : `  ${pid}  ${String(ppid).padStart(4)} 00:01 00:00 S    ${command}`
  ).join("\n");
  const gone = "(pid 900 and its descendants are gone)";
  // The id now belongs to the long-running test run: not the child, nor are its children.
  assertEquals(renderTree(list, 900, "/bin/sleep"), gone);
  // Without an identity to check, the id is taken at face value.
  assertStringIncludes(renderTree(list, 900), "901 (parent 900)");
  // The same process still matches, and a pid with no row is gone.
  assertStringIncludes(renderTree(list, 950, "deno eval"), "950  ");
  assertEquals(renderTree(list, 777, "deno"), "(pid 777 and its descendants are gone)");
});

Deno.test("pendingSpawns: a spawn with no exit and an output() with no end are unfinished", () => {
  const trace = [
    "t start #1 pid 10: deno info --json a",
    "t exit #1 pid 10 code 0",
    "t start #2 output(): deno info --json b",
    "t start #3 pid 12: esbuild --service",
    "t start #4 output(): deno doc c",
    "t end #4",
  ].join("\n");
  assertEquals(
    pendingSpawns(trace),
    "t start #2 output(): deno info --json b\nt start #3 pid 12: esbuild --service",
  );
  assertEquals(pendingSpawns(""), "");
});

Deno.test("inChild: a child killed at its deadline names the subprocess it waited on", async () => {
  const err = await assertRejects(
    () =>
      inChild({
        body: `await new Deno.Command(Deno.execPath(), {
          args: ["eval", "await new Promise(() => setInterval(() => {}, 1000)); // denext-stalled-grandchild"],
          stdout: "piped",
        }).output();`,
        timeoutMs: DEADLINE_MS,
      }),
    Error,
  );
  assertStringIncludes(err.message, `child still running after ${DEADLINE_MS} ms`);
  // The trace: the output() that never returned, with its command line.
  assertMatch(
    err.message,
    /unfinished:\n\S+ start #1 output\(\): .+ eval .+denext-stalled-grandchild/,
  );
  // The tree: the grandchild, still alive at the deadline.
  const tree = err.message.slice(err.message.indexOf("Its process tree at the deadline:"));
  if (!tree.includes("Win32_Process refused")) {
    assertStringIncludes(tree, "denext-stalled-grandchild", tree);
  }
});
