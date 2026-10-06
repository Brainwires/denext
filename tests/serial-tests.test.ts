// The serial list stays true: every test file that changes process-wide state (`Deno.env.set` /
// `Deno.env.delete` / `Deno.chdir`, itself or through a listed helper) is in
// `tests/serial-tests.ts`, and every listed file still does; and `scripts/test-run.ts` keeps the
// listed files out of the parallel pass.

import { assert, assertEquals } from "@std/assert";
import { walk } from "@std/fs";
import { fromFileUrl, relative } from "@std/path";
import { SERIAL_HELPERS, SERIAL_TESTS } from "./serial-tests.ts";
import { testPasses } from "../scripts/test-run.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** A change to process-wide state, as source text. */
const MUTATES = /\bDeno\.(?:env\.(?:set|delete)|chdir)\s*\(/;

/** The test files under `tests/` that run in the parallel suites (not e2e / migration-bed). */
async function parallelSuiteFiles(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for await (
    const e of walk(`${ROOT}tests`, {
      exts: [".ts"],
      includeDirs: false,
      skip: [/[/\\](?:e2e|migration-bed|fixtures)[/\\]/],
    })
  ) {
    const rel = relative(ROOT, e.path).replaceAll("\\", "/");
    out.set(rel, await Deno.readTextFile(e.path));
  }
  return out;
}

Deno.test("serial tests: each file that changes process-wide state is listed, and only those", async () => {
  const files = await parallelSuiteFiles();
  const helpers = new Set(SERIAL_HELPERS);
  const mutating = [...files].filter(([path, src]) => {
    if (!path.endsWith(".test.ts")) return false;
    if (MUTATES.test(src)) return true;
    return SERIAL_HELPERS.some((h) => src.includes(`/${h.split("/").pop()}"`));
  }).map(([path]) => path).sort();
  assertEquals(mutating, [...SERIAL_TESTS].sort());
  for (const h of helpers) assert(MUTATES.test(files.get(h) ?? ""), `${h} no longer mutates`);
  // A helper (not a test) that starts mutating must be listed with the helpers.
  const unlisted = [...files].filter(([path, src]) =>
    !path.endsWith(".test.ts") && path !== "tests/serial-tests.ts" && MUTATES.test(src) &&
    !helpers.has(path)
  ).map(([path]) => path);
  assertEquals(unlisted, []);
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
