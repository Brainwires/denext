// Build-time transform for the `"use cache"` directive (Cache Components).
//
// Next.js 16's Cache Components let a function opt into cross-request caching with
// a `"use cache"` directive — either at the top of a module (every function the
// module exports is cached) or as the first statement of a function body (just
// that function). denext owns no transpile hook, so — like the auto-memo compiler
// (`compiler.ts`) — this is a standalone build pass: it parses each candidate
// module with the vendored swc (`swc-ast.ts`), finds the cached functions, and
// rewrites each into a wrapper that delegates to the runtime executor
// `__useCache` (`src/server/cache.ts`):
//
//   async function getPosts(tag) { "use cache"; return db.posts(tag); }
//     ⇒  const getPosts = _dnxUseCache("<mod>#getPosts",
//          async function getPosts(tag) { "use cache"; return db.posts(tag); }, {});
//
// The wrapper owns the public binding; the original function becomes its (still
// directive-bearing, but now inert) argument. The directive string is left in
// place — as a function-body statement it is a harmless no-op string expression,
// and only this build pass and the module-top boundary scanner ever read it.
//
// Methods follow Next.js's SWC transform (`server_actions.rs`): a `"use cache"` static
// class method becomes a static field holding the wrapper (`static get = _dnxUseCache(…)`),
// an object-literal method a `key: _dnxUseCache(…)` property, both keyed on the
// class/object + method name. A method nested in a function closes over that scope, so
// the values it reads from there are keyed too (Next's bound arguments) — passed as a
// `bound` thunk, read per call. Next's rules are build errors here as well: an inline
// `"use cache"` instance method, and `this` / `super` / `arguments` inside a cached
// function (a nested non-arrow function rebinds them, so it may use them).

import { frameworkFileUrl } from "./bundle.ts";
import {
  absolutizeSpecifiers,
  applyEdits,
  collectPatternNames,
  type Ctx,
  type Edit,
  endOf,
  forEachChild,
  lineIndex,
  type Node,
  parseModule,
  positionAt,
  prologueEnd,
  startOf,
  txt,
  walkAst,
} from "./swc-ast.ts";

/** The absolute URL generated modules import the `use cache` runtime from. */
function runtimeUrl(): string {
  return frameworkFileUrl("src/server/cache.ts");
}

