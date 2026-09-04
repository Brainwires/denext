// scripts/coverage-to-istanbul.ts — lcov → Istanbul coverage map for fallow's CRAP scoring.

import { assertEquals } from "@std/assert";
import { lcovToIstanbul } from "../scripts/coverage-to-istanbul.ts";

const LCOV = `SF:/abs/src/a.ts
FN:3,alpha
FN:10,beta
FNDA:4,alpha
FNDA:0,beta
DA:3,4
DA:4,4
DA:10,0
DA:11,0
BRDA:4,0,0,3
BRDA:4,0,1,-
BRDA:11,1,0,0
LF:4
LH:2
end_of_record
SF:src/b.ts
FN:1,gamma
FNDA:1,gamma
DA:1,1
end_of_record
`;

Deno.test("keys files by absolute path, resolving relative SF against the root", () => {
  const map = lcovToIstanbul(LCOV, "/repo/");
  assertEquals(Object.keys(map), ["/abs/src/a.ts", "/repo/src/b.ts"]);
  assertEquals(map["/repo/src/b.ts"].path, "/repo/src/b.ts");
});

Deno.test("one statement per DA line, carrying its hit count", () => {
  const a = lcovToIstanbul(LCOV, "/repo")["/abs/src/a.ts"];
  assertEquals(Object.keys(a.statementMap).length, 4);
  assertEquals(a.statementMap["0"].start.line, 3);
  assertEquals(a.s, { "0": 4, "1": 4, "2": 0, "3": 0 });
});

Deno.test("functions span from FN line to the next function (or last DA line)", () => {
  const a = lcovToIstanbul(LCOV, "/repo")["/abs/src/a.ts"];
  assertEquals(a.fnMap["0"].name, "alpha");
  assertEquals(a.fnMap["0"].loc.start.line, 3);
  assertEquals(a.fnMap["0"].loc.end.line, 9);
  assertEquals(a.fnMap["1"].name, "beta");
  assertEquals(a.fnMap["1"].loc.end.line, 11);
  assertEquals(a.f, { "0": 4, "1": 0 });
});

Deno.test("BRDA rows group into one branch per line/block; '-' reads as zero", () => {
  const a = lcovToIstanbul(LCOV, "/repo")["/abs/src/a.ts"];
  assertEquals(Object.keys(a.branchMap).length, 2);
  assertEquals(a.branchMap["0"].line, 4);
  assertEquals(a.branchMap["0"].locations.length, 2);
  assertEquals(a.b, { "0": [3, 0], "1": [0] });
});

Deno.test("a file with no DA lines still yields a well-formed entry", () => {
  const map = lcovToIstanbul("SF:/x.ts\nFN:2,only\nFNDA:0,only\nend_of_record\n", "/");
  assertEquals(map["/x.ts"].fnMap["0"].loc.end.line, 2);
  assertEquals(map["/x.ts"].s, {});
});
