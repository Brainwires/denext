// The serial list stays true: every test file that changes process-wide state (`Deno.env.set` /
// `Deno.env.delete` / `Deno.chdir`, itself, through a listed helper, or by running a src export
// listed in `SERIAL_SOURCES`, followed through the imports) is in `tests/serial-tests.ts`, and every
// listed file still does; every src module that changes it is listed; and `scripts/test-run.ts`
// keeps the listed files out of the parallel pass.

import { assert, assertEquals } from "@std/assert";
import {
  SERIAL_HELPERS,
  SERIAL_SOURCE_EXEMPT,
  SERIAL_SOURCES,
  SERIAL_TESTS,
} from "./serial-tests.ts";
import {
  MUTATES,
  mutates,
  mutatingTestFiles,
  parallelSuiteFiles,
  serialSourceRun,
  sources,
} from "../scripts/lib/serial-scan.ts";
import {
  findVitestFiles,
  isToolchainBuild,
  removeTempRoot,
  stockPassDeno,
  tempRootEnv,
  testPasses,
  wantsCoverage,
} from "../scripts/test-run.ts";
import { fromFileUrl, join } from "@std/path";

Deno.test("serial tests: each file that changes process-wide state is listed, and only those", async () => {
  // Stale? `deno task regen` rewrites the list (scripts/gen-serial-tests.ts); then commit it.
  assertEquals(await mutatingTestFiles(), [...SERIAL_TESTS].sort());
  const files = await parallelSuiteFiles();
  const helpers = new Set(SERIAL_HELPERS);
  for (const h of helpers) assert(await mutates(h, files.get(h) ?? ""), `${h} no longer mutates`);
  // A helper (not a test) that starts mutating must be listed with the helpers.
  const unlisted: string[] = [];
  for (const [path, src] of files) {
    if (path.endsWith(".test.ts") || path === "tests/serial-tests.ts" || helpers.has(path)) {
      continue;
    }
    if (await mutates(path, src)) unlisted.push(path);
  }
  assertEquals(unlisted, []);
});

Deno.test("serial tests: every src module that changes process-wide state is listed", async () => {
  const src = await sources("src");
  const mutating = [...src].filter(([, text]) => MUTATES.test(text)).map(([p]) => p).sort();
  const listed = [...Object.keys(SERIAL_SOURCES), ...Object.keys(SERIAL_SOURCE_EXEMPT)].sort();
  assertEquals(mutating, listed);
  // Each listed export is still exported from its module.
  for (const [source, { exports }] of Object.entries(SERIAL_SOURCES)) {
    for (const name of exports) {
      const exported = new RegExp(
        `\\bexport\\s+(?:async\\s+)?(?:function|const|let)\\s+${name}\\b`,
      );
      assert(exported.test(src.get(source)!), `${source} no longer exports ${name}`);
    }
  }
});

Deno.test("serial tests: a test is serial when it runs a listed src export or verb", async () => {
  const at = "tests/x.test.ts";
  // An import of the export, straight from its module or through a module that re-exports it.
  assertEquals(
    await serialSourceRun(at, `import { loadEnv } from "../src/server/env.ts";`),
    "src/server/env.ts",
  );
  assertEquals(
    await serialSourceRun(at, `import { loadEnv as l } from "denext/server";`),
    "src/server/env.ts",
  );
  // A verb run through the registry.
  assertEquals(
    await serialSourceRun(
      at,
      `import { buildRegistry } from "../src/cli/register.ts";\nbuildRegistry().get("analyze")!.run(c);`,
    ),
    "src/cli/commands/analyze.ts",
  );
  // A lookup without a run, a same-named import from elsewhere, or another export of the module
  // is not a run.
  assertEquals(
    await serialSourceRun(
      at,
      `import { buildRegistry } from "../src/cli/register.ts";\nbuildRegistry().get("dev");`,
    ),
    undefined,
  );
  assertEquals(
    await serialSourceRun(at, `import { loadEnv } from "../scripts/env.ts";`),
    undefined,
  );
  assertEquals(
    await serialSourceRun(at, `import { parseEnv } from "../src/server/env.ts";`),
    undefined,
  );
});

Deno.test("test-run: the serial files leave the parallel pass and run on their own", () => {
  const serial = ["tests/a.test.ts", "tests/integration/b.test.ts", "tests/e2e/c.test.ts"];
  const all = testPasses(["--ignore=tests/e2e/,tests/migration-bed/"], serial);
  assertEquals(all.parallel, [
    "test",
    "-A",
    "--unstable-kv",
    "--parallel",
    "--ignore=tests/e2e/,tests/migration-bed/,tests/a.test.ts,tests/integration/b.test.ts",
  ]);
  assertEquals(all.serial, [
    "test",
    "-A",
    "--unstable-kv",
    "tests/a.test.ts",
    "tests/integration/b.test.ts",
  ]);
  // A path narrows both passes; flags reach both.
  const integration = testPasses(["--fail-fast", "tests/integration/"], serial);
  assertEquals(integration.parallel, [
    "test",
    "-A",
    "--unstable-kv",
    "--fail-fast",
    "--parallel",
    "--ignore=tests/integration/b.test.ts",
    "tests/integration/",
  ]);
  assertEquals(integration.serial, [
    "test",
    "-A",
    "--unstable-kv",
    "--fail-fast",
    "tests/integration/b.test.ts",
  ]);
  assertEquals(testPasses(["tests/other/"], serial).serial, null);
});

