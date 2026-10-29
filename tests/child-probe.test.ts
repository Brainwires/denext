// src/build/child-probe.ts: under DENEXT_CHILD_PROBE a build child that never exits fails (through
// retryOnStall, retried once) with the tail of its debug log and two CPU samples; without it the
// child runs exactly as before and its stall carries neither.

import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
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
