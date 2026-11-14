// The sharded coverage gate (scripts/ci/coverage-shards.ts, scripts/ci/coverage-merge.ts, test-run's
// `--shard` / `--no-re-emit`, ci.yml's `coverage-shard` + `coverage` jobs): every test file runs in
// exactly one shard, the shards are balanced, and the merge refuses anything else.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import {
  COVERAGE_IGNORES,
  discoverTestFiles,
  DURATIONS_FILE,
  fileDurations,
  formatDurations,
  parseShard,
  PINNED_TO_FIRST,
  planShards,
  readDurations,
} from "../scripts/ci/coverage-shards.ts";
import {
  findShards,
  type FoundShard,
  gatherProfiles,
  mergeProblem,
  rebaseProfile,
} from "../scripts/ci/coverage-merge.ts";
import {
  isRegeneratedModuleProfile,
  pruneRegeneratedProfiles,
  shardArgs,
  shardRecordPath,
  splitArgs,
  testPasses,
} from "../scripts/test-run.ts";

const ROOT = new URL("../", import.meta.url);
const SHARDS = 6;

Deno.test("coverage shards: --shard=<i>/<n> parses, and only with 1 <= i <= n", () => {
  assertEquals(parseShard("1/6"), { index: 1, count: 6 });
  assertEquals(parseShard("6/6"), { index: 6, count: 6 });
  for (const bad of ["0/6", "7/6", "1", "a/b", "1/0", "-1/6", "1/6/2"]) {
    assertEquals(parseShard(bad), null, bad);
  }
  assertThrows(() => splitArgs(["--shard=7/6"]), Error, "--shard=<i>/<n>");
  const split = splitArgs(["--coverage=cov", "--shard=2/3", "--no-re-emit", "tests/a.test.ts"]);
  assertEquals(split.shard, { index: 2, count: 3 });
  assertEquals(split.reEmit, false);
  assertEquals(split.flags, ["--coverage=cov"], "neither reaches deno test");
  assertEquals(splitArgs([]).reEmit, true);
});

Deno.test("coverage shards: the plan puts every file in one shard, pins first, Vitest last, longest first", () => {
  const files = ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "e.vitest.ts", "pin.test.ts"];
  const durations = {
    "a.test.ts": 10,
    "b.test.ts": 6,
    "c.test.ts": 5,
    "d.test.ts": 1,
    "pin.test.ts": 2,
  };
  const plan = planShards(files, durations, 3, ["pin.test.ts"]);
  // pin → 1 and e.vitest.ts → 3 first (unlisted: the mean, 24 / 5 = 4.8), then a (10) → 2, b (6)
  // → 1, c (5) → 3, d (1) → 1: each to the shard with the least time so far.
  assertEquals(plan.map((s) => s.files), [
    ["b.test.ts", "d.test.ts", "pin.test.ts"],
    ["a.test.ts"],
    ["c.test.ts", "e.vitest.ts"],
  ]);
  assertEquals(plan.map((s) => Math.round(s.seconds * 10) / 10), [9, 10, 9.8]);
  assertEquals(plan.flatMap((s) => s.files).sort(), [...files].sort());
  assertEquals(planShards(files, durations, 3, ["pin.test.ts"]), plan, "deterministic");
  assertEquals(planShards([], {}, 2).map((s) => s.files), [[], []]);
});