/** A short, stable module id (djb2 → base36) used as the cache-key prefix. */
function moduleId(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const FN_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** True if `n` is a function node (declaration, expression, or arrow). */
function isFn(n: Node): boolean {
  return !!n && FN_TYPES.has(n.type);
}

/** The statement list of a function/module block body, tolerant of swc field naming. */
function blockStmts(body: Node): Node[] | null {
  if (!body || body.type !== "BlockStatement") return null;
  return body.stmts ?? body.body ?? [];
}

/** Scan a leading directive prologue for `"use cache"` (skips other directives). */
function hasUseCacheDirective(stmts: Node[]): boolean {
  for (const stmt of stmts) {
    if (stmt?.type !== "ExpressionStatement") break;
    const e = stmt.expression;
    if (e?.type !== "StringLiteral") break;
    if (e.value === "use cache") return true;
    // Some other directive ("use strict"/"use server"): keep scanning the prologue.
  }
  return false;
}

/** True if a function body opens with a `"use cache"` directive. */
function fnHasUseCache(fn: Node): boolean {
  const stmts = blockStmts(fn?.body);
  return stmts ? hasUseCacheDirective(stmts) : false;
}

/** True if the module opens with a top-level `"use cache"` directive. */
function moduleHasUseCache(body: Node[]): boolean {
  return hasUseCacheDirective(body);
}

/**
 * True if `name` appears as an Identifier in any top-level item OTHER than
 * `container` (the `export default` statement holding the function). Used to decide
 * whether a named `export default function name` needs its module-scope binding kept
 * (wrapped as a `const`) or can become a bare wrapped default expression. The function's
 * own name and any self-recursion live inside `container` (a named function expression
 * keeps its name in its own scope), so they don't count.
 */
function referencedOutside(body: Node[], name: string, container: Node): boolean {
  for (const item of body) {
    if (item === container) continue;
    let found = false;
    walkAst(item, (n) => {
      if (n.type === "Identifier" && n.value === name) found = true;
    });
    if (found) return true;
  }
  return false;
}

/** Unwrap parentheses around an expression (`(expr)` ⇒ `expr`). */
function unwrapParens(n: Node): Node {
  let cur = n;
  while (cur && (cur.type === "ParenthesisExpression" || cur.type === "ParenthesizedExpression")) {
    cur = cur.expression;
  }
  return cur;
}

/** The per-module rewrite state. */
interface CacheState {
  readonly ctx: Ctx;
  readonly body: Node[];
  readonly edits: Edit[];
  readonly modId: string;
  readonly moduleUrl: string;
  /** Method cache ids handed out so far (a repeat gets a `~n` suffix). */
  readonly methodIds: Set<string>;
  /** A module-top `"use cache"`: every function the module declares is cached. */
  readonly moduleLevel: boolean;
  anon: number;
  wrappedAny: boolean;
}

function idFor(st: CacheState, name: string | undefined): string {
  return `${st.modId}#${name ?? `anon${st.anon++}`}`;
}

function shouldCache(st: CacheState, fn: Node): boolean {
  return st.moduleLevel || fnHasUseCache(fn);
}

/** Surround `[start, end)` of `fn` with `prefix` … `suffix` and mark the module changed. */
function surround(st: CacheState, fn: Node, prefix: string, suffix: string): void {
  assertCacheable(st, fn);
  st.edits.push({ start: startOf(st.ctx, fn), end: startOf(st.ctx, fn), text: prefix });
  st.edits.push({ start: endOf(st.ctx, fn), end: endOf(st.ctx, fn), text: suffix });
  st.wrappedAny = true;
}

/**
 * Wrap a function *expression* (arrow / function expression) in place: it becomes
 * `_dnxUseCache("id", <expr>, {})`, preserving the surrounding binding/export.
 */
function wrapExpr(st: CacheState, fn: Node, name: string | undefined): void {
  surround(st, fn, `_dnxUseCache(${JSON.stringify(idFor(st, name))}, `, `, {})`);
}

/**
 * Wrap a function *declaration* (`(export)? function name(){}`) by prefixing a
 * `const name = _dnxUseCache("id", ` before it and `, {});` after — the trailing
 * `function name(){}` becomes a named function expression argument. An `export`
 * keyword, if present, sits before `fn` and is preserved (⇒ `export const name`).
 */
function wrapDecl(st: CacheState, fn: Node): void {
  const name = fn.identifier?.value as string | undefined;
  if (!name) return; // an anonymous declaration can't be re-bound by name
  surround(st, fn, `const ${name} = _dnxUseCache(${JSON.stringify(idFor(st, name))}, `, `, {});`);
}

/** Wrap each cached function initializer of a `const`/`let`/`var` declaration. */
function wrapVariableDecls(st: CacheState, decl: Node): void {
  for (const d of decl.declarations ?? []) {
    if (isFn(d.init) && shouldCache(st, d.init)) {
      wrapExpr(st, d.init, d.id?.type === "Identifier" ? d.id.value : undefined);
    }
  }
}

/**
 * `export default function [name](){}` (swc exposes it as `.decl`) becomes
 * `export default _dnxUseCache(…)`. When the name is referenced elsewhere in the module it
 * becomes `const name = _dnxUseCache(…); export { name as default };` instead — the
 * module-scope binding stays, so that reference reaches the cache too (the same demotion
 * {@link wrapDecl} applies to a plain declaration).
 */
function wrapDefaultDecl(st: CacheState, item: Node): void {
  const decl = item.decl;
  if (!isFn(decl) || !shouldCache(st, decl)) return;
  const name = decl.identifier?.value as string | undefined;
  const id = JSON.stringify(idFor(st, name ?? "default"));
  if (!name || !referencedOutside(st.body, name, item)) {
    return surround(st, decl, `_dnxUseCache(${id}, `, `, {})`);
  }
  surround(
    st,
    decl,
    `const ${name} = _dnxUseCache(${id}, `,
    `, {});\nexport { ${name} as default };`,
  );
  // Drop the `export default ` keywords before the (now wrapped) function.
  st.edits.push({ start: startOf(st.ctx, item), end: startOf(st.ctx, decl), text: "" });
}

/** Wrap whatever cached functions a top-level item declares. */
function wrapItem(st: CacheState, item: Node): void {
  switch (item.type) {
    case "FunctionDeclaration":
      if (shouldCache(st, item)) wrapDecl(st, item);
      return;
    case "VariableDeclaration":
      wrapVariableDecls(st, item);
      return;
    case "ExportDeclaration": {
      const decl = item.declaration;
      if (decl?.type === "FunctionDeclaration" && shouldCache(st, decl)) wrapDecl(st, decl);
      else if (decl?.type === "VariableDeclaration") wrapVariableDecls(st, decl);
      return;
    }
    case "ExportDefaultDeclaration":
      wrapDefaultDecl(st, item);
      return;
    case "ExportDefaultExpression": {
      // `export default <arrow|fnExpr>` (possibly parenthesized).
      const expr = unwrapParens(item.expression);
      if (isFn(expr) && shouldCache(st, expr)) wrapExpr(st, expr, "default");
      return;
    }
  }
}

// ---- Next.js's rules: `this` / `super` / `arguments`, instance methods -------------

const INSTANCE_METHOD_ERROR =
  'It is not allowed to define inline "use cache" annotated class instance methods.\n' +
  "To define cached functions, use functions, object method properties, or static class " +
  "methods instead.";

/** Function-like nodes: each opens a scope the transform tracks for closures. */
const FN_SCOPES = new Set([
  ...FN_TYPES,
  "ClassMethod",
  "PrivateMethod",
  "Constructor",
  "MethodProperty",
  "GetterProperty",
  "SetterProperty",
]);

/** A node visitor (one step of a recursive walk). */
type Visit = (n: Node) => void;

/** A build error pointing at `node` in this module. */
function cacheError(st: CacheState, node: Node, message: string): Error {
  const { bytes } = st.ctx;
  const { line, column } = positionAt(bytes, lineIndex(bytes), startOf(st.ctx, node));
  return new Error(`${message}\n    at ${st.moduleUrl}:${line}:${column}`);
}

/** The parameters and body of a function-like node (a class method keeps them on `.function`). */
function fnParts(fn: Node): { params: Node[]; body: Node } {
  const f = fn.function ?? fn;
  return { params: f.params ?? [], body: f.body };
}

/** Visit a property key only when it is computed (`[expr]`): a plain key is no reference. */
function visitComputedKey(key: Node, visit: Visit): void {
  if (key?.type === "Computed") visit(key);
}

/** Visit a member access's object, and its property only when computed (`a[b]`). */
function visitMember(n: Node, visit: Visit): void {
  const object = n.object ?? n.obj;
  if (object) visit(object);
  visitComputedKey(n.property, visit);
}

/** Visit a keyed property's computed key and its value. */
function visitKeyed(n: Node, visit: Visit): void {
  visitComputedKey(n.key, visit);
  if (n.value) visit(n.value);
}

/** A `this` / `super` / `arguments` use: the expression's name, else null. */
function forbiddenExpr(n: Node): string | null {
  if (n.type === "ThisExpression") return "this";
  if (n.type === "Super") return "super";
  return n.type === "Identifier" && n.value === "arguments" ? "arguments" : null;
}

/**
 * Node types the forbidden-expression check handles itself; any other type has its
 * children checked. A class only evaluates its `extends` clause in the enclosing scope.
 */
const CHECK_RULES = new Map<string, (n: Node, check: Visit) => void>([
  ["ClassDeclaration", (n, check) => n.superClass && check(n.superClass)],
  ["ClassExpression", (n, check) => n.superClass && check(n.superClass)],
  ["MemberExpression", visitMember],
  ["SuperPropExpression", visitMember],
  ["KeyValueProperty", visitKeyed],
]);

/** True for a node the forbidden-expression check doesn't descend into. */
function rebindsThis(type: string): boolean {
  return type.startsWith("Ts") || (type !== "ArrowFunctionExpression" && FN_SCOPES.has(type));
}

/**
 * Throw if a cached function reads `this`, `super` or `arguments` — the cached result is
 * shared across callers, so none of them may shape it (Next.js's `ForbiddenExpression`).
 * An arrow inherits them, so it is checked through; any other nested function (or class
 * member) rebinds them and is skipped.
 */
function assertCacheable(st: CacheState, fn: Node): void {
  const check: Visit = (n) => {
    const type = n.type;
    if (typeof type === "string") {
      if (rebindsThis(type)) return;
      const expr = forbiddenExpr(n);
      if (expr) throw cacheError(st, n, `"use cache" functions cannot use \`${expr}\`.`);
      const rule = CHECK_RULES.get(type);
      if (rule) return rule(n, check);
    }
    forEachChild(n, check);
  };
  const { params, body } = fnParts(fn);
  for (const p of params) check(p);
  if (body) check(body);
}

// ---- Closures: the bound values a nested method's key covers ------------------------

/** What a scope scan accumulates: declared names, read names, and the walk itself. */
interface ScopeScan {
  readonly decls: Set<string>;
  readonly refs: Set<string>;
  readonly scan: Visit;
}

/** A nested function: its own declaration name is ours, its free names are reads. */
function scanNestedFn(n: Node, s: ScopeScan): void {
  if (n.type === "FunctionDeclaration" && n.identifier) s.decls.add(n.identifier.value);
  visitComputedKey(n.key, s.scan);
  for (const name of scopeNames(n).free) s.refs.add(name);
}

/**
 * Node types the scope scan handles itself; any other type has its children scanned.
 * Labels, plain property keys, JSX attribute names and TypeScript types are no reads.
 */
const SCAN_RULES = new Map<string, (n: Node, s: ScopeScan) => void>([
  ["Identifier", (n, s) => s.refs.add(n.value)],
  ["VariableDeclarator", (n, s) => {
    collectPatternNames(n.id, s.decls);
    s.scan(n.id);
    if (n.init) s.scan(n.init);
  }],
  ["ClassDeclaration", (n, s) => {
    if (n.identifier) s.decls.add(n.identifier.value);
    forEachChild(n, s.scan);
  }],
  ["CatchClause", (n, s) => {
    if (n.param) collectPatternNames(n.param, s.decls);
    forEachChild(n, s.scan);
  }],
  ["MemberExpression", (n, s) => visitMember(n, s.scan)],
  ["SuperPropExpression", (n, s) => visitMember(n, s.scan)],
  ["KeyValueProperty", (n, s) => visitKeyed(n, s.scan)],
  ["KeyValuePatternProperty", (n, s) => visitKeyed(n, s.scan)],
  ["ClassProperty", (n, s) => visitKeyed(n, s.scan)],
  ["PrivateProperty", (n, s) => visitKeyed(n, s.scan)],
  ["LabeledStatement", (n, s) => s.scan(n.body)],
  ["BreakStatement", () => {}],
  ["ContinueStatement", () => {}],
  ["JSXAttribute", (n, s) => n.value && s.scan(n.value)],
  ["JSXMemberExpression", (n, s) => s.scan(n.object)],
]);

/**
 * The names `fn` declares (params, `var`/`let`/`const`, function and class declarations,
 * `catch` bindings — block scoping flattened) and the names it reads but doesn't declare.
 * Nested functions contribute their own free names. Over-reading is the safe direction:
 * an extra bound value only makes the key more specific.
 */
function scopeNames(fn: Node): { decls: Set<string>; free: Set<string> } {
  const s: ScopeScan = {
    decls: new Set(),
    refs: new Set(),
    scan: (n) => {
      const type = n.type;
      if (typeof type === "string") {
        if (type.startsWith("Ts")) return;
        if (FN_SCOPES.has(type)) return scanNestedFn(n, s);
        const rule = SCAN_RULES.get(type);
        if (rule) return rule(n, s);
      }
      forEachChild(n, s.scan);
    },
  };
  if (fn.type === "FunctionExpression" && fn.identifier) s.decls.add(fn.identifier.value);
  const { params, body } = fnParts(fn);
  for (const p of params) {
    collectPatternNames(p.pat ?? p, s.decls);
    s.scan(p);
  }
  if (body) s.scan(body);
  return { decls: s.decls, free: new Set([...s.refs].filter((name) => !s.decls.has(name))) };
}

/** The enclosing-function names `fn` reads, sorted: what its cache key binds. */
function boundNames(fn: Node, scopes: readonly Node[]): string[] {
  if (scopes.length === 0) return []; // module scope: nothing is closed over per call site
  const outer = new Set<string>();
  for (const scope of scopes) for (const name of scopeNames(scope).decls) outer.add(name);
  return [...scopeNames(fn).free].filter((name) => outer.has(name)).sort();
}

/** The wrapper's options literal: `{}`, or the `bound` thunk over `names`. */
function wrapperOptions(names: readonly string[]): string {
  return names.length ? `{ bound: () => [${names.join(", ")}] }` : "{}";
}

// ---- Methods: class static methods and object-literal methods ------------------------

/** A unique, stable cache id for a method at `label` (`Class.method` / `object.key`). */
function methodId(st: CacheState, label: string): string {
  const base = `${st.modId}#${label}`;
  let id = base;
  for (let i = 2; st.methodIds.has(id); i++) id = `${base}~${i}`;
  st.methodIds.add(id);
  return id;
}

/** A method key as an id segment (`get`, `#get`, `"x-y"`, `["computed"]`). */
function keyLabel(st: CacheState, key: Node): string {
  if (key.type === "Identifier") return key.value;
  if (key.type === "PrivateName") return `#${key.value}`;
  return txt(st.ctx, key);
}

/** The cache id for a member keyed `key` of the class/object named `owner`. */
function memberId(st: CacheState, owner: string | undefined, key: Node): string {
  return JSON.stringify(methodId(st, `${owner ?? "anon"}.${keyLabel(st, key)}`));
}

/**
 * Rewrite a method `[modifiers] key(params) { "use cache"; … }` into
 * `<lead>key<sep>_dnxUseCache("id", async function (params) { … }, opts)<end>`: the
 * method head up to the end of its key is replaced, the parameter list, return type and
 * body are kept as written.
 */
function rewriteMethod(
  st: CacheState,
  member: Node,
  syntax: { lead: string; sep: string; end: string },
  owner: string | undefined,
  scopes: readonly Node[],
): void {
  const fn = member.function ?? member;
  assertCacheable(st, member);
  const key = member.key;
  const keyText = key.type === "PrivateName" ? `#${key.value}` : txt(st.ctx, key);
  const head = `${fn.async ? "async " : ""}function${fn.generator ? "*" : ""} `;
  const wrapper = `_dnxUseCache(${memberId(st, owner, key)}, ${head}`;
  st.edits.push({
    start: startOf(st.ctx, member),
    end: endOf(st.ctx, key),
    text: `${syntax.lead}${keyText}${syntax.sep}${wrapper}`,
  });
  const close = `, ${wrapperOptions(boundNames(member, scopes))})${syntax.end}`;
  st.edits.push({ start: endOf(st.ctx, member), end: endOf(st.ctx, member), text: close });
  st.wrappedAny = true;
}

/** A getter/setter can't carry the directive (it can't be re-bound to a wrapper). */
function accessorError(st: CacheState, member: Node): Error {
  return cacheError(st, member, '"use cache" can\'t annotate a getter or setter.');
}

/** Cache one `"use cache"` static method; an instance method or accessor is an error. */
function cacheClassMember(
  st: CacheState,
  member: Node,
  owner: string | undefined,
  scopes: readonly Node[],
): void {
  if (member.type !== "ClassMethod" && member.type !== "PrivateMethod") return;
  if (!fnHasUseCache(member.function)) return;
  if (!member.isStatic) throw cacheError(st, member, INSTANCE_METHOD_ERROR);
  if (member.kind !== "method") throw accessorError(st, member);
  const lead = `${member.accessibility ? `${member.accessibility} ` : ""}static `;
  rewriteMethod(st, member, { lead, sep: " = ", end: ";" }, owner, scopes);
}

/** Cache one `"use cache"` method / function-valued property of an object literal. */
function cacheObjectProp(
  st: CacheState,
  prop: Node,
  owner: string | undefined,
  scopes: readonly Node[],
): void {
  if (prop.type === "MethodProperty") {
    if (fnHasUseCache(prop)) {
      rewriteMethod(st, prop, { lead: "", sep: ": ", end: "" }, owner, scopes);
    }
    return;
  }
  if (prop.type === "GetterProperty" || prop.type === "SetterProperty") {
    if (fnHasUseCache(prop)) throw accessorError(st, prop);
    return;
  }
  if (prop.type !== "KeyValueProperty") return;
  const value = unwrapParens(prop.value);
  if (!isFn(value) || !fnHasUseCache(value)) return;
  const opts = wrapperOptions(boundNames(value, scopes));
  surround(st, value, `_dnxUseCache(${memberId(st, owner, prop.key)}, `, `, ${opts})`);
}

/** Node types whose own members can carry `"use cache"`. */
const CLASS_TYPES = new Set(["ClassDeclaration", "ClassExpression"]);

/** Cache the `"use cache"` members `node` (a class or object literal) declares itself. */
function cacheOwnMembers(
  st: CacheState,
  node: Node,
  owner: string | undefined,
  scopes: readonly Node[],
): void {
  if (CLASS_TYPES.has(node.type)) {
    const name = node.identifier?.value ?? owner;
    for (const member of node.body) cacheClassMember(st, member, name, scopes);
  } else if (node.type === "ObjectExpression") {
    for (const prop of node.properties) cacheObjectProp(st, prop, owner, scopes);
  }
}

/**
 * The child that `node` names, and the name: `const api = { … }` ⇒ `api`,
 * `{ repo: { … } }` ⇒ `repo` — so the inner object's methods key as `api.*` / `repo.*`.
 */
function namedChild(st: CacheState, node: Node): [Node, string] | null {
  if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
    return [node.init, node.id.value];
  }
  if (node.type === "KeyValueProperty" && node.key?.type !== "Computed") {
    return [node.value, keyLabel(st, node.key)];
  }
  return null;
}

