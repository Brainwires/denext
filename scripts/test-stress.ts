// `deno task test:stress`: the timer-heavy unit tests under timer jitter, to catch tests that sleep
// a fixed time instead of awaiting the work (see `tests/stress/jitter.ts`). Each run picks a seed,
// prints it, and runs `scripts/test-run.ts --preload tests/stress/timer-jitter.ts` over the
// selected files with that seed; the summary lists the seeds whose run failed.
//
//   deno run -A scripts/test-stress.ts [--runs N] [--seed S] [--max-ms M] [--p P] [paths...]
//
// With no path, the files `stressFiles` selects. `--seed` fixes the first run's seed (run i uses
// S + i); without it every run draws a random one. Replay a failure with
// `deno task test:stress --seed <seed> [file]`. Exits non-zero when any run failed.

import { SERIAL_TESTS } from "../tests/serial-tests.ts";
import { JITTER_DEFAULTS } from "../tests/stress/jitter.ts";

/** The areas whose tests lean on timers and microtasks: the client runtime and the shells. */
const STRESS_AREAS =
  /^(?:client|mobile|desktop|react-native|rn-|expo|virtual-list|navigation)|-client\b/;

/**
 * Test files in those areas that can't take the jitter: they build, export, package or run the
 * CLI in child processes (slow already, and the stalls only lengthen the parent's waits, which
 * finds nothing), or they start a dev server.
 */
const STRESS_SKIP =
  /(?:build|export|\bcli\b|migrate|-dev\b|-add-|doctor|submit|fastlane|package|installer|signing|-run\b|privacy|assets|fingerprint|kitchen-sink|memory-gate|pinned-runtime|-pull\b|-launch|-icon|import-map|cross-package|shims-docs|manifest|plugin-definitions|-config-types)/;

/**
 * The test files `deno task test:stress` runs by default: `tests/*.test.ts` in the timer-heavy
 * areas, minus the serial files (they change process-wide state and run one at a time) and the
 * ones `STRESS_SKIP` names.
 *
 * @param names The file names under `tests/`.
 * @param serial The serial test files (repo-relative).
 */
export function stressFiles(
  names: readonly string[],
  serial: readonly string[] = SERIAL_TESTS,
): string[] {
  return names
    .filter((n) => n.endsWith(".test.ts") && STRESS_AREAS.test(n) && !STRESS_SKIP.test(n))
    .map((n) => `tests/${n}`)
    .filter((f) => !serial.includes(f))
    .sort();
}

/** What `scripts/test-stress.ts` was asked to do. */
export interface StressArgs {
  runs: number;
  seed: number | null;
  maxMs: number;
  probability: number;
  paths: string[];
}

/**
 * This script's arguments, parsed. A bad number is an error, not a silent default.
 *
 * @param args The command-line arguments.
 */
export function parseStressArgs(args: readonly string[]): StressArgs {
  const out: StressArgs = {
    runs: 1,
    seed: null,
    maxMs: JITTER_DEFAULTS.maxMs,
    probability: JITTER_DEFAULTS.probability,
    paths: [],
  };
  const number = (flag: string, raw: string | undefined, integer: boolean) => {
    const n = Number(raw);
    if (
      raw === undefined || raw === "" || !Number.isFinite(n) || n < 0 ||
      (integer && !Number.isInteger(n))
    ) {
      throw new Error(`${flag} needs a non-negative ${integer ? "integer" : "number"}, got ${raw}`);
    }
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].includes("=") ? args[i].split("=", 2) : [args[i], undefined];
    const value = () => inline ?? args[++i];
    if (flag === "--runs") out.runs = Math.max(1, number(flag, value(), true));
    else if (flag === "--seed") out.seed = number(flag, value(), true) >>> 0;
    else if (flag === "--max-ms") out.maxMs = number(flag, value(), false);
    else if (flag === "--p") out.probability = Math.min(1, number(flag, value(), false));
    else if (flag.startsWith("-")) throw new Error(`unknown flag ${flag}`);
    else out.paths.push(args[i]);
  }
  return out;
}

/**
 * The seed of each run: `seed`, `seed + 1`, … when one is given, else random ones.
 *
 * @param runs How many runs.
 * @param seed The first run's seed, or null.
 * @param random A source of floats in [0, 1).
 */
export function runSeeds(runs: number, seed: number | null, random = Math.random): number[] {
  return Array.from(
    { length: runs },
    (_, i) => seed === null ? Math.floor(random() * 2 ** 32) : (seed + i) >>> 0,
  );
}

/** The run summary, as Markdown (also written to a GitHub Actions job summary). */
export function summary(
  results: readonly { seed: number; ok: boolean }[],
  opts: StressArgs,
): string {
  const failed = results.filter((r) => !r.ok);
  const lines = [
    `### Timer stress: ${results.length - failed.length}/${results.length} runs passed`,
    "",
    `maxMs=${opts.maxMs} p=${opts.probability}`,
    "",
    ...results.map((r) => `- seed ${r.seed}: ${r.ok ? "passed" : "**FAILED**"}`),
  ];
  if (failed.length > 0) {
    lines.push(
      "",
      "Replay a failed run with `deno task test:stress --seed <seed>` (add the failing file to" +
        " narrow it; keep `--max-ms` / `--p` the same).",
    );
  }
  return lines.join("\n") + "\n";
}

if (import.meta.main) {
  const opts = parseStressArgs(Deno.args);
  const files = opts.paths.length > 0
    ? opts.paths
    : stressFiles([...Deno.readDirSync("tests")].filter((e) => e.isFile).map((e) => e.name));
  const results: { seed: number; ok: boolean }[] = [];
  const seeds = runSeeds(opts.runs, opts.seed);
  for (const [i, seed] of seeds.entries()) {
    console.error(
      `\ntimer-stress: run ${i + 1}/${seeds.length} seed=${seed} maxMs=${opts.maxMs} ` +
        `p=${opts.probability} (${files.length} files)\n`,
    );
    const { success } = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "scripts/test-run.ts",
        "--preload",
        "tests/stress/timer-jitter.ts",
        ...files,
      ],
      env: {
        DENEXT_STRESS_SEED: String(seed),
        DENEXT_STRESS_MAX_MS: String(opts.maxMs),
        DENEXT_STRESS_P: String(opts.probability),
      },
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    results.push({ seed, ok: success });
  }
  const text = summary(results, opts);
  console.error(`\n${text}`);
  const step = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (step) await Deno.writeTextFile(step, text, { append: true });
  if (results.some((r) => !r.ok)) Deno.exit(1);
}