Deno.test("coverage shards: test files are found as deno test finds them", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const files = [
      "a_test.ts",
      "sub/b.test.tsx",
      "sub/test.js",
      "c.vitest.ts",
      "d.test.mjs",
      "plain.ts",
      "testing.ts",
      "contest.ts",
      "node_modules/x_test.ts",
      ".git/y_test.ts",
      "ignored/z.test.ts",
    ];
    for (const f of files) {
      await Deno.mkdir(join(dir, f, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, f), "");
    }
    assertEquals(await discoverTestFiles(dir, ["ignored/"]), [
      "a_test.ts",
      "c.vitest.ts",
      "d.test.mjs",
      "sub/b.test.tsx",
      "sub/test.js",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("coverage shards: this repository's files split into 6 shards within ±10% of each other", async () => {
  const files = await discoverTestFiles(fromFileUrl(ROOT), COVERAGE_IGNORES);
  const durations = await readDurations();
  // Every file the table lists that still exists is found: discovery never drops a known file.
  const found = new Set(files);
  const lost = Object.keys(durations).filter((f) => {
    try {
      Deno.statSync(new URL(f, ROOT));
      return !found.has(f);
    } catch {
      return false; // removed since the table was measured
    }
  });
  assertEquals(lost, []);
  for (const pin of PINNED_TO_FIRST) assert(found.has(pin), `${pin} exists`);
  const plan = planShards(files, durations, SHARDS);
  const mean = plan.reduce((n, s) => n + s.seconds, 0) / SHARDS;
  for (const [i, s] of plan.entries()) {
    assert(
      Math.abs(s.seconds - mean) <= mean * 0.1,
      `shard ${i + 1}: ${s.seconds}s, mean ${mean}s`,
    );
  }
  assert(PINNED_TO_FIRST.every((f) => plan[0].files.includes(f)));
});

Deno.test("coverage shards: durations come from a stamped coverage log; the table is in its own format", async () => {
  const log = [
    "coverage\tUNKNOWN STEP\t2026-11-11T13:00:57.0000000Z running 3 tests from ./tests/a.test.ts",
    "coverage\tUNKNOWN STEP\t2026-11-11T13:00:58.0000000Z a ... ok (1ms)",
    "coverage\tUNKNOWN STEP\t2026-11-11T13:01:07.5000000Z running 1 test from ./tests/b.test.ts",
    "coverage\tUNKNOWN STEP\t2026-11-11T13:01:10.0000000Z ok | 4 passed | 0 failed (13s)",
    "coverage\tUNKNOWN STEP\t2026-11-11T13:01:11.0000000Z running 1 test from ./tests/c.test.ts",
    "unstamped running 1 test from ./tests/d.test.ts",
  ].join("\n");
  assertEquals(fileDurations(log), { "tests/a.test.ts": 10.5, "tests/b.test.ts": 2.5 });
  const text = await Deno.readTextFile(DURATIONS_FILE);
  assertEquals(formatDurations(JSON.parse(text)), text, "regenerate with --update");
});

Deno.test("coverage shards: test-run's --shard runs the shard's own files, flags and the tail kept", () => {
  const files = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.vitest.ts", "tests/e2e/x.test.ts"];
  const durations = { "tests/a.test.ts": 5, "tests/b.test.ts": 4 };
  const base = ["--ignore=tests/e2e/", "--coverage=cov", "--filter", "x", "--no-re-emit"];
  const one = shardArgs([...base, "--shard=1/2", "--", "arg"], files, durations);
  const two = shardArgs([...base, "--shard=2/2"], files, durations);
  assertEquals(one, [...base, "tests/a.test.ts", "--", "arg"]);
  assertEquals(two, [...base, "tests/b.test.ts", "tests/c.vitest.ts"]);
  // A path narrows the scope; a shard left with no file runs nothing.
  assertEquals(shardArgs(["--shard=2/2", "tests/a.test.ts"], files, durations), null);
  assertEquals(shardArgs(["tests/a.test.ts"], files, durations), ["tests/a.test.ts"]);
  // The shard's files reach the passes as paths: the stock one alone in the coverage pass.
  const passes = testPasses(two!, [], ["tests/c.vitest.ts"], true, []);
  assert(passes.parallel!.includes("tests/b.test.ts"));
  assert(!passes.parallel!.includes("tests/a.test.ts"));
  assert(!passes.parallel!.includes("--no-re-emit"));
  assert(passes.vitest!.includes("tests/c.vitest.ts"));
  assertEquals(shardRecordPath("coverage/profile/"), "coverage/profile.shard.json");
});

/** A shard as the merge finds it. */
function found(index: number, count: number, files: string[], root = "file:///a/"): FoundShard {
  return { dir: `/s/${index}`, record: { index, count, root, files } };
}

Deno.test("coverage merge: refuses a missing, doubled, miscounted or re-planned shard", () => {
  const plan = [["a.test.ts"], ["b.test.ts", "c.test.ts"]];
  const good = [found(1, 2, ["a.test.ts"]), found(2, 2, ["b.test.ts", "c.test.ts"])];
  assertEquals(mergeProblem(good, plan), null);
  assert(mergeProblem([good[0]], plan)?.includes("shard 2/2: found 0 times"));
  assert(mergeProblem([...good, good[1]], plan)?.includes("found 2 times"));
  assert(mergeProblem([found(1, 3, ["a.test.ts"]), good[1]], plan)?.includes("planned for"));
  assert(
    mergeProblem([good[0], found(2, 2, ["b.test.ts"])], plan)?.includes("missing: c.test.ts"),
  );
});

Deno.test("coverage merge: profiles move under this checkout's root, renamed per shard", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const here = toFileUrl(join(dir, "repo") + "/").href;
    const there = "file:///home/runner/work/denext/denext/";
    const profile = (root: string) =>
      JSON.stringify({ scriptId: "1", url: `${root}src/x.ts`, functions: [] }, null, 2);
    assertEquals(rebaseProfile(profile(there), there, here), profile(here));
    assertEquals(rebaseProfile(profile(here), here, here), profile(here));
    for (const [n, root] of [[1, here], [2, there]] as const) {
      await Deno.mkdir(join(dir, "shards", String(n), "profile"), { recursive: true });
      await Deno.writeTextFile(join(dir, "shards", String(n), "profile", "u.json"), profile(root));
      await Deno.writeTextFile(
        join(dir, "shards", String(n), "profile.shard.json"),
        JSON.stringify({ index: n, count: 2, root, files: [] }),
      );
    }
    await Deno.mkdir(join(dir, "shards", "stray"));
    const shards = await findShards(join(dir, "shards"));
    assertEquals(shards.map((s) => s.record.index), [1, 2]);
    const out = join(dir, "profile");
    assertEquals(await gatherProfiles(shards, out, here), 2);
    for (const name of ["s1-u.json", "s2-u.json"]) {
      assertEquals(await Deno.readTextFile(join(out, name)), profile(here), name);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("coverage: a Vitest-regenerated module's profile is left out, in a run and in the merge", async () => {
  // `…/x.ts?__vitest_gen=2` is the Vitest layer's re-evaluated copy: its offsets are of a
  // transformed source, and `deno coverage` mapped them onto x.ts (bridge-client.ts read 15.7%).
  assert(isRegeneratedModuleProfile("file:///r/src/x.ts?__vitest_gen=2"));
  assert(isRegeneratedModuleProfile("file:///r/src/x.ts?a=1&__vitest_gen=3"));
  assert(!isRegeneratedModuleProfile("file:///r/src/x.ts"));
  assert(!isRegeneratedModuleProfile("https://x.test/y.ts?__vitest_gen=1"));
  const dir = await Deno.makeTempDir();
  try {
    const here = toFileUrl(join(dir, "repo") + "/").href;
    const profile = (url: string) => JSON.stringify({ scriptId: "1", url, functions: [] });
    // A run's own coverage directory.
    const run = join(dir, "run");
    await Deno.mkdir(run);
    await Deno.writeTextFile(join(run, "a.json"), profile(`${here}src/x.ts`));
    await Deno.writeTextFile(join(run, "b.json"), profile(`${here}src/x.ts?__vitest_gen=2`));
    await Deno.writeTextFile(join(run, "notes.txt"), "not a profile");
    assertEquals(await pruneRegeneratedProfiles(run), 1);
    assertEquals([...Deno.readDirSync(run)].map((e) => e.name).sort(), ["a.json", "notes.txt"]);
    // A shard's (from before the runs pruned them): the merge drops it too.
    const shard = join(dir, "shards", "1");
    await Deno.mkdir(join(shard, "profile"), { recursive: true });
    await Deno.writeTextFile(join(shard, "profile", "a.json"), profile(`${here}src/x.ts`));
    await Deno.writeTextFile(
      join(shard, "profile", "b.json"),
      profile(`${here}src/x.ts?__vitest_gen=4`),
    );
    await Deno.writeTextFile(
      join(shard, "profile.shard.json"),
      JSON.stringify({ index: 1, count: 1, root: here, files: [] }),
    );
    const out = join(dir, "profile");
    assertEquals(await gatherProfiles(await findShards(join(dir, "shards")), out, here), 1);
    assertEquals([...Deno.readDirSync(out)].map((e) => e.name), ["s1-a.json"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("coverage gate: shards and the unsharded run report through one coverage:report", async () => {
  const tasks = (JSON.parse(await Deno.readTextFile(new URL("../deno.json", import.meta.url))) as {
    tasks: Record<string, string>;
  }).tasks;
  assert(tasks["coverage:report"].includes("--threshold=85"));
  assert(tasks["test:coverage:run"].endsWith("&& deno task coverage:report"));
  assert(tasks["coverage:merge"].endsWith("&& deno task coverage:report"));
  assert(tasks["test:coverage:shard"].includes("--no-re-emit"));
  for (const t of ["test:coverage:run", "test:coverage:shard"]) {
    assert(tasks[t].includes("--ignore=tests/e2e/,tests/migration-bed/"), t);
  }
  // ci.yml: one shard job per planned shard, each placed by its own pick key; the merge job keeps
  // the name the release gate requires (`coverage`).
  const ci = parseYaml(
    await Deno.readTextFile(new URL("../.github/workflows/ci.yml", import.meta.url)),
  ) as {
    jobs: Record<string, {
      needs?: string | string[];
      strategy?: { matrix: { include: { shard: number }[] } };
      steps: { run?: string }[];
    }>;
  };
  const shard = ci.jobs["coverage-shard"];
  assertEquals(shard.strategy!.matrix.include.map((m) => m.shard), [1, 2, 3, 4, 5, 6]);
  assert(shard.steps.some((s) => s.run?.includes(`--shard=\${{ matrix.shard }}/${SHARDS}`)));
  assertEquals(ci.jobs.coverage.needs, ["linux-runner", "coverage-shard"]);
  assert(ci.jobs.coverage.steps.some((s) => s.run === "deno task coverage:merge"));
  const pick = await Deno.readTextFile(new URL("../.github/workflows/ci.yml", import.meta.url));
  for (let i = 1; i <= SHARDS; i++) {
    assert(pick.includes(`coverage_${i}: \${{ steps.pick.outputs.coverage_${i} }}`), `output ${i}`);
  }
  assert(
    pick.includes("'coverage_1:docker coverage_2 coverage_3 coverage_4 coverage_5 coverage_6 "),
  );
});
