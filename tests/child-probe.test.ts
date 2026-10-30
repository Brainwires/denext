// src/build/child-probe.ts: under DENEXT_CHILD_PROBE a build child that never exits fails (through
// retryOnStall, retried once) with the tail of its debug log and two CPU samples; without it the
// child runs exactly as before and its stall carries neither.

import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { boundedSpawn, childProbeEnabled, DENO_CHILD_LOG } from "../src/build/child-probe.ts";
import { ChildStallError, retryOnStall } from "../src/build/serial-child.ts";

/** Spawn options for a `deno eval` stand-in that writes debug-shaped lines, then never exits. */
function hangingStandIn(lines: number): Deno.CommandOptions {
  return {
    args: [
      "eval",
      `for (let i = 0; i < ${lines}; i++) console.error("DEBUG RS - stand_in::lock:" + i + ` +
      `" - waiting for line " + i); setInterval(() => {}, 60_000);`,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  };
}

/** The stand-in under retryOnStall, `probe` on or off: the stall error and the retry line. */
async function stall(probe: boolean): Promise<{ err: ChildStallError; lines: string[] }> {
  const lines: string[] = [];
  const err = await assertRejects(
    () =>
      retryOnStall(
        "deno info",
        ["info", "--json"],
        (deadline) =>
          boundedSpawn(Deno.execPath(), hangingStandIn(200), deadline, "deno info", probe),
        1_500,
        (line) => lines.push(line),
      ),
    ChildStallError,
  );
  return { err, lines };
}

Deno.test("childProbeEnabled: DENEXT_CHILD_PROBE=1 (or true) turns the probe on; off by default", () => {
  const env = (v: string | undefined) => (k: string) => k === "DENEXT_CHILD_PROBE" ? v : undefined;
  assertEquals(childProbeEnabled(env(undefined)), false);
  assertEquals(childProbeEnabled(env("")), false);
  assertEquals(childProbeEnabled(env("0")), false);
  assertEquals(childProbeEnabled(env("1")), true);
  assertEquals(childProbeEnabled(env(" TRUE ")), true);
});

Deno.test("boundedSpawn: probed, a child that never exits fails with its debug tail and CPU samples", async () => {
  const { err, lines } = await stall(true);
  assert(err.probe !== undefined, "the stall carries the probe's report");
  // Both attempts' reports, each with its CPU samples and the last 80 of the stand-in's lines.
  const reports = err.probe.split(/\n(?= {2}pid \d+, killed)/);
  assertEquals(reports.length, 2, err.probe);
  for (const report of reports) {
    assertMatch(report, /^ {2}pid \d+, killed \d+\.\d s after its start/);
    assertMatch(report, /\n {4}cpu: /);
    assertMatch(report, /stderr: \d{3,} lines, last \d+\.\d s before the kill/);
    assertStringIncludes(report, `DENO_LOG=${DENO_CHILD_LOG}`);
    assertStringIncludes(report, "DEBUG RS - stand_in::lock:199 - waiting for line 199");
    assert(!report.includes("stand_in::lock:100 -"), report);
  }
  assertStringIncludes(err.message, "stalled twice; first pid");
  assertStringIncludes(err.message, "cpu: ");
  assertStringIncludes(err.message, "stand_in::lock:199");
  // The retry line carries the first attempt's report too.
  assertEquals(lines.length, 1);
  assertMatch(lines[0], /warning: deno info \(pid \d+\) was still running after 1\.5 s/);
  assertStringIncludes(lines[0], "\n    cpu: ");
  assertStringIncludes(lines[0], "stand_in::lock:199");
});

Deno.test("boundedSpawn: unprobed, the stall carries no debug tail and no CPU samples", async () => {
  const { err, lines } = await stall(false);
  assertEquals(err.probe, undefined);
  assert(!err.message.includes("cpu: "), err.message);
  assert(!err.message.includes("stand_in::lock"), err.message);
  assertEquals(lines.length, 1);
  assert(!lines[0].includes("\n"), lines[0]);
});

Deno.test("boundedSpawn: probed, a finished child's stderr comes back without the debug records", async () => {
  const out = await boundedSpawn(
    Deno.execPath(),
    {
      args: [
        "eval",
        `console.log(Deno.env.get("DENO_LOG")); console.error("DEBUG RS - noise:1 - x"); ` +
        `console.error("plain"); Deno.exit(3);`,
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "null", // piped anyway when probed
    },
    60_000,
    "deno eval",
    true,
  );
  assertEquals(out.code, 3);
  assertEquals(new TextDecoder().decode(out.stdout), `${DENO_CHILD_LOG}\n`);
  assertEquals(new TextDecoder().decode(out.stderr), "plain\n");
});

Deno.test("boundedSpawn: unprobed, the child runs as its options say", async () => {
  const out = await boundedSpawn(
    Deno.execPath(),
    {
      args: ["eval", `console.log(Deno.env.get("DENO_LOG") ?? "unset")`],
      env: { DENO_LOG: "warn" },
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    },
    60_000,
    "deno eval",
    false,
  );
  assertEquals(new TextDecoder().decode(out.stdout), "warn\n");
  assertEquals(out.success, true);
});

// A `deno info --json` child on Windows has been seen to write its whole document and its last
// debug line, then spin at 100% CPU and never exit. With `jsonStdout`, a complete document followed
// by silence is used; a partial one is not.

/** A document the size of a small app's `deno info --json` (about 0.5 MB, many pipe chunks). */
const DOC_SCRIPT =
  `JSON.stringify({ roots: ["file:///r.ts"], modules: Array.from({ length: 4000 }, ` +
  `(_, i) => ({ specifier: "file:///m" + i + ".ts", size: i, pad: "x".repeat(100) })) })`;

/** The document {@linkcode DOC_SCRIPT} prints. */
function expectedDoc(): unknown {
  return JSON.parse(new Function(`return ${DOC_SCRIPT}`)());
}

/** Spawn options for a `deno eval` stand-in that writes `print`'s text on stdout, then `then`. */
function jsonStandIn(print: string, then: string): Deno.CommandOptions {
  return {
    args: ["eval", `Deno.stdout.writeSync(new TextEncoder().encode(${print})); ${then}`],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  };
}

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

for (const probe of [false, true]) {
  Deno.test(`boundedSpawn: ${probe ? "probed" : "unprobed"}, a JSON child that writes its whole document and then spins is killed and its output used`, async () => {
    const notices: string[] = [];
    const started = performance.now();
    const out = await boundedSpawn(
      Deno.execPath(),
      jsonStandIn(DOC_SCRIPT, SPIN),
      120_000,
      "deno info",
      probe,
      { graceMs: 500, onSettled: (l) => notices.push(l) },
    );
    const took = performance.now() - started;
    assertEquals(out.code, 0);
    assertEquals(out.success, true);
    assertEquals(JSON.parse(new TextDecoder().decode(out.stdout)), expectedDoc());
    // Well inside the deadline: the grace (plus, probed, the 2 s CPU sample before the kill).
    assert(took < 60_000, `took ${took} ms`);
    assertEquals(notices.length, 1, notices.join("\n"));
    const pid = Number(/\(pid (\d+)\)/.exec(notices[0])![1]);
    assertMatch(
      notices[0],
      /^ {4}warning: deno info \(pid \d+\): output complete; the process did not exit 0\.5 s after/,
    );
    if (probe) {
      assertStringIncludes(notices[0], "\n    cpu: ");
      assertStringIncludes(notices[0], `DENO_LOG=${DENO_CHILD_LOG}`);
    } else {
      assert(!notices[0].includes("\n"), notices[0]);
    }
    assert(gone(pid), `pid ${pid} still running`);
  });
}

Deno.test("boundedSpawn: a JSON child that stops mid-document and spins ends at its deadline, unused", async () => {
  const notices: string[] = [];
  const started = performance.now();
  const err = await assertRejects(
    () =>
      boundedSpawn(
        Deno.execPath(),
        jsonStandIn(`'{"roots":["file:///r.ts"],"modules":[{"specifier":"file:///m.ts"},'`, SPIN),
        2_000,
        "deno info",
        false,
        { graceMs: 300, onSettled: (l) => notices.push(l) },
      ),
    ChildStallError,
  );
  assert(performance.now() - started >= 2_000, "it ran to its deadline");
  assertEquals(notices, []);
  assert(gone(err.pid), `pid ${err.pid} still running`);
});

Deno.test("boundedSpawn: a JSON child that is silent but not yet done is not settled on a bare value", async () => {
  // `12` of a number still being written parses; only an object or array counts as complete.
  const notices: string[] = [];
  await assertRejects(
    () =>
      boundedSpawn(Deno.execPath(), jsonStandIn(`"12"`, SPIN), 1_500, "deno info", false, {
        graceMs: 300,
        onSettled: (l) => notices.push(l),
      }),
    ChildStallError,
  );
  assertEquals(notices, []);
});

for (const code of [0, 3]) {
  Deno.test(`boundedSpawn: a JSON child that exits ${code} after its document returns as it exited`, async () => {
    const notices: string[] = [];
    const out = await boundedSpawn(
      Deno.execPath(),
      jsonStandIn(DOC_SCRIPT, `Deno.exit(${code});`),
      120_000,
      "deno info",
      false,
      { graceMs: 60_000, onSettled: (l) => notices.push(l) },
    );
    assertEquals(out.code, code);
    assertEquals(JSON.parse(new TextDecoder().decode(out.stdout)), expectedDoc());
    assertEquals(notices, []);
    assertThrows(() => out.stderr, TypeError, "not piped");
  });
}
