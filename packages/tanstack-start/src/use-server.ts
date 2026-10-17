// A `"use server"` module in a TanStack Start app, as the browser gets it. denext's rule for a
// `"use server"` module is that its source never ships: the browser imports a stub in its place.
// denext's own stubs call a Server Action, which a Start app has no endpoint for, so the plugin
// builds the module's browser half itself, after TanStack's compiler (client environment) ran:
//
// - each `createServerFn` stays Start's RPC stub (`createClientRpc(id)`), the call working as in
//   any other module;
// - every other export becomes a function that throws when called;
// - everything else the module runs at its top level is dropped, then the declarations and
//   imports nothing kept still uses.

import type { StartToolchain } from "./toolchain.ts";

/** A Babel AST node, as far as this module looks at one. */
// deno-lint-ignore no-explicit-any
type Node = any;

/** The throwing stand-in every other export becomes (a hoisted function, appended). */
const STUB = "__denextUseServerExport";
const STUB_SOURCE = `function ${STUB}(name) {
  return function () {
    throw new Error(
      '"' + name + '" is an export of a "use server" module: its code stays on the server. ' +
        "A TanStack Start app calls the server through createServerFn.",
    );
  };
}
`;

/** Node fields that hold no child nodes. */
const NOT_CHILDREN = new Set([
  "loc",
  "start",
  "end",
  "extra",
  "leadingComments",
  "trailingComments",
]);

/** Visit every node under `node` until `fn` returns `true`; whether it did. */
function someNode(node: Node, fn: (n: Node) => boolean): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((n) => someNode(n, fn));
  if (typeof node.type === "string" && fn(node)) return true;
  return Object.entries(node).some(([key, value]) =>
    !NOT_CHILDREN.has(key) && typeof value === "object" && someNode(value, fn)
  );
}

/** Whether `node` (an expression) calls one of `rpc` (Start's client RPC factory). */
const callsRpc = (node: Node, rpc: Set<string>) =>
  someNode(
    node,
    (n) => n.type === "CallExpression" && n.callee?.type === "Identifier" && rpc.has(n.callee.name),
  );

/** Every identifier name under `node` (an over-approximation of what it references). */
function namesIn(node: Node, out: Set<string>): Set<string> {
  someNode(node, (n) => {
    if (n.type === "Identifier" || n.type === "JSXIdentifier") out.add(n.name);
    return false;
  });
  return out;
}

/** The local names Start's client RPC factory is imported under. */
function rpcNames(body: Node[]): Set<string> {
  const names = new Set<string>();
  for (const stmt of body) {
    if (stmt.type !== "ImportDeclaration" || !/\/client-rpc$/.test(stmt.source.value)) continue;
    for (const s of stmt.specifiers) names.add(s.local.name);
  }
  return names;
}

/** The names a declaration binds at the top level. */
function boundNames(decl: Node): string[] {
  if (decl.type === "VariableDeclaration") {
    return decl.declarations.flatMap((d: Node) => patternNames(d.id));
  }
  return decl.id?.name ? [decl.id.name] : [];
}

function patternNames(p: Node): string[] {
  switch (p?.type) {
    case "Identifier":
      return [p.name];
    case "ObjectPattern":
      return p.properties.flatMap((q: Node) =>
        patternNames(q.type === "RestElement" ? q : q.value)
      );
    case "ArrayPattern":
      return p.elements.flatMap((e: Node) => patternNames(e));
    case "RestElement":
      return patternNames(p.argument);
    case "AssignmentPattern":
      return patternNames(p.left);
    default:
      return [];
  }
}

/** The local names the module exports (`export const`, `export function`, `export { a }`). */
function exportedLocals(body: Node[]): Set<string> {
  const names = new Set<string>();
  for (const stmt of body) {
    if (stmt.type !== "ExportNamedDeclaration" || stmt.source) continue;
    if (stmt.declaration) boundNames(stmt.declaration).forEach((n) => names.add(n));
    for (const s of stmt.specifiers ?? []) if (s.local) names.add(s.local.name);
  }
  return names;
}

const exportedName = (s: Node) =>
  s.exported.type === "Identifier" ? s.exported.name : s.exported.value;

/** What the browser half is built from, statement by statement. */
interface Rewrite {
  filename: string;
  tc: StartToolchain;
  /** Start's client RPC factory's local names. */
  rpc: Set<string>;
  /** The local names the module exports. */
  exported: Set<string>;
  imports: Node[];
  /** Top-level declarations nothing exports directly (kept when something kept uses them). */
  locals: Node[];
  exports: Node[];
}

