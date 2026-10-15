// The opt-in lint rules that go with denext/result: `denext/exhaustive-switch` and
// `denext/no-throw`, added by `denextLintPlugin(options)` and absent from the default plugin.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import plugin, { denextLintPlugin } from "../src/lint/denext-plugin.ts";

// deno-lint-ignore no-explicit-any
const denoLint = (Deno as any).lint;

function lintWith(p: unknown, source: string, file = "input.ts"): string[] {
  return denoLint.runPlugin(p, file, source).map((d: { message: string }) => d.message);
}

const withSwitch = denextLintPlugin({ exhaustiveSwitch: true });
const switchFindings = (source: string) =>
  lintWith(withSwitch, source).filter((m) => m.includes("exhaustive-switch"));

Deno.test("the default plugin has neither opt-in rule; the factory adds only what is asked", () => {
  assert(!("exhaustive-switch" in plugin.rules));
  assert(!("no-throw" in plugin.rules));
  assertEquals(Object.keys(denextLintPlugin().rules), Object.keys(plugin.rules));
  assert("exhaustive-switch" in withSwitch.rules);
  assert(!("no-throw" in withSwitch.rules));
  assert("no-throw" in denextLintPlugin({ noThrow: { include: ["lib"] } }).rules);
  assert(!("no-throw" in denextLintPlugin({ noThrow: { include: [] } }).rules));
  assertEquals(withSwitch.name, "denext");
  // The default rules still run under the factory's plugin.
  const hook = lintWith(withSwitch, `function f() { useState(0); }`);
  assert(hook.some((m) => m.includes("hooks-in-component")));
});

Deno.test("exhaustive-switch: names the members a local literal union leaves unhandled", () => {
  const [msg, ...rest] = switchFindings(`
    type Status = "idle" | "loading" | "done";
    function label(s: Status) {
      switch (s) {
        case "idle": return "·";
        case "loading": return "…";
      }
    }
  `);
  assertEquals(rest, []);
  assertStringIncludes(msg, `does not handle "done"`);
  assertStringIncludes(msg, "default: assertNever(s)");
});

Deno.test("exhaustive-switch: resolves a discriminated union's property, aliases and keywords", () => {
  const found = switchFindings(`
    type Circle = { kind: "circle"; r: number };
    type Shape = Circle | { kind: "square"; side: number } | { kind: "rect"; w: number };
    function area(shape: Shape) {
      switch (shape.kind) {
        case "circle": return 1;
        case "square": return 2;
      }
    }
    function flag(b: boolean | null) {
      switch (b) { case true: return 1; case null: return 0; }
    }
    function n(x: 1 | 2) {
      switch (x) { case 1: return "a"; case 2: return "b"; }
    }
  `);
  assertEquals(found.length, 2);
  assertStringIncludes(found[0], `\`shape.kind\` does not handle "rect"`);
  assertStringIncludes(found[1], "does not handle false");
});

Deno.test("exhaustive-switch: a default (assertNever or a deliberate catch-all) satisfies it", () => {
  assertEquals(
    switchFindings(`
      type S = "a" | "b";
      function f(s: S) {
        switch (s) { case "a": return 1; default: return assertNever(s); }
      }
      function g(k: string) {
        switch (k) { case "Enter": return 1; default: return 0; }
      }
    `),
    [],
  );
});

Deno.test("exhaustive-switch: without local type info it asks for default: assertNever", () => {
  const [msg] = switchFindings(`
    import type { Shape } from "./shape.ts";
    function f(shape: Shape) {
      switch (shape.kind) { case "circle": return 1; }
    }
  `);
  assertStringIncludes(msg, "only literal cases and no `default`");
  assertStringIncludes(msg, "default: assertNever(shape.kind)");
});

Deno.test("exhaustive-switch: leaves non-literal switches and empty ones alone", () => {
  assertEquals(
    switchFindings(`
      function f(x: number, a: number) {
        switch (true) { case x > 1: return 1; }
        switch (x) { case a: return 2; }
        switch (x) {}
      }
    `),
    [],
  );
});

Deno.test("no-throw: reports throw statements only in the listed directories", () => {
  const p = denextLintPlugin({ noThrow: { include: ["lib/domain", "./app/api/"] } });
  const src = `export function f() { throw new Error("x"); }`;
  const hits = (file: string) =>
    lintWith(p, src, file).filter((m) => m.includes("denext/no-throw")).length;
  assertEquals(hits("/repo/lib/domain/order.ts"), 1);
  assertEquals(hits("/repo/app/api/users/route.ts"), 1);
  assertEquals(hits("C:\\repo\\lib\\domain\\order.ts"), 1);
  assertEquals(hits("/repo/lib/domainx/order.ts"), 0);
  assertEquals(hits("/repo/lib/other.ts"), 0);
  const [msg] = lintWith(p, src, "/repo/lib/domain/a.ts");
  assertStringIncludes(msg, "err(...)");
});
