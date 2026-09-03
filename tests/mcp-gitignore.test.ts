// Tests for the dependency-free `.gitignore` matcher behind the codebase indexer.

import { assert, assertEquals } from "@std/assert";
import { compileRule, Ignorer } from "../src/mcp/rag/gitignore.ts";

// Each row: patterns (one .gitignore body), path, isDir, expected-ignored.
const CASES: Array<[string, string, boolean, boolean]> = [
  // basic globs
  ["*.log", "app.log", false, true],
  ["*.log", "src/app.log", false, true], // unanchored → any depth
  ["*.log", "app.txt", false, false],
  ["temp?", "tempX", false, true],
  ["temp?", "tempXY", false, false],
  // anchoring
  ["/build", "build", true, true],
  ["/build", "src/build", true, false], // leading slash anchors to root
  ["build", "src/build", true, true], // no slash → any depth
  // directory-only rules
  ["logs/", "logs", true, true],
  ["logs/", "logs", false, false], // a *file* named logs is not the dir
  ["logs/", "logs/app.txt", false, true], // contents of an ignored dir are excluded
  ["node_modules/", "node_modules/pkg/index.ts", false, true],
  // ** spanning segments
  ["a/**/c", "a/c", false, true], // zero intermediate dirs
  ["a/**/c", "a/x/y/c", false, true],
  ["a/**/c", "a/c/d", false, true], // under a match
  ["**/foo", "x/y/foo", false, true],
  // negation (last match wins)
  ["*.log\n!keep.log", "keep.log", false, false],
  ["*.log\n!keep.log", "app.log", false, true],
  // comments, blanks, escapes
  ["# a comment\n\n", "comment", false, false],
  ["\\#literal", "#literal", false, true],
];

Deno.test("gitignore: matcher cases", () => {
  for (const [patterns, path, isDir, expected] of CASES) {
    const got = Ignorer.fromText(patterns).ignores(path, isDir);
    assertEquals(got, expected, `[${JSON.stringify(patterns)}] ${path} (dir=${isDir})`);
  }
});

Deno.test("gitignore: compileRule returns null for comments and blanks", () => {
  assertEquals(compileRule(""), null);
  assertEquals(compileRule("   "), null);
  assertEquals(compileRule("# comment"), null);
  assert(compileRule("*.log") !== null);
});

Deno.test("gitignore: nested .gitignore anchors to its own directory (base)", () => {
  const ign = Ignorer.fromText("*.tmp", "sub");
  assert(ign.ignores("sub/a.tmp", false), "matches inside the nested dir");
  assert(ign.ignores("sub/deep/a.tmp", false), "matches at depth inside the nested dir");
  assert(!ign.ignores("other/a.tmp", false), "does not match outside the nested dir");
});

Deno.test("gitignore: empty ignorer ignores nothing", () => {
  assert(!Ignorer.empty().ignores("anything.ts", false));
});
