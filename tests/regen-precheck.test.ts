// `deno task regen` and `deno task precheck` (scripts/regen.ts, scripts/precheck.ts): the local
// gate a push runs (.githooks/pre-push) so CI's drift tests stop being the first to notice a stale
// generated file.

import { assert, assertEquals, assertFalse } from "@std/assert";
import { join } from "@std/path";
import { allOutputs, regen, type RegenStep, STEPS } from "../scripts/regen.ts";
import { rewriteSerialList } from "../scripts/gen-serial-tests.ts";
import {
  AFFECTED_TESTS_CAP,
  DRIFT_TESTS,
  isCheckable,
  isPublishedSource,
  reachesClientBundle,
  typeCheckArgs,
} from "../scripts/precheck.ts";

const ROOT = new URL("../", import.meta.url);

Deno.test("regen: every output is a committed file, and no two steps of one phase write the same one", async () => {
  for (const p of allOutputs()) {
    assert((await Deno.stat(new URL(p, ROOT))).isFile, `${p} is missing`);
  }
  for (const phase of [1, 2, 3, 4]) {
    const outs = STEPS.filter((s) => s.phase === phase).flatMap((s) => s.outputs);
    assertEquals(outs.length, new Set(outs).size, `phase ${phase} writes a file twice`);
  }
  // The corpus reads the docs pages the earlier phases write; the llms files come last.
  const phaseOf = (name: string) => STEPS.find((s) => s.name.endsWith(name))!.phase;
  assert(phaseOf("docs:corpus") > phaseOf("docs:cli"));
  assert(phaseOf("docs:corpus") > phaseOf("gen:plugin-catalog"));
  assert(phaseOf("docs:llms") > phaseOf("docs:corpus"));
});

Deno.test("regen: the drift tests' generators are all steps", () => {
  const names = STEPS.map((s) => s.name).join("\n");
  for (
    const task of [
      "gen:command-table",
      "gen:native-templates",
      "gen:config-schema",
      "gen:plugin-catalog",
      "docs:mcp",
      "docs:cli",
      "docs:examples",
      "docs:fixed",
      "docs:corpus",
      "docs:llms",
      "gen-expo-shim-docs",
      "gen-rn-community-docs",
      "install.sh",
      "install.ps1",
      "package scripts",
      "gen-serial-tests",
      "sync:example-locks",
    ]
  ) assert(names.includes(task), `no regen step for ${task}`);
});

async function fixture(): Promise<{ dir: string; steps: RegenStep[] }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_regen_" });
  await Deno.writeTextFile(join(dir, "current.txt"), "same\n");
  await Deno.writeTextFile(join(dir, "stale.txt"), "old\n");
  const steps: RegenStep[] = [
    {
      name: "keeps current.txt",
      run: () => Deno.writeTextFile(join(dir, "current.txt"), "same\n"),
      outputs: ["current.txt"],
      phase: 1,
    },
    {
      name: "rewrites stale.txt",
      run: () => Deno.writeTextFile(join(dir, "stale.txt"), "new\n"),
      outputs: ["stale.txt"],
      phase: 1,
    },
    {
      name: "creates added.txt",
      run: () => Deno.writeTextFile(join(dir, "added.txt"), "x\n"),
      outputs: ["added.txt"],
      phase: 2,
    },
  ];
  return { dir, steps };
}

