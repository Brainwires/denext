// Unit tests for the pnpm catalog/workspace resolver's pure logic (used by SPA
// mode's compat path to resolve `catalog:`/`workspace:*` packages the esbuild
// deno-loader can't). The full node-modules walk is exercised end-to-end by the
// T3 apps/web build; here we pin the specifier-split + exports-map resolution.

import { assertEquals } from "@std/assert";
import { resolveExportsField, splitPackageSpecifier } from "../src/build/next-compat.ts";

Deno.test("splitPackageSpecifier: scoped, unscoped, root, subpath", () => {
  assertEquals(splitPackageSpecifier("effect"), ["effect", ""]);
  assertEquals(splitPackageSpecifier("effect/Array"), ["effect", "/Array"]);
  assertEquals(splitPackageSpecifier("@t3tools/shared"), ["@t3tools/shared", ""]);
  assertEquals(splitPackageSpecifier("@t3tools/shared/devProxy"), ["@t3tools/shared", "/devProxy"]);
  assertEquals(splitPackageSpecifier("@clerk/shared/internal/x"), ["@clerk/shared", "/internal/x"]);
});

Deno.test("resolveExportsField: string exports (root only)", () => {
  assertEquals(resolveExportsField("./index.js", ""), "./index.js");
  assertEquals(resolveExportsField("./index.js", "/sub"), null);
});

Deno.test("resolveExportsField: conditions object for root, browser>import>default", () => {
  const exp = { browser: "./b.js", import: "./i.js", require: "./r.js", default: "./d.js" };
  assertEquals(resolveExportsField(exp, ""), "./b.js");
  assertEquals(resolveExportsField({ import: "./i.js", default: "./d.js" }, ""), "./i.js");
  assertEquals(resolveExportsField({ require: "./r.js", default: "./d.js" }, ""), "./d.js");
});

Deno.test("resolveExportsField: subpath map with nested conditions", () => {
  const exp = {
    ".": { import: "./esm/index.js", require: "./cjs/index.js" },
    "./Array": { import: "./esm/Array.js" },
  };
  assertEquals(resolveExportsField(exp, ""), "./esm/index.js");
  assertEquals(resolveExportsField(exp, "/Array"), "./esm/Array.js");
  assertEquals(resolveExportsField(exp, "/Missing"), null);
});

Deno.test("resolveExportsField: ./* wildcard subpath", () => {
  const exp = { "./*": { import: "./dist/esm/*.js" } };
  assertEquals(resolveExportsField(exp, "/Effect"), "./dist/esm/Effect.js");
  assertEquals(resolveExportsField(exp, "/internal/foo"), "./dist/esm/internal/foo.js");
});

Deno.test("resolveExportsField: exact key wins over wildcard", () => {
  const exp = { "./special": "./special.js", "./*": "./dist/*.js" };
  assertEquals(resolveExportsField(exp, "/special"), "./special.js");
  assertEquals(resolveExportsField(exp, "/other"), "./dist/other.js");
});