/**
 * Walk the module for classes and object literals carrying `"use cache"` methods, at any
 * depth, tracking the enclosing function scopes (`scopes`) a nested one closes over.
 * `owner` names the class/object for the key.
 */
function visitMethods(
  st: CacheState,
  node: Node,
  scopes: readonly Node[],
  owner: string | undefined,
): void {
  if (!node || typeof node !== "object") return;
  const named = namedChild(st, node);
  if (named) return visitMethods(st, named[0], scopes, named[1]);
  cacheOwnMembers(st, node, owner, scopes);
  const inner = FN_SCOPES.has(node.type) ? [...scopes, node] : scopes;
  forEachChild(node, (child) => visitMethods(st, child, inner, undefined));
}

/**
 * Transform one module's source, wrapping each `"use cache"` function in a
 * `__useCache(...)` call. Returns the rewritten code and whether anything changed
 * (unchanged ⇒ the caller keeps the original module).
 *
 * @param source The module source.
 * @param moduleUrl The module's absolute URL (for the cache-key prefix and for
 *   rewriting relative import specifiers, since the output lives in a temp dir).
 * @param opts.resolveSpecifier Maps a resolved (absolute) import URL to the URL the
 *   rewritten module should import — used to point at *transformed* siblings for
 *   transitive `use cache`. Defaults to identity (import the original absolute URL).
 * @param opts.resolveBare Maps a bare (import-map alias) specifier to the URL the rewritten
 *   module should import instead, or null to leave it as written.
 * @param opts.alwaysRewriteImports Rewrite local import specifiers even when the
 *   module wraps no function of its own — so a directive-free module can still be
 *   redirected to import transformed (cached) siblings. When false (default), a
 *   module that wraps nothing is returned unchanged.
 */
