// The serial list stays true: every test file that changes process-wide state (`Deno.env.set` /
// `Deno.env.delete` / `Deno.chdir`, itself, through a listed helper, or by running a src export
// listed in `SERIAL_SOURCES`, followed through the imports) is in `tests/serial-tests.ts`, and every
// listed file still does; every src module that changes it is listed; and `scripts/test-run.ts`
// keeps the listed files out of the parallel pass.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  SERIAL_HELPERS,
  SERIAL_SOURCE_EXEMPT,
  SERIAL_SOURCES,
  SERIAL_TESTS,
  serialTestsFor,
  WINDOWS_SERIAL_TESTS,
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
  ALLOW_SKIP_VITEST_ENV,
  configTestExcludes,
  coverageDir,
  emitEntrySource,
  findVitestFiles,
  heapEnv,
  isToolchainBuild,
  profiledModules,
  reEmitCovered,
  removeTempRoot,
  stockPassDeno,
  tempRootEnv,
  tempRootSurvived,
  testPasses,
  TOOL_CACHE_DIRS,
  vitestSkipAllowed,
  wantsCoverage,
  WATCHDOG_PRELOAD,
  withWatchdog,
} from "../scripts/test-run.ts";
import { basename, fromFileUrl, join, toFileUrl } from "@std/path";
import { boundedOutput } from "./helpers/bounded-command.ts";

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
    "--ignore=tests/e2e/,tests/migration-bed/,tests/a.test.ts,tests/integration/b.test.ts,.deno/,.denext/,coverage/",
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
    "--ignore=tests/integration/b.test.ts,.deno/,.denext/,coverage/",
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

Deno.test("test-run: a serial file named on its own runs in the serial pass alone", () => {
  const serial = ["tests/s.test.ts", "tests/live-views.test.ts"];
  const named = testPasses(
    ["tests/a.test.ts", "./tests/s.test.ts", "tests/live-views.test.ts"],
    serial,
  );
  assertEquals(named.serial?.slice(-2), ["tests/s.test.ts", "tests/live-views.test.ts"]);
  const parallel = named.parallel!;
  assert(parallel.includes("tests/a.test.ts"));
  assert(!parallel.includes("tests/s.test.ts") && !parallel.includes("./tests/s.test.ts"));
  assert(!parallel.includes("tests/live-views.test.ts"));
  // Only serial files named: no parallel pass at all.
  const only = testPasses(["tests/s.test.ts"], serial);
  assertEquals(only.parallel, null);
  assertEquals(only.serial?.at(-1), "tests/s.test.ts");
  // With coverage the stock files share one pass, the serial ones included.
  const cov = testPasses(["--coverage=cov", "tests/s.test.ts"], serial);
  assertEquals(cov.serial, null);
  assert(cov.parallel?.includes("tests/s.test.ts"));
});

