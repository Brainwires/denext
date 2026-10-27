// The per-file coverage ratchet (scripts/coverage-ratchet.ts) that `deno task test:coverage` runs
// after the fixed floors: which modules it covers, the verdicts against a recorded baseline (a
// drop fails, a new file under 85% fails, a rise is reported), and `--update`, which only raises.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, resolve } from "@std/path";
import type { FileCoverage } from "../scripts/coverage-floor.ts";
import {
  type Baseline,
  BASELINE_FILE,
  checkRatchet,
  floors,
  formatBaseline,
  main,
  NEW_FILE_FLOOR,
  RATCHETED,
  ratcheted,
  ratchetedCoverage,
  slack,
  updateBaseline,
} from "../scripts/coverage-ratchet.ts";

/** Coverage with `hit` of `found` for every kind. */
const cov = (
  lines: [number, number],
  branches: [number, number] = [1, 1],
  functions: [number, number] = [1, 1],
): FileCoverage => ({ lines, branches, functions });

Deno.test("ratchet scope: the CLI, the server, the compat layer, the DevTools panes and the packages' sources", () => {
  assertEquals(RATCHETED, [
    "src/cli",
    "src/server",
    "src/compat",
    "src/client/devtools-panel",
    "packages",
  ]);
  for (
    const f of [
      "src/cli/commands/plugin.ts",
      "src/server/app.ts",
      "src/compat/next/link.tsx",
      "packages/openapi/mod.ts",
      "packages/backend/src/rest/query.ts",
      "src/client/devtools-panel/live.ts",
    ]
  ) assert(ratcheted(f), f);
  for (
    const f of [
      "src/build/export.ts", // outside the ratcheted trees
      "src/cli/README.md",
      "packages/lightningcss/lib/denext_lightningcss.js",
      "packages/avif/lib/avif_dec.ts", // wasm-bindgen glue
      "packages/x/node_modules/y/index.ts",
      "src/server/types.d.ts",
      "src/clix/a.ts", // a prefix, not the directory
      "src/client/devtools-panel.ts", // the panel's entry, beside the panes' directory
      "src/client/reconciler.ts",
    ]
  ) assert(!ratcheted(f), f);
  const root = resolve("/p");
  const picked = ratchetedCoverage(
    new Map([
      [resolve(root, "src/cli/a.ts"), cov([1, 1])],
      [resolve(root, "src/build/b.ts"), cov([1, 1])],
    ]),
    root,
  );
  assertEquals([...picked.keys()], ["src/cli/a.ts"]);
});

Deno.test("floors round down, nothing counted is 0; the slack is one item, at least one point", () => {
  // Nothing counted records 0: a module whose functions never ran lists no branches yet.
  assertEquals(floors(cov([2, 3], [0, 0], [1, 4])), [66, 0, 25]);
  assertEquals(slack([0, 0]), 0);
  assertEquals(slack([10, 200]), 1);
  assertEquals(slack([1, 4]), 25);
});

Deno.test("checkRatchet: a drop past the slack fails, a rise is reported, a new file needs 85%", () => {
  const baseline: Baseline = {
    "src/cli/held.ts": [80, 100, 100],
    "src/cli/dropped.ts": [80, 100, 100],
    "src/cli/jitter.ts": [80, 100, 100],
    "src/cli/raised.ts": [50, 100, 100],
    "src/cli/unloaded.ts": [40, 100, 100],
    "src/cli/deleted.ts": [40, 100, 100],
    "src/cli/types-only.ts": [0, 0, 0],
    // Recorded while no test called into it (no branches or functions counted yet).
    "src/cli/first-tests.ts": [41, 0, 0],
  };
  const coverage = new Map<string, FileCoverage>([
    ["src/cli/held.ts", cov([80, 100])],
    ["src/cli/dropped.ts", cov([70, 100])],
    // 79.5% of 200 lines: within one line of 80.
    ["src/cli/jitter.ts", cov([159, 200])],
    ["src/cli/raised.ts", cov([90, 100])],
    ["src/cli/new-good.ts", cov([9, 10])],
    ["src/cli/new-bad.ts", cov([9, 10], [1, 2])],
    ["src/cli/first-tests.ts", cov([100, 100], [9, 10], [5, 5])],
  ]);
  const results = checkRatchet(coverage, baseline, (f) => f !== "src/cli/deleted.ts");
  const by = Object.fromEntries(results.map((r) => [r.file, r]));
  assertEquals(by["src/cli/held.ts"].failures, []);
  assertEquals(by["src/cli/dropped.ts"].failures, ["lines 70.0% (baseline 80%)"]);
  assertEquals(by["src/cli/jitter.ts"].failures, []);
  assertEquals(by["src/cli/raised.ts"].raised, ["lines 50 → 90"]);
  assertEquals(by["src/cli/new-good.ts"].failures, []);
  assertEquals(by["src/cli/new-bad.ts"].failures, [
    `branches 50.0% (a new file: at least ${NEW_FILE_FLOOR}%)`,
  ]);
  assertEquals(by["src/cli/unloaded.ts"].failures, ["never loaded by a test"]);
  // Its first real tests count branches for the first time: a rise, not a drop from 100%.
  assertEquals(by["src/cli/first-tests.ts"].failures, []);
  assertEquals(by["src/cli/first-tests.ts"].raised, [
    "lines 41 → 100",
    "branches 0 → 90",
    "functions 0 → 100",
  ]);
  // A deleted file, and a recorded file with nothing to cover, are no failure.
  assertEquals(by["src/cli/deleted.ts"], undefined);
  assertEquals(by["src/cli/types-only.ts"], undefined);
});