/** `const <names> = <stub>("<name>")` (`prefix` `export `), parsed: nodes to splice in. */
function stubs(r: Rewrite, names: string[], prefix = ""): Node[] {
  if (names.length === 0) return [];
  const decls = names.map((n) => `${n} = ${STUB}(${JSON.stringify(n)})`).join(", ");
  return r.tc.parse(`${prefix}const ${decls};`, r.filename).program.body;
}

/**
 * A declaration as the browser keeps it: a server function (its init calls the RPC factory) as
 * compiled, an exported binding as a stub, anything else as written. One declarator each, so a
 * kept one does not carry an unused sibling along.
 */
function browserDeclaration(r: Rewrite, decl: Node, isExported: (n: string) => boolean): Node[] {
  if (decl.type !== "VariableDeclaration") {
    const name = decl.id?.name;
    return name && isExported(name) ? stubs(r, [name]) : [decl];
  }
  const kept = decl.declarations.filter((d: Node) =>
    callsRpc(d.init, r.rpc) || !patternNames(d.id).some(isExported)
  );
  const stubbed = decl.declarations.filter((d: Node) => !kept.includes(d))
    .flatMap((d: Node) => patternNames(d.id));
  return [...kept.map((d: Node) => ({ ...decl, declarations: [d] })), ...stubs(r, stubbed)];
}

/** One `export …` statement's browser half, into `r.exports`. */
function placeExport(r: Rewrite, stmt: Node): void {
  if (stmt.type === "ExportDefaultDeclaration") {
    const stub = () => r.tc.parse(`export default ${STUB}("default");`, r.filename).program.body;
    r.exports.push(...(callsRpc(stmt.declaration, r.rpc) ? [stmt] : stub()));
  } else if (stmt.source) {
    // A re-export from another module: each name is stubbed here.
    r.exports.push(...stubs(r, stmt.specifiers.map(exportedName), "export "));
  } else if (stmt.declaration) {
    for (const d of browserDeclaration(r, stmt.declaration, () => true)) {
      r.exports.push({ ...stmt, declaration: d });
    }
  } else {
    r.exports.push(stmt);
  }
}

/** Sort one top-level statement into the parts the browser half may keep. */
function place(r: Rewrite, stmt: Node): void {
  switch (stmt.type) {
    case "ImportDeclaration":
      // A bare import runs code for its effects: it goes with the rest of the module.
      if (stmt.specifiers.length > 0) r.imports.push(stmt);
      return;
    case "ExportNamedDeclaration":
    case "ExportDefaultDeclaration":
      return placeExport(r, stmt);
    case "VariableDeclaration":
    case "FunctionDeclaration":
    case "ClassDeclaration":
      r.locals.push(...browserDeclaration(r, stmt, (n) => r.exported.has(n)));
      return;
    default:
      // `export * from` (another module's names, loaded on its own terms) and every top-level
      // statement (server code run for its effects).
      return;
  }
}

/** The locals and imports the exports reach, transitively, in source order. */
function reachable(r: Rewrite): Node[] {
  const used = namesIn(r.exports, new Set());
  const pending = r.locals.map((decl) => ({ decl, binds: boundNames(decl) }));
  for (let grew = true; grew;) {
    grew = false;
    for (const p of pending.filter((p) => p.binds.some((n) => used.has(n)))) {
      namesIn(p.decl, used);
      p.binds = [];
      grew = true;
    }
  }
  const locals = r.locals.filter((decl) => boundNames(decl).some((n) => used.has(n)));
  const imports = r.imports.flatMap((imp) => {
    const specifiers = imp.specifiers.filter((s: Node) => used.has(s.local.name));
    return specifiers.length > 0 ? [{ ...imp, specifiers }] : [];
  });
  return [...imports, ...locals];
}

/**
 * The browser source of a `"use server"` module, from TanStack's client-compiled output.
 *
 * @param compiled The module compiled for the client by TanStack's compiler.
 * @param filename The module's path (for the parser).
 * @param tc TanStack's toolchain (Babel).
 */
export function browserServerModule(
  compiled: string,
  filename: string,
  tc: StartToolchain,
): string {
  const ast = tc.parse(compiled, filename);
  const program = ast.program;
  program.directives = program.directives.filter((d: Node) => d.value.value !== "use server");
  const r: Rewrite = {
    filename,
    tc,
    rpc: rpcNames(program.body),
    exported: exportedLocals(program.body),
    imports: [],
    locals: [],
    exports: [],
  };
  for (const stmt of program.body) place(r, stmt);
  program.body = [...reachable(r), ...r.exports, ...tc.parse(STUB_SOURCE, filename).program.body];
  return tc.print(ast, filename);
}
