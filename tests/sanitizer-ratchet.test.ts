// The sanitizer ratchet (scripts/sanitizer-ratchet.ts): no test file gains a `sanitizeOps` /
// `sanitizeResources` opt-out over scripts/sanitizer-baseline.json, and none gains one without a
// `// sanitizer: <reason>` comment; counts may go down, and `--update` only lowers them.
//
// Stale? A file over its baseline is a leak to fix (or a meant opt-out to explain and record by
// hand); a file under it is fine, and `deno task sanitizers:ratchet:update` lowers the baseline.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  type Baseline,
  BASELINE_FILE,
  checkRatchet,
  type FileOptOuts,
  formatBaseline,
  lowerBaseline,
  main,
  readBaseline,
  scanOptOuts,
  scanTree,
} from "../scripts/sanitizer-ratchet.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

// Spelled in pieces, so this file has no opt-out of its own for the scan to count.
const OPS = ["sanitizeOps", "false"].join(": ");
const RES = ["sanitizeResources", "false"].join(": ");

const scan = (entries: Record<string, [number, number[]]>): Map<string, FileOptOuts> =>
  new Map(
    Object.entries(entries).map(([f, [optOuts, unexplained]]) => [f, { optOuts, unexplained }]),
  );

Deno.test("sanitizer ratchet: no test file is over its recorded opt-outs", async () => {
  const results = checkRatchet(await scanTree(ROOT), await readBaseline(join(ROOT, BASELINE_FILE)));
  const failing = results.filter((r) => r.failures.length > 0).map((r) =>
    `${r.file}: ${r.failures.join("; ")}`
  );
  assertEquals(failing, [], "fix the leak, or explain the opt-out and raise its count by hand");
});

Deno.test("sanitizer ratchet: the baseline is sorted, one file per line, and names real files", async () => {
  const text = await Deno.readTextFile(join(ROOT, BASELINE_FILE));
  const baseline = JSON.parse(text) as Baseline;
  assertEquals(
    text,
    formatBaseline(
      Object.fromEntries(Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b))),
    ),
  );
  for (const [file, [optOuts, unexplained]] of Object.entries(baseline)) {
    assert(unexplained <= optOuts && optOuts > 0, `${file}: [${optOuts}, ${unexplained}]`);
  }
});

Deno.test("sanitizer ratchet: counts opt-outs, one per option, and finds their reasons", () => {
  assertEquals(scanOptOuts(`Deno.test({ ${OPS}, ${RES} }, () => {});`), {
    optOuts: 2,
    unexplained: [1, 1],
  });
  // On the same line.
  assertEquals(scanOptOuts(`const T = { ${OPS} }; // sanitizer: a detached child`).unexplained, []);
  // Above it, the opt-out lines under it sharing it, and a reason that wraps.
  const block = [
    "Deno.test({",
    "  name: 'x',",
    "  // sanitizer: the server outlives the test on purpose;",
    "  //   its listener is closed by the next test",
    `  ${RES},`,
    `  ${OPS},`,
    "  fn() {},",
    "});",
  ].join("\n");
  assertEquals(scanOptOuts(block), { optOuts: 2, unexplained: [] });
  // A comment that is no reason, an empty reason, or one separated by code does not count.
  assertEquals(scanOptOuts(`// leaks\n${OPS},`).unexplained, [2]);
  assertEquals(scanOptOuts(`// sanitizer:\n${OPS},`).unexplained, [2]);
  assertEquals(scanOptOuts(`// sanitizer: why\nname: 'x',\n${OPS},`).unexplained, [3]);
  // `true` is no opt-out.
  assertEquals(scanOptOuts(OPS.replace("false", "true")).optOuts, 0);
});

Deno.test("sanitizer ratchet: a count that goes up fails, one that goes down passes", () => {
  const baseline: Baseline = { "tests/a.test.ts": [4, 4], "tests/b.test.ts": [2, 0] };
  const [a, b, c] = checkRatchet(
    scan({
      "tests/a.test.ts": [5, [1, 2, 3, 4]], // one more opt-out, with a reason
      "tests/b.test.ts": [2, [7]], // as many, but one lost its reason
      "tests/c.test.ts": [1, []], // a new file: none recorded
    }),
    baseline,
  );
  assertEquals(a.failures, ["5 opt-outs (baseline 4)"]);
  assertEquals(b.failures.length, 1);
  assertStringIncludes(
    b.failures[0],
    "without a `// sanitizer: <reason>` comment (baseline 0; lines 7)",
  );
  assertEquals(c.failures, ["1 opt-outs (baseline 0)"]);
  // Fewer, or none left at all, passes and can be lowered.
  const down = checkRatchet(scan({ "tests/a.test.ts": [2, [1, 2]] }), baseline);
  assertEquals(down.map((r) => [r.file, r.failures, r.lowered]), [
    ["tests/a.test.ts", [], true],
    ["tests/b.test.ts", [], true],
  ]);
});

Deno.test("sanitizer ratchet: --update only lowers, and drops files with none left", () => {
  const baseline: Baseline = {
    "tests/a.test.ts": [4, 4],
    "tests/b.test.ts": [2, 2],
    "tests/c.test.ts": [3, 3],
  };
  assertEquals(
    lowerBaseline(
      scan({
        "tests/a.test.ts": [6, [1, 2, 3, 4, 5, 6]], // over: kept at the baseline, never raised
        "tests/b.test.ts": [1, []], // lowered, the rest explained
        "tests/new.test.ts": [1, [1]], // never added
      }),
      baseline,
    ),
    { "tests/a.test.ts": [4, 4], "tests/b.test.ts": [1, 0] },
  );
});

Deno.test("sanitizer ratchet: the CLI checks a tree and lowers its baseline", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "tests/node_modules/x"), { recursive: true });
    await Deno.mkdir(join(root, "scripts"));
    await Deno.writeTextFile(
      join(root, "tests/a.test.ts"),
      `Deno.test({ ${OPS}, ${RES} }, () => {});\n`,
    );
    // A dependency's own tests are not the project's.
    await Deno.writeTextFile(join(root, "tests/node_modules/x/t.test.ts"), `({ ${OPS} });\n`);
    const path = join(root, BASELINE_FILE);
    await Deno.writeTextFile(path, formatBaseline({ "tests/a.test.ts": [1, 1] }));
    assertEquals(await main([], root), 1);
    await Deno.writeTextFile(
      path,
      formatBaseline({ "tests/a.test.ts": [3, 3], "tests/gone.test.ts": [1, 1] }),
    );
    assertEquals(await main([], root), 0);
    assertEquals(await main(["--update"], root), 0);
    assertEquals(await Deno.readTextFile(path), formatBaseline({ "tests/a.test.ts": [2, 2] }));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
