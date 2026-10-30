// `denext ui`'s subprocess runner: a child that never prints a newline (a `\r` progress bar,
// one huge blob) is streamed in bounded pieces instead of being held whole until it exits, and a
// child whose pipes outlive it (a process it left running, or on Windows one spawned elsewhere at
// the same moment, holds them) is read until it exits, not until they close.

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cliConfigArgs, cliInvocation, runDeno } from "../src/ui/proc.ts";
import { parseJsonDocument } from "../src/ui/child-json.ts";
import { exited, spawnsOf } from "./helpers/spawns.ts";
import { removeTempDir } from "./helpers/temp.ts";

Deno.test("runDeno: output with no newline arrives in bounded pieces", async () => {
  const lines: string[] = [];
  const cwd = await Deno.makeTempDir({ prefix: "denext-proc-" });
  try {
    const program = "await new Blob(['x'.repeat(300000)]).stream().pipeTo(Deno.stdout.writable)";
    const result = await runDeno(["eval", program], {
      cwd,
      onLine: (line) => void lines.push(line),
    });
    assertEquals(result.code, 0);
    assertEquals(lines.join("").length, 300_000, "every byte arrives");
    assert(lines.length > 1, "split into several pieces");
    assert(lines.every((line) => line.length <= 128 * 1024), "each piece is bounded");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

/**
 * A `deno eval` program that leaves a 60 s grandchild holding its stdout and stderr (written to
 * `pidFile`, for cleanup), prints `out` and `err`, and exits 3. The grandchild is Deno itself, so
 * this holds the pipes the same way on every OS.
 */
function heldPipesProgram(pidFile: string): string {
  return `const g = new Deno.Command(Deno.execPath(), {
  args: ["eval", "setTimeout(() => {}, 60000)"], stdin: "null", stdout: "inherit", stderr: "inherit",
}).spawn();
Deno.writeTextFileSync(${JSON.stringify(pidFile)}, String(g.pid));
g.unref();
console.log("out");
console.error("err");
Deno.exit(3);`;
}

/** Kill the grandchild whose pid {@linkcode heldPipesProgram} wrote. */
async function killHolder(pidFile: string): Promise<void> {
  try {
    Deno.kill(Number((await Deno.readTextFile(pidFile)).trim()), "SIGKILL");
  } catch { /* gone, or never started */ }
}

for (const streaming of [true, false]) {
  Deno.test(
    `runDeno: returns once the child exits while a process it left holds its pipes (${
      streaming ? "streamed" : "collected"
    })`,
    async () => {
      const cwd = await Deno.makeTempDir({ prefix: "denext-proc-held-" });
      const pidFile = join(cwd, "pid");
      const lines: string[] = [];
      try {
        const t0 = Date.now();
        const result = await runDeno(["eval", heldPipesProgram(pidFile)], {
          cwd,
          onLine: streaming ? (line) => void lines.push(line.trimEnd()) : undefined,
        });
        const took = Date.now() - t0;
        assert(took < 30_000, `took ${took} ms: read until the 60 s holder let go`);
        assertEquals(result.code, 3);
        assertEquals(result.stdout.trim(), "out");
        assertEquals(result.stderr.trim(), "err");
        if (streaming) assertEquals(lines.toSorted(), ["err", "out"]);
      } finally {
        await killHolder(pidFile);
        await Deno.remove(cwd, { recursive: true });
      }
    },
  );
}

Deno.test("runDeno: an onLine that throws rejects the run, as it did before", async () => {
  // This process's own directory: the child may still be running when the run rejects, and on
  // Windows a temp dir that is a running process's cwd cannot be removed.
  let err: Error | null = null;
  const children = await spawnsOf(async () => {
    err = await runDeno(["eval", "console.log('a'); console.log('b')"], {
      cwd: Deno.cwd(),
      onLine: () => {
        throw new Error("sink closed");
      },
    }).then(() => null, (e: Error) => e);
  });
  assertEquals((err as Error | null)?.message, "sink closed");
  // The rejection is immediate; the child (and the other stream's read) end a moment later.
  await exited(children);
});

// ── --offline and the grandchild gap ─────────────────────────────────────────

/**
 * A project whose `denext.config.ts` shells out while it is being EVALUATED — the way a config
 * that wanted the network under `--offline` would, since `--deny-net` does not reach a process
 * the child spawns. It reports on stderr whether the spawn went through, and contributes a
 * verb, so the listing itself can be checked too.
 */
const SPAWNING_CONFIG = `let spawned = "not tried";
try {
  // Deno itself, not \`sh\`: a binary that exists on every OS, so a refusal is the permission's.
  const out = new Deno.Command(Deno.execPath(), { args: ["eval", "console.log('grandchild')"] })
    .outputSync();
  spawned = new TextDecoder().decode(out.stdout).trim();
} catch (e) {
  spawned = "refused: " + (e as Error).name;
}
console.error("CONFIG-SPAWN " + spawned);
export default {
  commands: [{ name: "seed", summary: "Load fixtures", run: () => console.log("seeded") }],
};
`;

Deno.test("cliInvocation: --deny-run rides with --offline only when asked, after the net flags", () => {
  const online = cliInvocation({ denyRun: true });
  assertEquals(online.slice(0, 2), ["run", "-A"]);
  assertEquals(online.length, 3, "online, denyRun changes nothing");
  assertEquals(cliInvocation({ offline: true, denyRun: true }), [
    "run",
    "-A",
    "--deny-net",
    "--cached-only",
    "--deny-run",
    online[2],
  ]);
  assert(!cliInvocation({ offline: true }).includes("--deny-run"), "a verb run keeps --allow-run");
});

Deno.test("--offline discovery: a config that spawns is refused, and its verbs are still listed", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-proc-offline-" });
  try {
    await Deno.writeTextFile(join(dir, "denext.config.ts"), SPAWNING_CONFIG);
    const discovery = [
      ...cliInvocation({ offline: true, dir, denyRun: true }),
      "commands",
      "--json",
      "--cwd",
      dir,
    ];
    const result = await runDeno(discovery, { cwd: dir });
    assertEquals(result.code, 0, result.stderr);
    assertStringIncludes(result.stderr, "CONFIG-SPAWN refused: NotCapable");
    const listing = result.json() as { project?: Array<{ name: string }> };
    assert(listing.project?.some((verb) => verb.name === "seed"), "the verb is still discovered");

    // The control: the same child without --deny-run (the verb-run path) lets the config spawn,
    // which is exactly the gap the discovery flag closes.
    const run = [...cliInvocation({ offline: true, dir }), "commands", "--json", "--cwd", dir];
    const control = await runDeno(run, { cwd: dir });
    assertEquals(control.code, 0, control.stderr);
    assertStringIncludes(control.stderr, "CONFIG-SPAWN grandchild");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cliConfigArgs: a remote CLI child is told the project's config; a checkout's is not", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-proc-cfg-" });
  try {
    const app = join(root, "app");
    await Deno.mkdir(join(app, "src"), { recursive: true });
    await Deno.writeTextFile(join(app, "deno.json"), "{}");
    const url = "https://jsr.io/@denext/denext/4.0.0/cli.ts";
    // An https module discovers no config, a jsr: one the WORKING directory's: both are told.
    assertEquals(cliConfigArgs(url, app), ["--config", join(app, "deno.json")]);
    assertEquals(cliConfigArgs(url, join(app, "src")), ["--config", join(app, "deno.json")]);
    assertEquals(cliConfigArgs("jsr:@denext/denext@4.0.0/cli", app), [
      "--config",
      join(app, "deno.json"),
    ]);
    assertEquals(cliConfigArgs(url, root), [], "no config, nothing to pass");
    assertEquals(cliConfigArgs(url, undefined), []);
    assertEquals(cliConfigArgs("file:///checkout/cli.ts", app), [], "a checkout finds its own");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ── a `--json` child that prints its document and never exits ────────────────
//
// On Windows a child has been seen to write its complete JSON document, then spin at 100% CPU in
// its teardown and never exit (`denext job --history --json` under the Cron panel ran into its
// 300 s deadline that way). With `jsonDocument`, a complete document followed by silence is used;
// a partial one never is.

/** A pretty-printed document, as the `--json` verbs write it. */
const DOC = { available: true, windowDays: 14, recent: [{ name: "cleanup", ok: true }] };

/** A `deno eval` program: Deno-style chatter on stderr, `print` on stdout, then `then`. */
function docProgram(print: string, then: string): string {
  return `console.error("Check file:///app/denext.config.ts");
Deno.stdout.writeSync(new TextEncoder().encode(${print}));
${then}`;
}

/** The pretty-printed {@linkcode DOC}, as a JS expression. */
const PRETTY = `JSON.stringify(${JSON.stringify(DOC)}, null, 2) + "\\n"`;

/** Busy-loops forever: the spin seen after the output. */
const SPIN = "for (;;) {}";

/** Whether `pid` is gone (a kill of it fails). */
function gone(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGKILL");
    return false;
  } catch {
    return true;
  }
}

Deno.test("runDeno jsonDocument: a child that prints its whole document and then spins is killed and its output used", async () => {
  const notices: string[] = [];
  const lines: string[] = [];
  const started = performance.now();
  const result = await runDeno(["eval", docProgram(PRETTY, SPIN)], {
    cwd: Deno.cwd(),
    onLine: (line) => void lines.push(line),
    signal: AbortSignal.timeout(60_000),
    jsonDocument: { graceMs: 500, onSettled: (line) => notices.push(line) },
  });
  const took = performance.now() - started;
  assertEquals(result.code, 0, `settled, not killed at the deadline (took ${took} ms)`);
  assert(took < 45_000, `took ${took} ms`);
  assertEquals(parseJsonDocument(lines.join("\n")), DOC);
  assertEquals(notices.length, 1, notices.join("\n"));
  assertMatch(
    notices[0],
    /^warning: deno child \(pid \d+\): output complete; the process did not exit 0\.5 s after/,
  );
  const pid = Number(/\(pid (\d+)\)/.exec(notices[0])![1]);
  assert(gone(pid), `pid ${pid} still running`);
});

Deno.test("runDeno jsonDocument: a spinning grandchild that wrote the document is killed with the child", async () => {
  // The CLI re-execs itself, so the process that prints the document (and spins) may be a
  // descendant of the one runDeno spawned, holding the same pipes.
  const cwd = await Deno.makeTempDir({ prefix: "denext-proc-json-" });
  const pidFile = join(cwd, "pid");
  const notices: string[] = [];
  try {
    const grandchild = docProgram(PRETTY, SPIN);
    const program = `const g = new Deno.Command(Deno.execPath(), {
  args: ["eval", ${
      JSON.stringify(grandchild)
    }], stdin: "null", stdout: "inherit", stderr: "inherit",
}).spawn();
Deno.writeTextFileSync(${JSON.stringify(pidFile)}, String(g.pid));
await g.status;`;
    const result = await runDeno(["eval", program], {
      cwd,
      signal: AbortSignal.timeout(60_000),
      jsonDocument: { graceMs: 500, onSettled: (line) => notices.push(line) },
    });
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.json(), DOC);
    assertEquals(notices.length, 1, notices.join("\n"));
    const pid = Number((await Deno.readTextFile(pidFile)).trim());
    // taskkill / the pgrep walk ended it; give the OS a moment to reap it.
    for (let i = 0; i < 50 && !gone(pid); i++) await new Promise((r) => setTimeout(r, 100));
    assert(gone(pid), `grandchild ${pid} still running`);
  } finally {
    await removeTempDir(cwd);
  }
});

Deno.test("runDeno jsonDocument: a child that stops mid-document and spins is never settled", async () => {
  const notices: string[] = [];
  const started = performance.now();
  const result = await runDeno(
    ["eval", docProgram(`'{\\n  "available": true,\\n  "recent": [\\n'`, SPIN)],
    {
      cwd: Deno.cwd(),
      signal: AbortSignal.timeout(2_000),
      jsonDocument: { graceMs: 300, onSettled: (line) => notices.push(line) },
    },
  );
  assert(performance.now() - started >= 2_000, "it ran to its deadline");
  assert(result.code !== 0, "the deadline killed it");
  assertEquals(notices, []);
});

Deno.test("runDeno jsonDocument: a bare value is not a document", async () => {
  const notices: string[] = [];
  const result = await runDeno(["eval", docProgram(`"12"`, SPIN)], {
    cwd: Deno.cwd(),
    signal: AbortSignal.timeout(1_500),
    jsonDocument: { graceMs: 300, onSettled: (line) => notices.push(line) },
  });
  assert(result.code !== 0);
  assertEquals(notices, []);
});

for (const code of [0, 3]) {
  Deno.test(`runDeno jsonDocument: a child that exits ${code} after its document keeps its status`, async () => {
    const notices: string[] = [];
    const result = await runDeno(["eval", docProgram(PRETTY, `Deno.exit(${code});`)], {
      cwd: Deno.cwd(),
      jsonDocument: { graceMs: 60_000, onSettled: (line) => notices.push(line) },
    });
    assertEquals(result.code, code);
    assertEquals(result.json(), DOC);
    assertEquals(notices, []);
  });
}

Deno.test("runDeno jsonDocument: a document followed by more output is not the answer", async () => {
  // A JSON value printed early (a project's own log), then a progress line, then silent work:
  // the silence is work, not a teardown hang.
  const notices: string[] = [];
  const started = performance.now();
  const result = await runDeno(
    ["eval", docProgram(`${PRETTY} + "migrating…\\n"`, SPIN)],
    {
      cwd: Deno.cwd(),
      signal: AbortSignal.timeout(1_500),
      jsonDocument: { graceMs: 300, onSettled: (line) => notices.push(line) },
    },
  );
  assert(performance.now() - started >= 1_500, "it ran to its deadline");
  assert(result.code !== 0, "the deadline killed it");
  assertEquals(notices, []);
});

Deno.test("runDeno jsonDocument: only the verbs that print last and exit opt in", async () => {
  // `denext db-admin` (statements and migrations write) and `denext doctor` (route probes) run
  // project work after project code may have printed JSON: they wait for their exit.
  const root = new URL("../src/ui/features/", import.meta.url);
  const optIn: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const source = await Deno.readTextFile(new URL(entry.name, root));
    if (/jsonDocument:\s*\{/.test(source)) optIn.push(entry.name);
  }
  assertEquals(optIn.sort(), ["commands.ts", "config-cron.ts"]);
});
