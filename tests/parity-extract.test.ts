// The parity harness's extractors (scripts/parity/extract-real.ts, extract-denext.ts) on tiny
// modules: TypeScript-internal `__@` member names never reach a member list (nor the diff),
// and a type-only re-export is a type, never a runtime value.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { extractRealSurfacesFor } from "../scripts/parity/extract-real.ts";
import { extractDenextSurfacesFor, typeOnlyExports } from "../scripts/parity/extract-denext.ts";
import { diffSurfaces } from "../scripts/parity/diff.ts";
import type { Surface } from "../scripts/parity/types.ts";

const FAKE_DTS = `declare class Klass {
  run(): void;
}
declare function helper(a: string, b?: number): void;
export interface Shape {
  a: number;
}
export type { Klass as TypeOnlyClass };
export { type Klass as InlineTypeOnly, type helper as TypeOnlyFn };
export { Klass, helper };
export declare const names: readonly string[];
`;

Deno.test("parity extractor: no __@ members; type-only re-exports are types", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_parity_extract_" });
  try {
    const pkg = join(dir, "node_modules", "fake-pkg");
    await Deno.mkdir(pkg, { recursive: true });
    await Deno.writeTextFile(
      join(pkg, "package.json"),
      JSON.stringify({ name: "fake-pkg", version: "1.0.0", types: "index.d.ts" }),
    );
    await Deno.writeTextFile(join(pkg, "index.d.ts"), FAKE_DTS);
    const [surface] = extractRealSurfacesFor(dir, [{ specifier: "fake-pkg", real: "fake-pkg" }]);
    assert(surface.resolved, "the fake package resolves");
    const sym = surface.symbols;

    const members = sym.names.members ?? [];
    assert(members.includes("length"), "real members are kept");
    assertEquals(members.filter((m) => m.startsWith("__")), [], "no __@iterator@… names");

    // A type-only re-export is never a runtime value (the namespace type leaves it out).
    for (const name of ["TypeOnlyClass", "InlineTypeOnly", "TypeOnlyFn", "Shape"]) {
      assert(!sym[name]?.isValue, `${name} is not a value`);
    }
    // A plain re-export (an alias) is classified by what it names.
    assertEquals([sym.Klass.isValue, sym.Klass.isType, sym.Klass.kind], [true, true, "class"]);
    assertEquals([sym.helper.isValue, sym.helper.kind], [true, "function"]);

    const denext: Surface = { specifier: "fake-pkg", resolved: true, symbols: {} };
    const result = diffSurfaces([surface], [denext], []);
    const missing = result.findings.filter((f) => f.category === "MISSING_VALUE");
    assertEquals(missing.map((f) => f.symbol).sort(), ["Klass", "helper", "names"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parity diff: a baseline's __@ members are never reported missing", () => {
  const sym = (members: string[]) => ({
    name: "names",
    kind: "value",
    isValue: true,
    isType: false,
    members,
  });
  const real: Surface = {
    specifier: "x",
    resolved: true,
    symbols: { names: sym(["__@iterator@585", "length"]) },
  };
  const den: Surface = { specifier: "x", resolved: true, symbols: { names: sym(["length"]) } };
  const result = diffSurfaces([real], [den], []);
  assertEquals(result.findings, []);
  assert(result.ok);
});

Deno.test("parity denext extractor: type-only re-exports are types, not values", async () => {
  assertEquals(
    [
      ...typeOnlyExports(`export type { A, B as C } from "./x.ts";
export { type D, E, type F as G } from "./x.ts";
export { H };
export type Alias = { I: string };
import type { J, K as L } from "./y.ts";
import { type M, N } from "./y.ts";
export { J, L as O, M, N };`),
    ].sort(),
    ["A", "C", "D", "G", "J", "M", "O"],
  );

  const dir = await Deno.makeTempDir({ prefix: "denext_parity_denext_" });
  try {
    await Deno.writeTextFile(
      join(dir, "impl.ts"),
      `/** A class. */
export class Impl {}
/** A function. */
export function run(a: string): string {
  return a;
}
`,
    );
    await Deno.writeTextFile(
      join(dir, "mod.ts"),
      `export type { Impl as ImplType } from "./impl.ts";
export { run, type run as RunType } from "./impl.ts";
`,
    );
    const [surface] = await extractDenextSurfacesFor(dir, [{ specifier: "m", denext: "mod.ts" }]);
    const sym = surface.symbols;
    assertEquals([sym.ImplType.isValue, sym.ImplType.isType], [false, true]);
    assertEquals([sym.RunType.isValue, sym.RunType.callSignatures], [false, undefined]);
    assertEquals([sym.run.isValue, sym.run.callSignatures?.length], [true, 1]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