Deno.test("test-run: a flag's separate value stays with its flag; `--` args reach both passes", () => {
  const serial = ["tests/a.test.ts"];
  const passes = testPasses(
    ["--filter", "foo bar", "-c", "deno.json", "--reporter=dot", "tests/", "--", "--x", "y"],
    serial,
  );
  assertEquals(passes.parallel, [
    "test",
    "-A",
    "--unstable-kv",
    "--filter",
    "foo bar",
    "-c",
    "deno.json",
    "--reporter=dot",
    "--parallel",
    "--ignore=tests/a.test.ts",
    "tests/",
    "--",
    "--x",
    "y",
  ]);
  assertEquals(passes.serial, [
    "test",
    "-A",
    "--unstable-kv",
    "--filter",
    "foo bar",
    "-c",
    "deno.json",
    "--reporter=dot",
    "tests/a.test.ts",
    "--",
    "--x",
    "y",
  ]);
  // `foo` was a value, not a path: with no path, every serial file is in scope.
  assertEquals(testPasses(["--filter", "foo"], serial).serial?.at(-1), "tests/a.test.ts");
});

Deno.test("test-run: the Vitest files run in their own pass, never in the stock ones", () => {
  const serial = ["tests/a.test.ts"];
  const vitest = ["tests/v.vitest.ts", "tests/integration/w.vitest.ts"];
  const all = testPasses(["--ignore=tests/e2e/", "--reporter=dot"], serial, vitest);
  // A `.vitest.ts` file is outside Deno's default discovery: the stock passes need no ignore.
  assertEquals(all.parallel, [
    "test",
    "-A",
    "--unstable-kv",
    "--reporter=dot",
    "--parallel",
    "--ignore=tests/e2e/,tests/a.test.ts",
  ]);
  // The pass gets only the grants its files use.
  assertEquals(all.vitest, [
    "test",
    "--allow-read",
    "--allow-write",
    "--unstable-kv",
    "--reporter=dot",
    "--parallel",
    "tests/v.vitest.ts",
    "tests/integration/w.vitest.ts",
  ]);
  // Paths and ignores narrow it like the others.
  assertEquals(testPasses(["tests/integration/"], serial, vitest).vitest?.at(-1), vitest[1]);
  assertEquals(
    testPasses(["--ignore=tests/integration/"], serial, vitest).vitest?.at(-1),
    vitest[0],
  );
  assertEquals(testPasses(["tests/other/"], serial, vitest).vitest, null);
  // Outside CI the pass skips type-checking (a toolchain build would wipe stock Deno's check
  // cache), unless the flags already decide.
  assertEquals(testPasses(["tests/integration/"], serial, vitest, false).vitest, [
    "test",
    "--allow-read",
    "--allow-write",
    "--unstable-kv",
    "--no-check",
    "--parallel",
    "tests/integration/w.vitest.ts",
  ]);
  assertEquals(
    testPasses(["--check=all", "tests/integration/"], serial, vitest, false).vitest?.[4],
    "--check=all",
  );
  // A Vitest file named on its own runs in the Vitest pass only.
  const one = testPasses(["tests/v.vitest.ts"], serial, vitest);
  assertEquals(one.parallel, null);
  assertEquals(one.serial, null);
  assertEquals(one.vitest?.at(-1), "tests/v.vitest.ts");
});

Deno.test("test-run: --vitest-allow-env grants the Vitest pass those variables alone", () => {
  const serial = ["tests/a.test.ts"];
  const vitest = ["tests/v.vitest.ts"];
  const passes = testPasses(
    ["--vitest-allow-env=A_VAR,B_VAR", "--preload", "p.ts", "tests/"],
    serial,
    vitest,
  );
  assertEquals(passes.vitest, [
    "test",
    "--allow-read",
    "--allow-write",
    "--allow-env=A_VAR,B_VAR",
    "--unstable-kv",
    "--preload",
    "p.ts",
    "--parallel",
    "tests/v.vitest.ts",
  ]);
  // The stock passes already run with -A; the flag is test-run's own, never Deno's.
  for (const pass of [passes.parallel, passes.serial]) {
    assert(pass && !pass.some((a) => a.includes("vitest-allow-env") || a === "A_VAR,B_VAR"));
  }
});

