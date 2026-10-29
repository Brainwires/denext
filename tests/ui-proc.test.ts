// `denext ui`'s subprocess runner: a child that never prints a newline (a `\r` progress bar,
// one huge blob) is streamed in bounded pieces instead of being held whole until it exits, and a
// child whose pipes outlive it (a process it left running, or on Windows one spawned elsewhere at
// the same moment, holds them) is read until it exits, not until they close.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cliConfigArgs, cliInvocation, runDeno } from "../src/ui/proc.ts";

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

Deno.test({
  name: "runDeno: an onLine that throws rejects the run, as it did before",
  // The rejection is immediate; the other stream's read ends with the child, after the test.
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  // This process's own directory: the child may still be running when the run rejects, and on
  // Windows a temp dir that is a running process's cwd cannot be removed.
  const err = await runDeno(["eval", "console.log('a'); console.log('b')"], {
    cwd: Deno.cwd(),
    onLine: () => {
      throw new Error("sink closed");
    },
  }).then(() => null, (e: Error) => e);
  assertEquals(err?.message, "sink closed");
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
