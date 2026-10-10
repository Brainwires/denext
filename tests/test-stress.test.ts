// The timer-stress lane: the seeded jitter is reproducible and stalls only the callbacks it wraps,
// and `scripts/test-stress.ts` selects the timer-heavy files (never a serial one), parses its
// flags strictly, derives one seed per run and reports the failed seeds.

import { assert, assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import {
  installJitter,
  JITTER_DEFAULTS,
  jitterFromEnv,
  mulberry32,
  seedFor,
} from "./stress/jitter.ts";
import { SERIAL_TESTS } from "./serial-tests.ts";
import { parseStressArgs, runSeeds, stressFiles, summary } from "../scripts/test-stress.ts";

Deno.test("jitter: one seed gives one sequence; another seed another", () => {
  const draw = (seed: number) => {
    const r = mulberry32(seed);
    return Array.from({ length: 8 }, () => r());
  };
  assertEquals(draw(42), draw(42));
  assertNotEquals(draw(42), draw(43));
  for (const x of draw(7)) assert(x >= 0 && x < 1);
});

Deno.test("jitter: each file draws its own stream from the run seed", () => {
  assertEquals(seedFor(1, "tests/a.test.ts"), seedFor(1, "tests/a.test.ts"));
  assertNotEquals(seedFor(1, "tests/a.test.ts"), seedFor(1, "tests/b.test.ts"));
  assertNotEquals(seedFor(1, "tests/a.test.ts"), seedFor(2, "tests/a.test.ts"));
});

Deno.test("jitter: options come from the environment, with defaults for bad values", () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  const set = jitterFromEnv(
    env({ DENEXT_STRESS_SEED: "123", DENEXT_STRESS_MAX_MS: "5", DENEXT_STRESS_P: "3" }),
  );
  assertEquals(set, { seed: 123, fresh: false, maxMs: 5, probability: 1 });
  const unset = jitterFromEnv(env({ DENEXT_STRESS_MAX_MS: "-1", DENEXT_STRESS_P: "x" }));
  assert(unset.fresh);
  assert(Number.isInteger(unset.seed) && unset.seed >= 0 && unset.seed < 2 ** 32);
  assertEquals(unset.maxMs, JITTER_DEFAULTS.maxMs);
  assertEquals(unset.probability, JITTER_DEFAULTS.probability);
  assert(jitterFromEnv(env({ DENEXT_STRESS_SEED: "nope" })).fresh);
});

Deno.test("jitter: wrapped callbacks still run with their arguments, after a stall", async () => {
  const realTimeout = globalThis.setTimeout;
  const realMicrotask = globalThis.queueMicrotask;
  const restore = installJitter({ seed: 9, maxMs: 15, probability: 1 });
  try {
    assertNotEquals(globalThis.setTimeout, realTimeout);
    const started = performance.now();
    const args = await new Promise<unknown[]>((resolve) => {
      setTimeout((...a: unknown[]) => resolve(a), 0, "x", 2);
    });
    assertEquals(args, ["x", 2]);
    // With probability 1 the first draw always stalls, for random() * maxMs.
    const expected = mulberry32(9);
    expected();
    assert(performance.now() - started >= expected() * 15 - 1);
    const order: string[] = [];
    await new Promise<void>((resolve) => {
      queueMicrotask(() => order.push("micro"));
      setTimeout(() => {
        order.push("timer");
        resolve();
      }, 0);
    });
    assertEquals(order, ["micro", "timer"]);
  } finally {
    restore();
  }
  assertEquals(globalThis.setTimeout, realTimeout);
  assertEquals(globalThis.queueMicrotask, realMicrotask);
});

Deno.test("test:stress: the timer-heavy areas, without serial or child-process files", () => {
  const files = stressFiles(
    [
      "mobile-keyboard.test.ts",
      "desktop-window.test.ts",
      "auth-client.test.ts",
      "virtual-list-dom.test.ts",
      "rn-compat-shims.test.ts",
      "navigation.test.ts",
      "expo-status-bar.test.ts",
      "mobile-build.test.ts",
      "mobile-add-ota.test.ts",
      "desktop-run.test.ts",
      "cli-desktop-coverage.test.ts",
      "server-misc-coverage.test.ts",
      "mobile-helper.ts",
    ],
    ["tests/desktop-window.test.ts"],
  );
  assertEquals(files, [
    "tests/auth-client.test.ts",
    "tests/expo-status-bar.test.ts",
    "tests/mobile-keyboard.test.ts",
    "tests/navigation.test.ts",
    "tests/rn-compat-shims.test.ts",
    "tests/virtual-list-dom.test.ts",
  ]);
});

Deno.test("test:stress: the selection never includes a serial test file", () => {
  const names = [...Deno.readDirSync(new URL(".", import.meta.url))].map((e) => e.name);
  const files = stressFiles(names);
  assert(files.length > 50, `only ${files.length} files selected`);
  assert(files.includes("tests/react-native-apis.test.ts"));
  assertEquals(files.filter((f) => SERIAL_TESTS.includes(f)), []);
});

Deno.test("test:stress: flags parse strictly; paths pass through", () => {
  assertEquals(parseStressArgs([]), {
    runs: 1,
    seed: null,
    maxMs: JITTER_DEFAULTS.maxMs,
    probability: JITTER_DEFAULTS.probability,
    paths: [],
  });
  assertEquals(
    parseStressArgs(["--runs", "3", "--seed=7", "--max-ms", "12.5", "--p=2", "tests/x.test.ts"]),
    { runs: 3, seed: 7, maxMs: 12.5, probability: 1, paths: ["tests/x.test.ts"] },
  );
  assertThrows(() => parseStressArgs(["--runs", "1.5"]), Error, "--runs");
  assertThrows(() => parseStressArgs(["--seed"]), Error, "--seed");
  assertThrows(() => parseStressArgs(["--max-ms=-4"]), Error, "--max-ms");
  assertThrows(() => parseStressArgs(["--repeat", "2"]), Error, "unknown flag");
});

Deno.test("test:stress: one seed per run, consecutive from a given seed", () => {
  assertEquals(runSeeds(3, 10), [10, 11, 12]);
  assertEquals(runSeeds(2, 2 ** 32 - 1), [2 ** 32 - 1, 0]);
  const fixed = [0.5, 0.25];
  assertEquals(runSeeds(2, null, () => fixed.shift()!), [2 ** 31, 2 ** 30]);
});

Deno.test("test:stress: the summary lists every seed and how to replay a failure", () => {
  const opts = parseStressArgs([]);
  const passed = summary([{ seed: 1, ok: true }], opts);
  assert(passed.includes("1/1 runs passed"));
  assert(!passed.includes("Replay"));
  const failed = summary([{ seed: 1, ok: true }, { seed: 2, ok: false }], opts);
  assert(failed.includes("1/2 runs passed"));
  assert(failed.includes("- seed 2: **FAILED**"));
  assert(failed.includes("deno task test:stress --seed <seed>"));
});
