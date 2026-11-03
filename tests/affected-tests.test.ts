// scripts/affected-tests.ts: the changed test files plus the test files that import a changed
// module directly, resolved by specifier (relative paths and the repo's own aliases).

import { assertEquals } from "@std/assert";
import {
  affectedTests,
  importSpecifiers,
  INDIRECT_TESTS,
  isTestFile,
  resolveSpecifier,
} from "../scripts/affected-tests.ts";

const TESTS = new Map<string, string>([
  ["tests/a.test.ts", `import { x } from "../src/build/x.ts";\n`],
  ["tests/integration/b.test.ts", `import { y } from "../../src/build/y.ts";\n`],
  ["tests/c.test.ts", `import { port } from "./helpers/port.ts";\nimport "denext/server";\n`],
  // A specifier inside a template string is code for a child process, not an import of this file.
  ["tests/d.test.ts", 'const body = `import { x } from "../src/build/x.ts";`;\n'],
  ["tests/e.test.ts", `const m = await import("../src/build/y.ts");\n`],
  ["tests/e2e/f.e2e.test.ts", `import { x } from "../../src/build/x.ts";\n`],
  ["tests/helpers/port.ts", `export const port = 0;\n`],
]);

Deno.test("affected tests: a changed module selects its direct importers", () => {
  assertEquals(affectedTests(["src/build/x.ts"], TESTS), ["tests/a.test.ts"]);
  assertEquals(affectedTests(["src/build/y.ts"], TESTS), [
    "tests/e.test.ts",
    "tests/integration/b.test.ts",
  ]);
  assertEquals(affectedTests(["tests/helpers/port.ts"], TESTS), ["tests/c.test.ts"]);
  assertEquals(affectedTests(["src/server/mod.ts"], TESTS), ["tests/c.test.ts"], "an alias");
});

Deno.test("affected tests: a changed test file selects itself; e2e and non-tests never", () => {
  assertEquals(affectedTests(["tests/d.test.ts", "README.md"], TESTS), ["tests/d.test.ts"]);
  assertEquals(affectedTests(["tests/e2e/f.e2e.test.ts"], TESTS), []);
  assertEquals(isTestFile("tests/fixtures/x/y.test.ts"), false);
  assertEquals(isTestFile("tests/migration-bed/a.test.ts"), false);
  assertEquals(isTestFile("tests/integration/a.test.ts"), true);
});

Deno.test("affected tests: specifiers resolve relative paths and the repo's aliases only", () => {
  assertEquals(
    importSpecifiers(`import a from "./a.ts";\nexport { b } from "../b.ts";\nimport("./c.ts");`),
    ["./a.ts", "../b.ts", "./c.ts"],
  );
  assertEquals(resolveSpecifier("tests/x.test.ts", "../src/a.ts"), "src/a.ts");
  assertEquals(resolveSpecifier("tests/x.test.ts", "jsr:@std/assert"), null);
  assertEquals(resolveSpecifier("tests/x.test.ts", "denext/server"), "src/server/mod.ts");
});

Deno.test("affected tests: a module's indirect tests are selected without importing it", () => {
  const tests = new Map<string, string>([
    ["tests/deno-version.test.ts", `import "../src/build/deno-version.ts";\n`],
    ["tests/deno-toolchain.test.ts", `import "../src/build/deno-toolchain.ts";\n`],
    ["tests/deno-toolchain-tsgo.test.ts", `import "../src/build/deno-toolchain.ts";\n`],
    ["tests/deno-toolchain-windows.test.ts", `import "../src/build/deno-toolchain.ts";\n`],
    ["tests/toolchain-audit.test.ts", `import "../src/build/deno-toolchain.ts";\n`],
    ["tests/toolchain-prune.test.ts", `import "../src/build/toolchain-prune.ts";\n`],
    ["tests/esbuild-binary.test.ts", `import "../src/build/deno-toolchain.ts";\n`],
    ["tests/gleam-toolchain.test.ts", `import "../src/build/deno-toolchain.ts";\n`],
    ["tests/e2e/deno-toolchain.e2e.test.ts", ""],
  ]);
  assertEquals(affectedTests(["src/build/deno-version.ts"], tests), [
    "tests/deno-toolchain-tsgo.test.ts",
    "tests/deno-toolchain-windows.test.ts",
    "tests/deno-toolchain.test.ts",
    "tests/deno-version.test.ts",
    "tests/esbuild-binary.test.ts",
    "tests/toolchain-audit.test.ts",
    "tests/toolchain-prune.test.ts",
  ]);
  // Only for the module that lists them.
  assertEquals(affectedTests(["src/build/other.ts"], tests), []);
  assertEquals(affectedTests(["src/build/deno-version.ts"], tests, {}), [
    "tests/deno-version.test.ts",
  ]);
  // Every listed pattern names a test file that exists.
  for (const [module, patterns] of Object.entries(INDIRECT_TESTS)) {
    for (const re of patterns) {
      const hits = [...Deno.readDirSync("tests")].filter((e) => re.test(`tests/${e.name}`));
      assertEquals(hits.length > 0, true, `${module}: ${re}`);
    }
  }
});