Deno.test("regen --check: lists the stale outputs with their step and leaves every file as it was", async () => {
  const { dir, steps } = await fixture();
  try {
    const { stale, staleBy } = await regen({ check: true, quiet: true, steps, root: dir });
    assertEquals(stale, ["stale.txt", "added.txt"]);
    assertEquals(staleBy.get("stale.txt"), "rewrites stale.txt");
    assertEquals(await Deno.readTextFile(join(dir, "stale.txt")), "old\n", "restored");
    assertEquals(await Deno.readTextFile(join(dir, "current.txt")), "same\n");
    await Deno.stat(join(dir, "added.txt")).then(
      () => assert(false, "a file the check created is removed again"),
      () => {},
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("regen: without --check the regenerated files stay written", async () => {
  const { dir, steps } = await fixture();
  try {
    const { stale } = await regen({ quiet: true, steps, root: dir });
    assertEquals(stale, ["stale.txt", "added.txt"]);
    assertEquals(await Deno.readTextFile(join(dir, "stale.txt")), "new\n");
    assertEquals(await Deno.readTextFile(join(dir, "added.txt")), "x\n");
    assertEquals((await regen({ check: true, quiet: true, steps, root: dir })).stale, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("regen --check: a failing step still restores what earlier steps rewrote", async () => {
  const { dir, steps } = await fixture();
  try {
    const failing: RegenStep = {
      name: "fails",
      run: () => Promise.reject(new Error("boom")),
      outputs: [],
      phase: 3,
    };
    let threw = false;
    await regen({ check: true, quiet: true, steps: [...steps, failing], root: dir }).catch(() => {
      threw = true;
    });
    assert(threw);
    assertEquals(await Deno.readTextFile(join(dir, "stale.txt")), "old\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("precheck: the drift tests it runs exist", async () => {
  for (const t of DRIFT_TESTS) assert((await Deno.stat(new URL(t, ROOT))).isFile, t);
});

Deno.test("precheck: which changes trigger the bundle budget, doc-lint and the type-check", () => {
  assert(reachesClientBundle("src/runtime/fiber/commit.ts"));
  assert(reachesClientBundle("src/client/client-runtime.ts"));
  assert(reachesClientBundle("src/build/build.ts"));
  assertFalse(reachesClientBundle("src/cli/commands/analyze.ts"));
  assertFalse(reachesClientBundle("src/server/auth/session.ts"));
  assertFalse(reachesClientBundle("tests/build.test.ts"));
  assertFalse(reachesClientBundle("src/runtime/x.vitest.ts"));

  assert(isPublishedSource("src/server/mod.ts"));
  assert(isPublishedSource("packages/backend/server.ts"));
  assert(isPublishedSource("mod.ts"));
  assertFalse(isPublishedSource("tests/x.test.ts"));
  assertFalse(isPublishedSource("scripts/regen.ts"));

  assert(isCheckable("tests/a.test.ts"));
  assert(isCheckable("tests/a.vitest.ts"));
  assert(isCheckable("scripts/precheck.ts"));
  assertFalse(isCheckable("examples/hello/app/page.tsx"), "examples have their own config");
  assertFalse(isCheckable("tests/fixtures/app/page.tsx"));
  assertFalse(isCheckable("src/types.d.ts"));
  assertFalse(isCheckable("CHANGELOG.md"));
});

Deno.test("precheck: the type-check runs on denext's toolchain (TypeScript 7), never PATH's deno", async () => {
  const args = typeCheckArgs(["src/a.ts", "tests/b.vitest.ts"]);
  assertEquals(args.slice(0, 4), ["run", "-A", "scripts/toolchain-deno.ts", "check"]);
  assertEquals(args.slice(4), ["cli.ts", "mod.ts", "src/a.ts", "tests/b.vitest.ts"]);
  const src = await Deno.readTextFile(new URL("scripts/precheck.ts", ROOT));
  assert(src.includes("deno(typeCheckArgs(checkable))"), "the step runs typeCheckArgs");
  assertFalse(/deno\(\["check"/.test(src), "no type-check on the running Deno");
});

Deno.test("precheck: the badge check and the affected tests run, the tests capped", async () => {
  const src = await Deno.readTextFile(new URL("scripts/precheck.ts", ROOT));
  assert(src.includes(`["task", "badge:tests", "--check"]`));
  assert(src.includes("affectedTests(changed, await parallelSuiteFiles())"));
  assert(AFFECTED_TESTS_CAP > 0 && AFFECTED_TESTS_CAP <= 50);
});

Deno.test("gen-serial-tests: adds in path order, drops an entry with its comment, keeps the rest", () => {
  const text = [
    "// head",
    "export const SERIAL_TESTS: readonly string[] = [",
    "  // Why a stays serial.",
    '  "tests/a.test.ts",',
    "  // Why c was serial.",
    '  "tests/c.test.ts",',
    '  "tests/e.test.ts",',
    "];",
    "export const OTHER = [];",
    "",
  ].join("\n");
  assertEquals(
    rewriteSerialList(text, [
      "tests/a.test.ts",
      "tests/b.test.ts",
      "tests/e.test.ts",
      "tests/f.test.ts",
    ]),
    [
      "// head",
      "export const SERIAL_TESTS: readonly string[] = [",
      "  // Why a stays serial.",
      '  "tests/a.test.ts",',
      '  "tests/b.test.ts",',
      '  "tests/e.test.ts",',
      '  "tests/f.test.ts",',
      "];",
      "export const OTHER = [];",
      "",
    ].join("\n"),
  );
  assertEquals(
    rewriteSerialList(text, ["tests/a.test.ts", "tests/c.test.ts", "tests/e.test.ts"]),
    text,
  );
});
