// @denext/swc's public surface: documented, typed wrappers over the wasmbuild glue that keep
// `@swc/wasm-web` parity (same eight functions, options passed through verbatim).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import init, {
  minify,
  minifySync,
  parse,
  parseSync,
  print,
  printSync,
  transform,
  transformSync,
} from "../packages/swc/mod.ts";

Deno.test("parse / parseSync return a Module AST with byte spans", async () => {
  const ast = await parse("const x: number = 1", { syntax: "typescript", target: "es2022" });
  assertEquals(ast.type, "Module");
  assertEquals(ast.body.length, 1);
  assert(typeof ast.span.start === "number" && ast.span.end > ast.span.start);
  const sync = parseSync("export const y = <a/>;", { syntax: "ecmascript", jsx: true });
  assertEquals(sync.type, "Module");
});

Deno.test("transform / transformSync lower TSX; print / printSync round-trip an AST", async () => {
  const opts = { jsc: { parser: { syntax: "typescript", tsx: true }, target: "es2020" } };
  const out = await transform("const el = <b>{1 as number}</b>;", opts);
  assertStringIncludes(out.code, "React.createElement");
  assert(!out.code.includes("as number"), "TypeScript annotations are stripped");
  assertEquals(transformSync("let a: string = 'x';", opts).code.includes(": string"), false);
  const printed = printSync(parseSync("let a = 1;\n", {}), {});
  assertStringIncludes(printed.code, "let a = 1;");
  assertStringIncludes((await print(parseSync("f(  1 )", {}), {})).code, "f(1)");
});

Deno.test("minify / minifySync compress and mangle; init() is a resolved no-op", async () => {
  const src = "function add(first, second) { return first + second; } console.log(add(1, 2));";
  const min = await minify(src, { compress: true, mangle: true });
  assert(min.code.length < src.length);
  assert(!min.code.includes("first"), "locals are mangled");
  assertEquals(minifySync(src, { compress: true, mangle: true }).code, min.code);
  assertEquals(await init(), undefined);
});
