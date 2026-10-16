// `denext test` with Vitest files (src/cli/commands/test-passes.ts): the `Deno.test` pass, then
// the `*.vitest.ts` files Deno's discovery skips, and with `--coverage` ONE report over both — a
// module run by both passes is covered by either (the toolchain's `deno coverage` maps each
// profile back through the form its module was emitted in, then merges them line for line).

import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import {
  coverageDir,
  findVitestFiles,
  planTestRun,
  splitTestArgs,
} from "../src/cli/commands/test-passes.ts";
import { resolveDenoToolchain } from "../src/build/deno-toolchain.ts";
import { removeTempDirSync } from "./helpers/temp.ts";

const CLI = new URL("../cli.ts", import.meta.url).pathname;

Deno.test("splitTestArgs: flags with their values, paths, and the -- tail", () => {
  assertEquals(splitTestArgs(["--filter", "x", "a.test.ts", "--parallel", "--", "--y"]), {
    flags: ["--filter", "x", "--parallel"],
    paths: ["a.test.ts"],
    tail: ["--", "--y"],
  });
  assertEquals(coverageDir(["--coverage"]), "coverage");
  assertEquals(coverageDir(["--coverage=cov"]), "cov");
  assertEquals(coverageDir(["--", "--coverage=cov"]), undefined);
});

Deno.test("planTestRun: one pass when a path is named, nothing is Vitest, or --help", () => {
  const one = (args: string[]) => ({ passes: [["test", "-A", ...args]], report: [] });
  assertEquals(planTestRun(["a.test.ts"], ["v.vitest.ts"], true), one(["a.test.ts"]));
  assertEquals(planTestRun(["--coverage"], [], true), one(["--coverage"]));
  assertEquals(planTestRun(["--help"], ["v.vitest.ts"], true), one(["--help"]));
});

Deno.test("planTestRun: the Vitest pass after the Deno.test pass", () => {
  assertEquals(planTestRun(["--filter", "x", "--", "arg"], ["t/v.vitest.ts"], true), {
    passes: [
      ["test", "-A", "--filter", "x", "--", "arg"],
      ["test", "-A", "--filter", "x", "t/v.vitest.ts", "--", "arg"],
    ],
    report: [],
  });
});

Deno.test("planTestRun: --coverage accumulates both passes, then one report", () => {
  assertEquals(planTestRun(["--coverage=cov"], ["v.vitest.ts"], true), {
    passes: [
      ["test", "-A", "--coverage=cov", "--coverage-raw-data-only"],
      ["test", "-A", "--coverage=cov", "--coverage-raw-data-only", "v.vitest.ts"],
    ],
    clean: "cov",
    report: [
      ["coverage", "cov"],
      ["coverage", "cov", "--lcov", "--output=cov/lcov.info"],
      ["coverage", "cov", "--html"],
    ],
  });
  // Raw data asked for: the passes accumulate, and the caller reports.
  const raw = planTestRun(["--coverage", "--coverage-raw-data-only"], ["v.vitest.ts"], true);
  assertEquals(raw.report, []);
  assertEquals(raw.clean, undefined);
  assertEquals(raw.passes.length, 2);
});

Deno.test("planTestRun: off the toolchain, or watching, the Vitest files are named, not run", () => {
  const stock = planTestRun(["--coverage"], ["v.vitest.ts"], false);
  assertEquals(stock.passes, [["test", "-A", "--coverage"]]);
  assertMatch(stock.note ?? "", /1 Vitest file\(s\) not run: .*toolchain/);
  const watch = planTestRun(["--watch"], ["v.vitest.ts"], true);
  assertEquals(watch.passes, [["test", "-A", "--watch"]]);
  assertMatch(watch.note ?? "", /--watch/);
});

Deno.test("findVitestFiles: project Vitest files, not dependencies, dot dirs or output", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-vitest-find-" });
  try {
    for (
      const rel of [
        "tests/a.vitest.ts",
        "src/b.vitest.tsx",
        "c.test.ts",
        "node_modules/p/d.vitest.ts",
        ".denext/e.vitest.ts",
        "dist/f.vitest.js",
      ]
    ) {
      await Deno.mkdir(join(root, rel, ".."), { recursive: true });
      await Deno.writeTextFile(join(root, rel), "");
    }
    assertEquals(await findVitestFiles(root), ["src/b.vitest.tsx", "tests/a.vitest.ts"]);
    assertEquals(await findVitestFiles(join(root, "missing")), []);
  } finally {
    removeTempDirSync(root);
  }
});

/** denext's Deno toolchain binary, or null when it is unavailable here. */
async function toolchain(): Promise<string | null> {
  if (/-denext\.\d+$/.test(Deno.version.deno)) return Deno.execPath();
  const choice = await resolveDenoToolchain().catch(() => null);
  return choice?.kind === "toolchain" ? choice.deno : null;
}

Deno.test({
  name: "denext test --coverage: a module run by a Deno.test file and a Vitest file, one report",
  sanitizeResources: false,
  sanitizeOps: false,
  ignore: (await toolchain()) === null,
}, async () => {
  const deno = (await toolchain())!;
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-vitest-cov-" }));
  try {
    await Deno.writeTextFile(join(root, "deno.json"), "{}");
    await Deno.writeTextFile(
      join(root, "mod.ts"),
      `export function plain() {\n  return "plain";\n}\n` +
        `export function viaVitest() {\n  return "vitest";\n}\n` +
        `export function never() {\n  return "never";\n}\n`,
    );
    await Deno.writeTextFile(
      join(root, "mod.test.ts"),
      `import { plain } from "./mod.ts";\n` +
        `Deno.test("plain", () => { if (plain() !== "plain") throw new Error(); });\n`,
    );
    await Deno.writeTextFile(
      join(root, "mod.vitest.ts"),
      `import { expect, test, vi } from "vitest";\nimport { viaVitest } from "./mod.ts";\n` +
        `test("vitest", () => { vi.useFakeTimers(); expect(viaVitest()).toBe("vitest"); });\n`,
    );
    const out = await new Deno.Command(deno, {
      args: ["run", "-A", CLI, "test", "--coverage=cov"],
      cwd: root,
      env: { DENEXT_DENO: deno, NO_COLOR: "1" },
      stdin: "null",
    }).output();
    const log = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
    assert(out.success, log);
    const lcov = await Deno.readTextFile(join(root, "cov", "lcov.info"));
    // Both passes count: the Vitest-only function is covered alongside the plain one.
    assertMatch(lcov, /FNDA:1,plain/);
    assertMatch(lcov, /FNDA:1,viaVitest/);
    assertMatch(lcov, /FNDA:0,never/);
  } finally {
    removeTempDirSync(root);
  }
});
