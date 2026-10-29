// scripts/deno-doc.ts: every `deno doc` / `deno info` child the scripts and tests spawn is bounded.
// A child that never exits fails within its deadline (twice, retried once) with its CPU sample and
// the tail of its debug log, instead of holding the test file until the CI job's own timeout.

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  boundedDeno,
  DENO_CHILD_LOG,
  DenoChildStallError,
  denoDocJson,
  denoDocJsonMany,
  sampleProcess,
} from "../scripts/deno-doc.ts";

/**
 * Settle `p` or fail once `ms` have passed: the bound a stalled child must be failed within. An
 * unbounded `output()` over the stand-in below never settles, so it fails here.
 */
async function within<T>(p: Promise<T>, ms: number): Promise<PromiseSettledResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((r) => timer = setTimeout(() => r("late"), ms));
  const settled = p.then(
    (value): PromiseSettledResult<T> => ({ status: "fulfilled", value }),
    (reason): PromiseSettledResult<T> => ({ status: "rejected", reason }),
  );
  try {
    const won = await Promise.race([settled, late]);
    if (won === "late") throw new Error(`still pending after ${ms} ms: the child was not bounded`);
    return won;
  } finally {
    clearTimeout(timer);
  }
}

/** A `deno eval` stand-in that writes debug-shaped lines to stderr, then never exits. */
function hangingStandIn(lines: number): string[] {
  return [
    "eval",
    `for (let i = 0; i < ${lines}; i++) console.error("DEBUG RS - stand_in::lock:" + i + ` +
    `" - waiting for line " + i); setInterval(() => {}, 60_000);`,
  ];
}

Deno.test("boundedDeno: a child that never exits fails within its deadline, retried once, with its debug tail", async () => {
  const notices: string[] = [];
  const started = performance.now();
  const outcome = await within(
    boundedDeno(hangingStandIn(200), { deadlineMs: 1_500, onStall: (l) => notices.push(l) }),
    60_000,
  );
  assertEquals(outcome.status, "rejected");
  const err = (outcome as PromiseRejectedResult).reason;
  assert(err instanceof DenoChildStallError, String(err));
  assert(performance.now() - started >= 3_000, "both attempts ran to their deadline");
  assertEquals(err.attempts.length, 2);
  assertEquals(notices.length, 1);
  assertMatch(notices[0], /deno eval \(pid \d+\) was still running after 1\.5 s .* retrying once/);
  assertMatch(
    err.message,
    /^deno eval .* stalled: still running after 1\.5 s on each of 2 attempts/,
  );
  for (const attempt of err.attempts) {
    assertMatch(attempt, /^ {2}pid \d+, killed \d+\.\d s after its start/);
    assertMatch(attempt, /\n {4}cpu: /);
    // Deno's own debug lines come first: at least the stand-in's 200.
    assertMatch(attempt, /stderr: \d{3,} lines, last \d+\.\d s before the kill/);
    assertStringIncludes(attempt, `DENO_LOG=${DENO_CHILD_LOG}`);
    // The last 80 lines, not the first.
    assertStringIncludes(attempt, "DEBUG RS - stand_in::lock:199 - waiting for line 199");
    assert(!attempt.includes("stand_in::lock:100 -"), attempt);
  }
  // Two different children: the retry started a fresh one.
  const pids = err.attempts.map((a: string) => /pid (\d+)/.exec(a)![1]);
  assert(pids[0] !== pids[1], pids.join(" "));
});

Deno.test("boundedDeno: a child that finishes returns its output, the debug log's lines dropped", async () => {
  const out = await boundedDeno([
    "eval",
    `console.log(Deno.env.get("DENO_LOG")); console.error("DEBUG RS - noise:1 - x"); ` +
    `console.error("plain"); Deno.exit(3);`,
  ]);
  assertEquals(out.code, 3);
  assertEquals(out.success, false);
  assertEquals(out.stdout, `${DENO_CHILD_LOG}\n`);
  assertEquals(out.stderr, "plain\n");
});

Deno.test("boundedDeno: the caller's DENO_LOG replaces the default filter", async () => {
  const out = await boundedDeno(["eval", `console.log(Deno.env.get("DENO_LOG"))`], {
    env: { DENO_LOG: "warn" },
  });
  assertEquals(out.stdout, "warn\n");
});

Deno.test("denoDocJson: reads a module's symbols", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-deno-doc-" });
  try {
    const file = join(dir, "mod.ts");
    await Deno.writeTextFile(file, "/** One. */\nexport const one = 1;\n");
    const doc = await denoDocJson(file) as {
      nodes?: Record<string, { symbols?: { name: string }[] }>;
    };
    const names = Object.values(doc.nodes ?? {}).flatMap((n) => n.symbols ?? []).map((s) => s.name);
    assertEquals(names, ["one"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sampleProcess: two CPU samples of a live process; a reason for a gone one", async () => {
  assertMatch(await sampleProcess(Deno.pid), / -> /);
  // A pid that is not running: no sample, and why.
  const child = new Deno.Command(Deno.execPath(), { args: ["eval", ""], stdout: "null" }).spawn();
  await child.status;
  assertMatch(await sampleProcess(child.pid), /^\(no sample: /);
});

Deno.test("denoDocJsonMany: a batch documents each module exactly as it is documented alone", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-deno-doc-many-" });
  try {
    const write = (name: string, text: string) => Deno.writeTextFile(join(dir, name), text);
    // `b.ts` and `c.ts` re-export `a.ts`'s symbols: documented in one run, the later of them
    // would point at the earlier one's description instead of describing them.
    await write(
      "a.ts",
      "/** A. */\nexport interface A { x: number }\n/** Two. */\nexport const two = 2;\n",
    );
    await write("b.ts", 'export { type A, two } from "./a.ts";\n/** B. */\nexport const b = 1;\n');
    await write("c.ts", 'export * from "./b.ts";\n/** C. */\nexport function c(): void {}\n');
    await write("d.ts", "/** D. */\nexport class D {}\n");
    const files = ["c.ts", "b.ts", "a.ts", "d.ts", "b.ts"].map((f) => join(dir, f));
    const alone = await Promise.all(files.map((f) => denoDocJson(f)));
    for (const batchSize of [50, 2]) {
      const batched = await denoDocJsonMany(files, {}, batchSize);
      assertEquals(batched.length, files.length);
      batched.forEach((doc, i) => {
        assertEquals(
          JSON.stringify(doc),
          JSON.stringify(alone[i]),
          `${files[i]} (batch ${batchSize})`,
        );
      });
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denoDocJsonMany: a module that can't be documented fails as it does alone", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-deno-doc-many-" });
  try {
    await Deno.writeTextFile(join(dir, "ok.ts"), "export const ok = 1;\n");
    const missing = join(dir, "missing.ts");
    const err = await denoDocJsonMany([join(dir, "ok.ts"), missing]).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert(err instanceof Error, String(err));
    assertStringIncludes(err.message, `deno doc failed for ${missing}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