Deno.test("updateBaseline: raises, adds, drops deleted files, never lowers", () => {
  const next = updateBaseline(
    new Map([
      ["src/cli/b.ts", cov([90, 100], [1, 2])],
      ["src/cli/a.ts", cov([1, 3])],
    ]),
    { "src/cli/b.ts": [80, 60, 100], "src/cli/gone.ts": [10, 10, 10] },
    (f) => f !== "src/cli/gone.ts",
  );
  assertEquals(next, { "src/cli/a.ts": [33, 100, 100], "src/cli/b.ts": [90, 60, 100] });
  assertEquals(Object.keys(next), ["src/cli/a.ts", "src/cli/b.ts"]);
  assertEquals(
    formatBaseline(next),
    '{\n  "src/cli/a.ts": [33, 100, 100],\n  "src/cli/b.ts": [90, 60, 100]\n}\n',
  );
});

Deno.test("main: check, report a rise, --update, and the checked-in baseline parses", async () => {
  const root = await Deno.makeTempDir();
  const errs: string[] = [];
  const logs: string[] = [];
  const prev = [console.error, console.log] as const;
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    await Deno.mkdir(join(root, "src/cli"), { recursive: true });
    await Deno.mkdir(join(root, "scripts"), { recursive: true });
    await Deno.writeTextFile(join(root, "src/cli/a.ts"), "");
    const lcov = join(root, "lcov.info");
    const abs = resolve(root, "src/cli/a.ts");
    await Deno.writeTextFile(lcov, `SF:${abs}\nDA:1,1\nDA:2,0\nend_of_record\n`);
    // No baseline yet: a.ts is new, and 50% is under the new-file floor.
    assertEquals(await main([lcov], root), 1);
    assertStringIncludes(errs.join("\n"), "src/cli/a.ts: lines 50.0% (a new file");
    assertEquals(await main([lcov, "--update"], root), 0);
    const written = await Deno.readTextFile(join(root, BASELINE_FILE));
    assertEquals(written, '{\n  "src/cli/a.ts": [50, 0, 0]\n}\n');
    assertEquals(await main([lcov], root), 0);
    assertStringIncludes(logs.join("\n"), "1 files at or above their baseline");
    // Better coverage passes and is reported as raisable; --baseline reads another file.
    await Deno.writeTextFile(lcov, `SF:${abs}\nDA:1,1\nDA:2,1\nend_of_record\n`);
    assertEquals(await main([lcov, "--baseline", BASELINE_FILE], root), 0);
    assertStringIncludes(logs.join("\n"), "src/cli/a.ts: lines 50 → 100");
    assertEquals(await main([], root), 2);
    assertStringIncludes(errs.join("\n"), "usage: coverage-ratchet.ts");
  } finally {
    [console.error, console.log] = prev;
    await Deno.remove(root, { recursive: true });
  }
  // The repository's own baseline: every entry a ratcheted path with three whole percentages.
  const baseline = JSON.parse(
    await Deno.readTextFile(new URL(`../${BASELINE_FILE}`, import.meta.url)),
  ) as Baseline;
  assert(Object.keys(baseline).length > 0);
  for (const [file, entry] of Object.entries(baseline)) {
    assert(ratcheted(file), file);
    assertEquals(entry.length, 3, file);
    for (const n of entry) assert(Number.isInteger(n) && n >= 0 && n <= 100, file);
  }
});