Deno.test("test-run: with coverage every pass accumulates raw profiles, the stock files in one sequential pass", () => {
  const serial = ["tests/a.test.ts"];
  const vitest = ["tests/v.vitest.ts"];
  const passes = testPasses(["--ignore=tests/e2e/", "--coverage=cov"], serial, vitest);
  // No `--parallel` and no serial split: the serial files run in the same deterministic pass.
  assertEquals(passes.parallel, [
    "test",
    "-A",
    "--unstable-kv",
    "--coverage=cov",
    "--coverage-raw-data-only",
    "--ignore=tests/e2e/",
  ]);
  assertEquals(passes.serial, null);
  // The Vitest pass writes into the same directory, without emptying it.
  assertEquals(passes.vitest, [
    "test",
    "--allow-read",
    "--allow-write",
    "--unstable-kv",
    "--coverage=cov",
    "--coverage-raw-data-only",
    "--parallel",
    "tests/v.vitest.ts",
  ]);
  // An explicit `--coverage-raw-data-only` is not doubled.
  const raw = testPasses(["--coverage=cov", "--coverage-raw-data-only"], serial, vitest);
  assertEquals(raw.parallel?.filter((a) => a === "--coverage-raw-data-only").length, 1);
  assert(wantsCoverage(["--coverage"]));
  assert(!wantsCoverage(["--coverage-raw-data-only", "--reporter=dot"]));
});

Deno.test("test-run: every Vitest file under tests/ is found, and only toolchain builds run them", async () => {
  const found = await findVitestFiles();
  assert(found.length > 0, "the repo has Vitest files");
  for (const f of found) {
    assert(f.startsWith("tests/") && f.endsWith(".vitest.ts"), f);
    assert(
      !SERIAL_TESTS.includes(f),
      `${f}: a Vitest file runs in its own pass, never the serial one`,
    );
  }
  assert(isToolchainBuild({ deno: "2.9.7-denext.17" }));
  assert(isToolchainBuild({ deno: "3.0.0-rc.3", denext: "3.0.0-rc.3" }), "the identity marker");
  assert(isToolchainBuild({ deno: "3.0.0-rc.3+ci.42", denext: "3.0.0-rc.3+ci.42" }));
  assert(!isToolchainBuild({ deno: "3.0.0-rc.3" }), "upstream Deno of the same number");
  assert(!isToolchainBuild({ deno: "2.9.6" }));
  assert(!isToolchainBuild({ deno: "2.9.7" }));
});

Deno.test("test-run: tempRootEnv points every platform's temp-dir variable at the root", () => {
  assertEquals(tempRootEnv("/r"), { TMPDIR: "/r", TMP: "/r", TEMP: "/r" });
});

Deno.test("test-run: removeTempRoot removes a full root and tolerates a missing one", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext_tr_root_" });
  await Deno.mkdir(join(root, "a", "b"), { recursive: true });
  await Deno.writeTextFile(join(root, "a", "b", "f"), "x");
  await removeTempRoot(root);
  assertEquals(await Deno.stat(root).then(() => true, () => false), false);
  await removeTempRoot(root); // already gone: no throw
});

Deno.test("test-run: the temp dirs a test leaves behind go with the run's temp root", async () => {
  // The machine's temp dir, as the run sees it: nothing may be left in it afterwards.
  const machineTmp = await Deno.makeTempDir({ prefix: "denext_tr_machine_" });
  const probe = join(machineTmp, "leak_probe_test.ts");
  try {
    await Deno.writeTextFile(
      probe,
      `Deno.test("leaks a temp dir", async () => {\n` +
        `  const d = await Deno.makeTempDir({ prefix: "leaked_" });\n` +
        `  await Deno.writeTextFile(d + "/f", "x");\n` +
        `});\n`,
    );
    const script = fromFileUrl(new URL("../scripts/test-run.ts", import.meta.url));
    const { success, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", script, "--no-check", probe],
      env: { ...tempRootEnv(machineTmp), DENEXT_DENO: "stock" },
      stdout: "null",
      stderr: "piped",
    }).output();
    assert(success, new TextDecoder().decode(stderr));
    const left = [...Deno.readDirSync(machineTmp)].map((e) => e.name).filter((n) =>
      n !== "leak_probe_test.ts"
    );
    assertEquals(left, [], "the run left these in the temp dir");
  } finally {
    await Deno.remove(machineTmp, { recursive: true });
  }
});

Deno.test("test-run: the stock test files run on the toolchain whenever it resolved", () => {
  // Not only under coverage: the suite runs on the Deno users run (ci.yml's check job included).
  assertEquals(
    stockPassDeno("/cache/denext-deno/3.0.0-rc.2/deno", "/usr/bin/deno"),
    "/cache/denext-deno/3.0.0-rc.2/deno",
  );
  // `DENEXT_DENO=stock` (null) and a toolchain that could not be had (false): the running Deno.
  assertEquals(stockPassDeno(null, "/usr/bin/deno"), "/usr/bin/deno");
  assertEquals(stockPassDeno(false, "/usr/bin/deno"), "/usr/bin/deno");
});
