// The browser half of a `"use server"` module in a TanStack Start app
// (packages/tanstack-start/src/use-server.ts), over the same Babel parse/print TanStack's
// toolchain hands the plugin (`@tanstack/router-utils`), without an installed Start app: the
// input is a module as TanStack's client compiler leaves it (server functions already
// `createClientRpc(id)` stubs).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
// TanStack Start's own parse / print (a dependency of @tanstack/router-plugin, already in the lock),
// imported here only: the framework's import map stays as it is.
// deno-lint-ignore no-import-prefix
import { generateFromAst, parseAst } from "npm:@tanstack/router-utils@1.162.3";
import { browserServerModule } from "../packages/tanstack-start/src/use-server.ts";
import type { StartToolchain } from "../packages/tanstack-start/src/toolchain.ts";

/** The parse / print half of the toolchain, as `loadStartToolchain` builds it. */
const tc = {
  parse: (code: string, filename: string) => parseAst({ code, filename }),
  print: (ast: unknown, filename: string) =>
    generateFromAst(ast as Parameters<typeof generateFromAst>[0], { filename }).code,
} as unknown as StartToolchain;

const browser = (code: string) => browserServerModule(code, "/p/src/actions.ts", tc);

/** A client-compiled `"use server"` module: two server functions, server code around them. */
const MODULE = `"use server";
import { createServerFn } from "@tanstack/react-start";
import { createClientRpc } from "@tanstack/react-start/client-rpc";
import { createClientRpc as rpc2 } from "@tanstack/react-start/client-rpc";
import { readFileSync } from "node:fs";
import { helper, unused } from "./shared.ts";
import "./setup.server.ts";
const SECRET = "TOP_SECRET";
const LIMIT = helper(3), noise = "NOISE_SECRET";
const derived = LIMIT * 2;
export const getStamp = createServerFn({ method: "GET" }).handler(createClientRpc("id-stamp"));
export const getOther = createServerFn().handler(rpc2("id-other")), plainValue = SECRET;
const hidden = createServerFn().handler(createClientRpc("id-hidden"));
export { hidden as renamed };
export async function plainAction() { return readFileSync("/etc/hosts", "utf8") + SECRET; }
export class Store { read() { return SECRET; } }
export const { a, b: [c, ...rest], d = 1, ...others } = JSON.parse(SECRET);
function localFn() { return SECRET; }
export { localFn };
export { thing, other as alias } from "./elsewhere.ts";
export * from "./everything.ts";
export const sized = derived;
export default function Page() { return SECRET; }
console.log("SIDE_EFFECT", SECRET, noise);
`;

Deno.test('tanstack-start "use server": server functions stay RPC stubs, every other export throws', () => {
  const out = browser(MODULE);
  assert(!/^\s*["']use server["']/.test(out), "the directive is gone");
  assertStringIncludes(out, 'export const getStamp = createServerFn({\n  method: "GET"\n})');
  assertStringIncludes(out, 'createClientRpc("id-stamp")');
  // One declarator per kept statement: the RPC one stays, its exported sibling is stubbed.
  assertStringIncludes(out, 'export const getOther = createServerFn().handler(rpc2("id-other"));');
  assertStringIncludes(out, 'export const plainValue = __denextUseServerExport("plainValue");');
  // A local server function exported under another name keeps its RPC stub and the rename.
  assertStringIncludes(
    out,
    'const hidden = createServerFn().handler(createClientRpc("id-hidden"));',
  );
  assertStringIncludes(out, "export { hidden as renamed };");
  // Functions, classes, patterns, re-exports and the default export are throwing stand-ins.
  for (
    const name of ["plainAction", "Store", "a", "c", "rest", "d", "others", "localFn", "sized"]
  ) {
    assertStringIncludes(out, `${name} = __denextUseServerExport("${name}")`);
  }
  assertStringIncludes(out, 'export const thing = __denextUseServerExport("thing")');
  assertStringIncludes(out, 'alias = __denextUseServerExport("alias")');
  assertStringIncludes(out, 'export default __denextUseServerExport("default");');
  assertStringIncludes(out, "function __denextUseServerExport(name)");
});

Deno.test('tanstack-start "use server": nothing else of the module ships', () => {
  const out = browser(MODULE);
  for (
    const leak of [
      "TOP_SECRET",
      "NOISE_SECRET",
      "SIDE_EFFECT",
      "readFileSync",
      "node:fs",
      "setup.server",
      "everything.ts",
      "helper",
      "unused",
      "derived",
      "LIMIT",
    ]
  ) {
    assert(!out.includes(leak), `${leak} shipped:\n${out}`);
  }
  // The imports the kept code uses stay, and only their used specifiers.
  assertStringIncludes(out, 'import { createServerFn } from "@tanstack/react-start";');
  assertStringIncludes(out, 'import { createClientRpc } from "@tanstack/react-start/client-rpc";');
});

Deno.test('tanstack-start "use server": locals a server function uses are kept, transitively', () => {
  const out = browser(`"use server";
import { createClientRpc } from "@tanstack/react-start/client-rpc";
import { createServerFn } from "@tanstack/react-start";
import { base } from "./opts.ts";
const opts = { method: base };
const method = opts;
export const save = createServerFn(method).handler(createClientRpc("id-save"));
export default createServerFn().handler(createClientRpc("id-default"));
`);
  assertStringIncludes(out, 'import { base } from "./opts.ts";');
  assertStringIncludes(out, "const opts = {\n  method: base\n};");
  assertStringIncludes(out, "const method = opts;");
  // A default export that is itself a server function stays one.
  assertStringIncludes(
    out,
    'export default createServerFn().handler(createClientRpc("id-default"));',
  );
  assert(!out.includes('__denextUseServerExport("default")'), out);
});

Deno.test('tanstack-start "use server": a module with no exports keeps only the stand-in helper', () => {
  const out = browser(`"use server";\nconst x = 1;\nconsole.log(x);\n`);
  assertEquals(out.trim().split("\n")[0], "function __denextUseServerExport(name) {");
});