export async function transformUseCache(
  source: string,
  moduleUrl: string,
  opts: {
    resolveSpecifier?: (absUrl: string) => string;
    resolveBare?: (spec: string) => string | null;
    alwaysRewriteImports?: boolean;
  } = {},
): Promise<{ code: string; changed: boolean }> {
  const identity = { code: source, changed: false };
  // Cheap pre-filter: with no directive text and no request to rewrite imports,
  // there is nothing to do (avoids parsing the vast majority of modules).
  if (!opts.alwaysRewriteImports && !source.includes("use cache")) return identity;
  const parsed = await parseModule(source);
  if (!parsed) return identity; // unparseable/empty → identity
  const { ctx, body } = parsed;
  const st: CacheState = {
    ctx,
    body,
    edits: [],
    modId: moduleId(moduleUrl),
    moduleUrl,
    methodIds: new Set(),
    moduleLevel: moduleHasUseCache(body),
    anon: 0,
    wrappedAny: false,
  };
  for (const item of body) wrapItem(st, item);
  for (const item of body) visitMethods(st, item, [], undefined);
  // Nothing to wrap and the caller didn't ask for a bare import rewrite ⇒ identity.
  if (!st.wrappedAny && !opts.alwaysRewriteImports) return identity;
  // Relative specifiers → absolute, mapped through `resolveSpecifier` (to a transformed
  // sibling for transitive caching). A bare-import-rewrite request that found no local
  // imports and wrapped nothing leaves the module byte-identical — report unchanged.
  const rewroteImport = absolutizeSpecifiers(
    ctx,
    body,
    moduleUrl,
    st.edits,
    opts.resolveSpecifier,
    opts.resolveBare,
  );
  if (!st.wrappedAny && !rewroteImport) return identity;
  if (st.wrappedAny) {
    // The runtime import goes after any leading directive prologue; order:-1 so it
    // precedes a wrapper prefix inserted at the same offset (a cached function
    // declaration at the very top of a prologue-less module).
    const importAt = prologueEnd(ctx, body);
    st.edits.push({
      start: importAt,
      end: importAt,
      order: -1,
      text: `\nimport { __useCache as _dnxUseCache } from ${JSON.stringify(runtimeUrl())};\n`,
    });
  }
  return { code: applyEdits(ctx.bytes, st.edits), changed: true };
}
