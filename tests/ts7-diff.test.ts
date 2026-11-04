// scripts/ts7-diff.ts: the TypeScript 6 vs 7 diagnostic diff parses `deno check` output into
// repo-relative diagnostics and reports what only one compiler says, or says differently.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  type Diagnostic,
  diffDiagnostics,
  formatReport,
  isClean,
  parseDiagnostics,
} from "../scripts/ts7-diff.ts";

const ROOT = Deno.build.os === "windows" ? "C:\\repo" : "/repo";
const url = (rel: string) => toFileUrl(`${ROOT}/${rel}`).href;

const TS6_OUTPUT = `Check cli.ts
\x1b[0m\x1b[31mTS2307\x1b[0m [ERROR]: Cannot find module '${url("src/nope.ts")}'.
    at ${url("src/a.ts")}:3:19

TS2322 [ERROR]: Type 'string' is not assignable to type 'number'.
const x: number = "a";
      ^
    at ${url("src/a.ts")}:1:7

TS7006 [ERROR]: Parameter 'p' implicitly has an 'any' type.
    at ${url("src/b.ts")}:4:12

Found 3 errors.

error: Type checking failed.
`;

const TS7_OUTPUT = `Check cli.ts
TS2322 [ERROR]: Type 'string' is not assignable to type 'number'.
    at ${url("src/a.ts")}:1:7

TS2307 [ERROR]: Cannot find module './nope.ts' or its corresponding type declarations.
    at ${url("src/a.ts")}:3:19

TS2589 [ERROR]: Type instantiation is excessively deep and possibly infinite.
    at ${url("src/c.ts")}:9:1

error: Type checking failed.
`;

Deno.test("ts7-diff: deno check output parses to repo-relative diagnostics, colours stripped", () => {
  const ts6 = parseDiagnostics(TS6_OUTPUT, ROOT);
  assertEquals(ts6, [
    {
      code: "TS2307",
      file: "src/a.ts",
      line: 3,
      column: 19,
      message: "Cannot find module 'src/nope.ts'.",
    },
    {
      code: "TS2322",
      file: "src/a.ts",
      line: 1,
      column: 7,
      message: "Type 'string' is not assignable to type 'number'.",
    },
    {
      code: "TS7006",
      file: "src/b.ts",
      line: 4,
      column: 12,
      message: "Parameter 'p' implicitly has an 'any' type.",
    },
  ]);
  assertEquals(parseDiagnostics("Check cli.ts\n", ROOT), []);
});

Deno.test("ts7-diff: equal diagnostics cancel; the rest is one-sided or a changed message", () => {
  const diff = diffDiagnostics(
    "examples/x",
    parseDiagnostics(TS6_OUTPUT, ROOT),
    parseDiagnostics(TS7_OUTPUT, ROOT),
  );
  assertEquals(diff.counts, { ts6: 3, ts7: 3 });
  assertEquals(diff.onlyTs6.map((d) => d.code), ["TS7006"]);
  assertEquals(diff.onlyTs7.map((d) => d.code), ["TS2589"]);
  assertEquals(diff.changed.length, 1);
  assertEquals(
    diff.changed[0].ts7.message,
    "Cannot find module './nope.ts' or its corresponding type declarations.",
  );
  assertEquals(isClean(diff), false);
});

Deno.test("ts7-diff: a repeated diagnostic counts once per occurrence", () => {
  const d: Diagnostic = { code: "TS1", file: "a.ts", line: 1, column: 1, message: "m" };
  assertEquals(isClean(diffDiagnostics("t", [d, d], [d, d])), true);
  const diff = diffDiagnostics("t", [d, d], [d]);
  assertEquals(diff.onlyTs6, [d]);
  assertEquals(diff.onlyTs7, []);
});

Deno.test("ts7-diff: the report tabulates every target and lists only the differing ones", () => {
  const same = diffDiagnostics("examples/hello", [], []);
  const differs = diffDiagnostics(
    ".",
    parseDiagnostics(TS6_OUTPUT, ROOT),
    parseDiagnostics(TS7_OUTPUT, ROOT),
  );
  const report = formatReport([same, differs], { ts6: "6.0.3", ts7: "7.0.2" });
  assertStringIncludes(
    report,
    "TypeScript 6: 6.0.3 (`DENEXT_NATIVE_CHECK=0`); TypeScript 7: 7.0.2",
  );
  assertStringIncludes(report, "| examples/hello | 0 | 0 | 0 | 0 | 0 |");
  assertStringIncludes(report, "| . | 3 | 3 | 1 | 1 | 1 |");
  assertStringIncludes(report, "## .\n");
  assertEquals(report.includes("## examples/hello"), false);
  assertStringIncludes(
    report,
    "- src/b.ts:4:12 TS7006 Parameter 'p' implicitly has an 'any' type.",
  );
  assertStringIncludes(report, "- src/c.ts:9:1 TS2589 Type instantiation");
  assertStringIncludes(report, "  - TS7: Cannot find module './nope.ts'");
  assertStringIncludes(formatReport([same], { ts6: "6", ts7: "7" }), "No differences.");
});
