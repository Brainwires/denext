// scripts/affected-tests.ts: the changed test files plus the test files that import a changed
// module directly, resolved by specifier (relative paths and the repo's own aliases).

import { assertEquals } from "@std/assert";
import {
  affectedTests,
  importSpecifiers,
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
