// The per-file coverage floor (scripts/coverage-floor.ts) that `deno task test:coverage` runs
// after the aggregate threshold: lcov parsing, which files are floored, and the verdicts — a file
// under the floor on any metric, or one no test ever loaded, fails the gate.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join, resolve } from "@std/path";
import { checkFloor, flooredFiles, main, parseLcov, pct } from "../scripts/coverage-floor.ts";

const LCOV = `TN:
SF:/p/src/desktop/a.ts
FN:1,f
FN:5,g
FNDA:3,f
FNDA:0,g
FNF:2
FNH:1
BRDA:2,0,0,1
BRDA:2,0,1,0
BRDA:3,1,0,-
DA:1,3
DA:2,3
DA:3,0
DA:5,0
end_of_record
SF:/p/src/desktop/caps/b.ts
DA:1,1
end_of_record
`;

Deno.test("parseLcov: counts lines, branches (`-` = not taken) and functions per file", () => {
  const m = parseLcov(LCOV.replaceAll("\n", "\r\n"));
  assertEquals(m.get("/p/src/desktop/a.ts"), {
    lines: [2, 4],
    branches: [1, 3],
    functions: [1, 2],
  });
  assertEquals(m.get("/p/src/desktop/caps/b.ts"), {
    lines: [1, 1],
    branches: [0, 0],
    functions: [0, 0],
  });
  // Lines outside a record are ignored.
  assertEquals(parseLcov("DA:1,1\nend_of_record\n").size, 0);
});

Deno.test("pct: a metric with nothing to cover is 100%", () => {
  assertEquals(pct([0, 0]), 100);
  assertEquals(pct([1, 4]), 25);
});

Deno.test("checkFloor: each metric is held to the floor; an unloaded file fails", () => {
  const lcov = parseLcov(LCOV);
  const files = ["src/desktop/a.ts", "src/desktop/caps/b.ts", "src/desktop/never.ts"];
  const results = checkFloor(files, lcov, "/p", 85);
  assertEquals(results.map((r) => [r.file, r.failures]), [
    ["src/desktop/a.ts", ["lines 50.0%", "branches 33.3%", "functions 50.0%"]],
    ["src/desktop/caps/b.ts", []],
    ["src/desktop/never.ts", ["never loaded by a test"]],
  ]);
  assertEquals(checkFloor(["src/desktop/a.ts"], lcov, "/p", 30)[0].failures, []);
});

Deno.test("flooredFiles: src/desktop recursively, and only src/build/desktop*.ts", async () => {
  const root = await Deno.makeTempDir();
  try {
    for (
      const f of [
        "src/desktop/a.ts",
        "src/desktop/caps/b.ts",
        "src/desktop/notes.md",
        "src/build/desktop.ts",
        "src/build/desktop-runtime.ts",
        "src/build/desktop-runtime-pin.json",
        "src/build/export.ts",
        "src/build/nested/desktop-x.ts",
      ]
    ) {
      await Deno.mkdir(join(root, f, ".."), { recursive: true });
      await Deno.writeTextFile(join(root, f), "");
    }
    assertEquals(await flooredFiles(root), [
      "src/build/desktop-runtime.ts",
      "src/build/desktop.ts",
      "src/desktop/a.ts",
      "src/desktop/caps/b.ts",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main: exit 1 naming the files under the floor, 0 when all pass, --report always 0", async () => {
  const root = await Deno.makeTempDir();
  const errs: string[] = [];
  const logs: string[] = [];
  const prev = [console.error, console.log] as const;
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    await Deno.mkdir(join(root, "src/desktop"), { recursive: true });
    await Deno.mkdir(join(root, "src/build"), { recursive: true });
    await Deno.writeTextFile(join(root, "src/desktop/a.ts"), "");
    const file = join(root, "lcov.info");
    const abs = resolve(root, "src/desktop/a.ts");
    await Deno.writeTextFile(file, `SF:${abs}\nDA:1,1\nDA:2,0\nend_of_record\n`);
    assertEquals(await main([file], root), 1);
    assertStringIncludes(errs.join("\n"), "1 file(s) below 85%");
    assertStringIncludes(errs.join("\n"), "src/desktop/a.ts   <- lines 50.0%");
    assertEquals(await main([file, "--floor", "50"], root), 0);
    assertStringIncludes(logs.join("\n"), "1 files at or above 50% each");
    assertEquals(await main([file, "--report"], root), 0);
    assertStringIncludes(logs.join("\n"), "  50.0  100.0  100.0  src/desktop/a.ts");
    assertEquals(await main([], root), 2);
    assertStringIncludes(errs.join("\n"), "usage: coverage-floor.ts");
  } finally {
    [console.error, console.log] = prev;
    await Deno.remove(root, { recursive: true });
  }
});