Deno.test("test-run: the stock passes preload the per-test stall watchdog", async () => {
  assertEquals(withWatchdog(["test", "-A", "tests/a.test.ts", "--", "x"], "w.ts"), [
    "test",
    "--preload",
    "w.ts",
    "-A",
    "tests/a.test.ts",
    "--",
    "x",
  ]);
  assertEquals(withWatchdog(null), null);
  // The default is the preload module itself, by absolute path (any working directory).
  assertEquals(withWatchdog(["test"])?.[2], WATCHDOG_PRELOAD);
  assert((await Deno.stat(WATCHDOG_PRELOAD)).isFile);
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
    "--ignore=tests/a.test.ts,.deno/,.denext/,coverage/",
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
    "--ignore=tests/e2e/,tests/a.test.ts,.deno/,.denext/,coverage/",
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
    "--ignore=tests/e2e/,.deno/,.denext/,coverage/",
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

Deno.test("test-run: heapEnv gives a Windows pass a larger V8 heap, and nothing elsewhere", () => {
  const gib = 1024 ** 3;
  assertEquals(heapEnv("windows", undefined, 8 * gib), {
    DENO_V8_FLAGS: "--max-old-space-size=6144",
  });
  // Clamped to 4–8 GiB, and appended to flags already set.
  assertEquals(heapEnv("windows", undefined, 2 * gib), {
    DENO_V8_FLAGS: "--max-old-space-size=4096",
  });
  assertEquals(heapEnv("windows", "--stack-size=2000", 64 * gib), {
    DENO_V8_FLAGS: "--stack-size=2000,--max-old-space-size=8192",
  });
  // A heap size the caller chose wins; other OSes are left alone.
  assertEquals(heapEnv("windows", "--max-old-space-size=3000", 8 * gib), {});
  assertEquals(heapEnv("linux", undefined, 8 * gib), {});
  assertEquals(heapEnv("darwin", undefined, 8 * gib), {});
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

Deno.test("test-run: a temp root something else removed mid-run is reported, not left unexplained", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext_tr_root_" });
  assertEquals(await tempRootSurvived(root), true);
  await Deno.remove(root);
  const orig = console.error;
  const lines: string[] = [];
  console.error = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    assertEquals(await tempRootSurvived(root), false);
  } finally {
    console.error = orig;
  }
  assertEquals(lines.length, 1);
  assert(lines[0].includes(`temp root ${root} was removed by another process`), lines[0]);
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
    // Another run's root in the same temp dir (two runs on one machine): this run's cleanup must
    // leave it alone, removing only the root it made.
    const sibling = await Deno.makeTempDir({ dir: machineTmp, prefix: "dnx-tr-" });
    await Deno.writeTextFile(join(sibling, "in-use"), "x");
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
    assertEquals(left, [basename(sibling)], "the run left these in the temp dir");
    assertEquals(await Deno.readTextFile(join(sibling, "in-use")), "x", "the other run's root");
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

/** A call that builds or serves an app in the calling process. */
const IN_PROCESS_BUILD =
  /\b(?:startDevServer|startSpaDevServer|startProdServer|serveEphemeral|createTestApp|probeApp|createUnbundledDev|buildNextCompat\w*|bundleSpaInto|startBuild|esbuild\.(?:build|context))\(/;

Deno.test("serial tests: a file that builds in process under watchTests() runs serially on Windows", async () => {
  const files = await parallelSuiteFiles();
  const serial = new Set(serialTestsFor("windows"));
  const missing: string[] = [];
  for (const [path, src] of files) {
    if (!path.endsWith(".test.ts") || !src.includes("watchTests(")) continue;
    // Calls inside a template string run in a child (`inChild`), not here.
    const code = src.replace(/`(?:\\.|[^`\\])*`/g, "``");
    if (IN_PROCESS_BUILD.test(code) && !serial.has(path)) missing.push(path);
  }
  assertEquals(missing, [], "add them to WINDOWS_SERIAL_TESTS (tests/serial-tests.ts)");
  for (const path of WINDOWS_SERIAL_TESTS) {
    assert(files.has(path), `${path} is listed but does not exist`);
    assert(!SERIAL_TESTS.includes(path), `${path} is serial everywhere already`);
  }
  // Only Windows moves them; elsewhere the serial pass is unchanged.
  assertEquals(serialTestsFor("darwin"), SERIAL_TESTS);
  assertEquals(serialTestsFor("linux"), SERIAL_TESTS);
  assertEquals(serialTestsFor("windows"), [...SERIAL_TESTS, ...WINDOWS_SERIAL_TESTS]);
  const passes = testPasses(["tests/"], serialTestsFor("windows"));
  for (const path of WINDOWS_SERIAL_TESTS) {
    assert(passes.serial!.includes(path), path);
    assert(passes.parallel!.some((a) => a.startsWith("--ignore=") && a.includes(path)), path);
  }
});

Deno.test("test-run: DENEXT_DENO=stock fails the Vitest pass unless the skip is explicitly allowed", async () => {
  assertEquals(ALLOW_SKIP_VITEST_ENV, "DENEXT_ALLOW_SKIP_VITEST");
  assertEquals(vitestSkipAllowed(undefined), false);
  assertEquals(vitestSkipAllowed(""), false);
  assertEquals(vitestSkipAllowed("0"), false);
  assertEquals(vitestSkipAllowed("1"), true);
  // The pass reports the skip as a failure (never `return true` without the variable).
  const src = await Deno.readTextFile(new URL("../scripts/test-run.ts", import.meta.url));
  const body = src.slice(src.indexOf("async function runVitestPass("));
  const stockBranch = body.slice(0, body.indexOf("return await deno(args, bin);"));
  assert(stockBranch.includes("return false;"), stockBranch);
});

Deno.test("test-run: coverageDir names the profile directory the flags collect into", () => {
  assertEquals(coverageDir(["--fail-fast", "--coverage=coverage/profile"]), "coverage/profile");
  assertEquals(coverageDir(["--coverage"]), "coverage");
  assertEquals(coverageDir(["--fail-fast"]), null);
});

Deno.test("test-run: profiledModules lists the existing emitted modules under the roots, once", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_profiles_" });
  try {
    const src = join(dir, "repo", "src");
    await Deno.mkdir(join(src, "node_modules"), { recursive: true });
    for (const f of ["a.ts", "b.tsx", "c.d.ts", "d.js", "node_modules/e.ts"]) {
      await Deno.writeTextFile(join(src, f), "");
    }
    const root = `${toFileUrl(src).href}/`;
    const profile = (name: string, url: string) =>
      Deno.writeTextFile(
        join(dir, `${name}.json`),
        JSON.stringify({ scriptId: "1", url, functions: [] }, null, 2),
      );
    await profile("1", `${root}a.ts`);
    await profile("2", `${root}a.ts`); // a second profile of the same module
    await profile("3", `${root}b.tsx`);
    await profile("4", `${root}c.d.ts`); // nothing to emit
    await profile("5", `${root}d.js`); // nor here
    await profile("6", `${root}node_modules/e.ts`);
    await profile("7", `${root}gone.ts`); // removed since the run
    await profile("8", toFileUrl(join(dir, "elsewhere.ts")).href); // outside the roots
    await Deno.writeTextFile(join(dir, "9.json"), "{}"); // no url
    await Deno.writeTextFile(join(dir, "notes.txt"), `"url": "${root}a.ts"`);
    assertEquals(await profiledModules(dir, [root]), [`${root}a.ts`, `${root}b.tsx`]);
    assertEquals(
      emitEntrySource([`${root}a.ts`, `${root}b.tsx`]),
      `import ${JSON.stringify(`${root}a.ts`)};\nimport ${JSON.stringify(`${root}b.tsx`)};\n`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("test-run: a module another config re-emitted is reported again after reEmitCovered", async () => {
  // `deno coverage` reads a module's emit from the shared emit cache; a process transpiling it under
  // another config (a test app's build) overwrites that entry, and the report skips the module.
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_reemit_" }));
  const deno = Deno.execPath();
  const run = async (args: string[]) => {
    const out = await new Deno.Command(deno, { args, cwd: dir, stdin: "null" }).output();
    return new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  };
  try {
    await Deno.mkdir(join(dir, "mod"));
    await Deno.writeTextFile(
      join(dir, "mod", "lib.ts"),
      "export function f(x: number): number {\n  return x > 0 ? 1 : 2;\n}\n",
    );
    await Deno.writeTextFile(
      join(dir, "lib_test.ts"),
      'import { f } from "./mod/lib.ts";\nDeno.test("f", () => void f(1));\n',
    );
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await Deno.writeTextFile(
      join(dir, "other.json"),
      '{ "compilerOptions": { "jsxFactory": "h" } }',
    );
    await run(["test", "--coverage=cov", "--coverage-raw-data-only", "lib_test.ts"]);
    await run(["run", "--config", "other.json", "mod/lib.ts"]);
    assert((await run(["coverage", "cov"])).includes("Missing transpiled source"), "clobbered");
    const reEmitted = await reEmitCovered(join(dir, "cov"), {
      bin: deno,
      config: join(dir, "deno.json"),
      roots: [`${toFileUrl(join(dir, "mod")).href}/`],
      tempDir: dir,
    });
    assertEquals(reEmitted, 1);
    const report = await run(["coverage", "cov"]);
    assert(!report.includes("Missing transpiled source"), report);
    assert(report.includes("lib.ts"), report);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("test-run: the parallel pass never walks the tool caches (.deno/, .denext/, coverage/)", () => {
  assertEquals(TOOL_CACHE_DIRS, [".deno/", ".denext/", "coverage/"]);
  // Named on every stock discovery pass that passes an --ignore of its own (which replaces the
  // config's exclude); with none, the config's exclude applies.
  for (
    const args of [["--ignore=tests/e2e/"], ["tests/", "--ignore=x/"], [
      "--coverage=cov",
      "--ignore=x/",
    ]]
  ) {
    const ignore = testPasses(args, []).parallel?.find((a) => a.startsWith("--ignore="));
    assertEquals(
      ignore?.slice("--ignore=".length).split(",").slice(-3),
      [...TOOL_CACHE_DIRS],
      `${args}`,
    );
  }
  // One the caller already ignores is not named twice.
  assertEquals(
    testPasses(["--ignore=.deno/,tests/e2e/"], []).parallel?.find((a) => a.startsWith("--ignore=")),
    "--ignore=.deno/,tests/e2e/,.denext/,coverage/",
  );
});

Deno.test("test-run: a --ignore keeps .deno/ out though it replaces deno.json's exclude", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dnx-tr-discovery-" });
  try {
    // What a toolchain type-check leaves behind: an npm-compat copy with its own `_test.ts`.
    await Deno.mkdir(join(dir, ".deno/npm-compat/@jsr/std__x"), { recursive: true });
    await Deno.mkdir(join(dir, "tests/e2e"), { recursive: true });
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ exclude: [".deno/"] }));
    const failing = 'Deno.test("never", () => { throw new Error("walked"); });\n';
    await Deno.writeTextFile(join(dir, ".deno/npm-compat/@jsr/std__x/x_test.ts"), failing);
    await Deno.writeTextFile(join(dir, "tests/e2e/e_test.ts"), failing);
    await Deno.writeTextFile(join(dir, "tests/a_test.ts"), 'Deno.test("a", () => {});\n');
    const run = async (args: string[]) => {
      const out = await boundedOutput(Deno.execPath(), { args, cwd: dir, timeoutMs: 120_000 });
      return new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
    };
    // Deno's own behaviour, the reason test-run names the caches: the command-line ignore
    // replaces the config's `exclude`, and the cache's test runs.
    assertStringIncludes(await run(["test", "--no-check", "--ignore=tests/e2e/"]), "walked");
    const parallel = testPasses(["--no-check", "--ignore=tests/e2e/"], []).parallel!;
    const out = await run(parallel);
    assert(!out.includes("walked"), out);
    assertStringIncludes(out, "1 passed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("test-run: a pass's --ignore carries the config's own excludes, which --ignore replaces", () => {
  const serial = ["tests/a.test.ts"];
  const all = testPasses(["--ignore=tests/e2e/"], serial, [], true, [".deno/", "tests/e2e/"]);
  assertEquals(
    all.parallel?.at(-1),
    "--ignore=.deno/,tests/e2e/,tests/a.test.ts,.denext/,coverage/",
  );
  // No --ignore of its own: the config's excludes apply as they are.
  assertEquals(testPasses(["tests/other/"], serial, [], true, [".deno/"]).parallel, [
    "test",
    "-A",
    "--unstable-kv",
    "--parallel",
    "tests/other/",
  ]);
});

Deno.test("test-run: configTestExcludes reads deno.json's exclude and test.exclude", async () => {
  // This checkout's: the toolchain's `.deno/` copy stays out of every pass.
  assert((await configTestExcludes()).includes(".deno/"));
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await configTestExcludes(dir), []); // no config
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      '{\n  // a comment\n  "exclude": ["dist/", 1],\n  "test": { "exclude": [".deno/", "dist/"] }\n}',
    );
    assertEquals(await configTestExcludes(dir), ["dist/", ".deno/"]);
    await Deno.writeTextFile(join(dir, "deno.json"), "{ not json");
    assertEquals(await configTestExcludes(dir), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("test-run: deno test --ignore replaces the config's test.exclude (why the passes add it back)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, ".deno", "npm-compat"), { recursive: true });
    await Deno.writeTextFile(join(dir, "deno.json"), '{ "test": { "exclude": [".deno/"] } }');
    await Deno.writeTextFile(join(dir, "a_test.ts"), 'Deno.test("a", () => {});\n');
    await Deno.writeTextFile(
      join(dir, ".deno", "npm-compat", "b_test.ts"),
      'Deno.test("compat copy", () => {});\n',
    );
    const ran = async (args: string[]) => {
      const out = await new Deno.Command(Deno.execPath(), {
        args: ["test", "--no-check", ...args],
        cwd: dir,
        env: { NO_COLOR: "1" },
        stdin: "null",
      }).output();
      return new TextDecoder().decode(out.stdout).includes("compat copy");
    };
    assertEquals(await ran([]), false);
    assertEquals(await ran(["--ignore=dist/"]), true);
    assertEquals(await ran(["--ignore=.deno/,dist/"]), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
