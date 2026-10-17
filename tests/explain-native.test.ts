// The diagnostics explainer on the native TypeScript 7 compiler's output: the fixtures of
// tests/explain-diagnostics.test.ts, captured with `deno check` on a toolchain that type-checks
// natively (src/build/native-check.ts) into tests/fixtures/explain-native/, explain to the
// snapshots beside them — and name the same fix as the in-process captures. TypeScript 7 sorts a
// union's members (`"dark" | "light"`), so lists are compared as sets.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { explainFixture } from "../scripts/capture-explain-fixtures.ts";
import { parseDiagnostics } from "../src/build/explain/mod.ts";

const NATIVE = fromFileUrl(new URL("./fixtures/explain-native/", import.meta.url));
const IN_PROCESS = fromFileUrl(new URL("./fixtures/explain/", import.meta.url));

function cases(): string[] {
  return [...Deno.readDirSync(NATIVE)]
    .filter((e) => e.name.endsWith(".raw.txt"))
    .map((e) => e.name.slice(0, -".raw.txt".length))
    .sort();
}

/** An explanation's headline and fix lines, with quoted lists sorted. */
function verdict(explained: string): string[] {
  return explained.split("\n")
    .filter((l) => /^TS\d+:/.test(l) || l.trimStart().startsWith("Fix:"))
    .map((l) =>
      l.replace(
        /"[^"]*"(?:(?:, | \| )"[^"]*")+/g,
        (list) => list.split(/, | \| /).sort().join(", "),
      )
    );
}

for (const name of cases()) {
  Deno.test(`explain (native TypeScript 7): ${name}`, () => {
    const raw = Deno.readTextFileSync(join(NATIVE, `${name}.raw.txt`));
    const actual = explainFixture(raw);
    assertEquals(
      actual,
      Deno.readTextFileSync(join(NATIVE, `${name}.explained.txt`)),
      `${name}: re-capture with a natively checking toolchain if intended`,
    );
    for (const d of parseDiagnostics(raw)) {
      for (const line of d.raw.split("\n")) assertStringIncludes(actual, line);
    }
    const inProcess = Deno.readTextFileSync(join(IN_PROCESS, `${name}.explained.txt`));
    assertEquals(verdict(actual), verdict(inProcess), `${name}: the same explanation`);
  });
}

Deno.test("explain (native TypeScript 7): the captures cover the type-error cases", () => {
  const all = cases();
  for (
    const required of [
      "define-api-response",
      "api-client-body",
      "assignable-object",
      "non-exhaustive-switch",
      "missing-return-switch",
      "module-not-found",
      "missing-import",
      "possibly-undefined",
    ]
  ) {
    assert(all.includes(required), `missing native fixture ${required}`);
  }
});
