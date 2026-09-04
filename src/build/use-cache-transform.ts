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
// Correctness over coverage: forms that can't be rewritten while preserving their
// binding/export semantics (object/class methods, a name-referenced default
// export) are left untouched.

import { frameworkFileUrl } from "./bundle.ts";
import {
  absolutizeSpecifiers,
  applyEdits,
  type Ctx,
  type Edit,
  endOf,
  type Node,
  parseModule,
  prologueEnd,
  startOf,
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
 * `container` (the `export default` statement holding the function). Used to
 * decide whether wrapping a named `export default function name` — which would
 * demote its module-scope binding to a local — is safe. The function's own name
 * and any self-recursion live inside `container` (a named function expression
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
 * `export default function [name](){}` (swc exposes it as `.decl`). Demoting a
 * name-referenced default to an expression would break other references; bail in that
 * (rare) case.
 */
function wrapDefaultDecl(st: CacheState, item: Node): void {
  const decl = item.decl;
  if (!isFn(decl) || !shouldCache(st, decl)) return;
  const name = decl.identifier?.value as string | undefined;
  if (name && referencedOutside(st.body, name, item)) return;
  surround(st, decl, `_dnxUseCache(${JSON.stringify(idFor(st, name ?? "default"))}, `, `, {})`);
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
 * @param opts.alwaysRewriteImports Rewrite local import specifiers even when the
 *   module wraps no function of its own — so a directive-free module can still be
 *   redirected to import transformed (cached) siblings. When false (default), a
 *   module that wraps nothing is returned unchanged.
 */
export async function transformUseCache(
  source: string,
  moduleUrl: string,
  opts: { resolveSpecifier?: (absUrl: string) => string; alwaysRewriteImports?: boolean } = {},
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
    moduleLevel: moduleHasUseCache(body),
    anon: 0,
    wrappedAny: false,
  };
  for (const item of body) wrapItem(st, item);
  // Nothing to wrap and the caller didn't ask for a bare import rewrite ⇒ identity.
  if (!st.wrappedAny && !opts.alwaysRewriteImports) return identity;
  // Relative specifiers → absolute, mapped through `resolveSpecifier` (to a transformed
  // sibling for transitive caching). A bare-import-rewrite request that found no local
  // imports and wrapped nothing leaves the module byte-identical — report unchanged.
  const rewroteImport = absolutizeSpecifiers(ctx, body, moduleUrl, st.edits, opts.resolveSpecifier);
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
