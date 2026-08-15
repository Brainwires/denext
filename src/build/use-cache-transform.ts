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

import { join, toFileUrl } from "@std/path";
import { frameworkRoot } from "./bundle.ts";
import {
  applyEdits,
  type Ctx,
  type Edit,
  encoder,
  endOf,
  MARKER,
  MARKER_LEN,
  type Node,
  startOf,
  swcParse,
  walkAst,
} from "./swc-ast.ts";

/** The absolute URL generated modules import the `use cache` runtime from. */
function runtimeUrl(): string {
  return toFileUrl(join(frameworkRoot(), "src/server/cache.ts")).href;
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
  const resolveSpecifier = opts.resolveSpecifier ?? ((u) => u);
  // Cheap pre-filter: with no directive text and no request to rewrite imports,
  // there is nothing to do (avoids parsing the vast majority of modules).
  if (!opts.alwaysRewriteImports && !source.includes("use cache")) {
    return { code: source, changed: false };
  }

  const parse = await swcParse();
  let ast: Node;
  try {
    ast = await parse(MARKER + source);
  } catch {
    return { code: source, changed: false }; // unparseable → identity
  }
  if (!ast.body || ast.body.length === 0) return { code: source, changed: false };

  const base = ast.body[0].span.start; // the marker sits at parsed byte 0
  const ctx: Ctx = { bytes: encoder.encode(source), base: base + MARKER_LEN };
  const body: Node[] = ast.body.slice(1); // drop the marker statement

  const moduleLevel = moduleHasUseCache(body);
  const modId = moduleId(moduleUrl);
  const edits: Edit[] = [];
  let anon = 0;
  let wrappedAny = false;

  const idFor = (name: string | undefined): string => `${modId}#${name ?? `anon${anon++}`}`;

  // Wrap a function *expression* (arrow / function expression) in place: it becomes
  // `_dnxUseCache("id", <expr>, {})`, preserving the surrounding binding/export.
  const wrapExpr = (fn: Node, name: string | undefined): void => {
    edits.push({
      start: startOf(ctx, fn),
      end: startOf(ctx, fn),
      text: `_dnxUseCache(${JSON.stringify(idFor(name))}, `,
    });
    edits.push({ start: endOf(ctx, fn), end: endOf(ctx, fn), text: `, {})` });
    wrappedAny = true;
  };

  // Wrap a function *declaration* (`(export)? function name(){}`) by prefixing a
  // `const name = _dnxUseCache("id", ` before it and `, {});` after — the trailing
  // `function name(){}` becomes a named function expression argument. An `export`
  // keyword, if present, sits before `fn` and is preserved (⇒ `export const name`).
  const wrapDecl = (fn: Node): void => {
    const name = fn.identifier?.value as string | undefined;
    if (!name) return; // an anonymous declaration can't be re-bound by name
    edits.push({
      start: startOf(ctx, fn),
      end: startOf(ctx, fn),
      text: `const ${name} = _dnxUseCache(${JSON.stringify(idFor(name))}, `,
    });
    edits.push({ start: endOf(ctx, fn), end: endOf(ctx, fn), text: `, {});` });
    wrappedAny = true;
  };

  const shouldCache = (fn: Node): boolean => moduleLevel || fnHasUseCache(fn);

  for (const item of body) {
    if (item.type === "FunctionDeclaration") {
      if (isFn(item) && shouldCache(item)) wrapDecl(item);
    } else if (item.type === "VariableDeclaration") {
      for (const d of item.declarations ?? []) {
        if (isFn(d.init) && shouldCache(d.init)) {
          wrapExpr(d.init, d.id?.type === "Identifier" ? d.id.value : undefined);
        }
      }
    } else if (item.type === "ExportDeclaration") {
      const decl = item.declaration;
      if (decl?.type === "FunctionDeclaration") {
        if (shouldCache(decl)) wrapDecl(decl);
      } else if (decl?.type === "VariableDeclaration") {
        for (const d of decl.declarations ?? []) {
          if (isFn(d.init) && shouldCache(d.init)) {
            wrapExpr(d.init, d.id?.type === "Identifier" ? d.id.value : undefined);
          }
        }
      }
    } else if (item.type === "ExportDefaultDeclaration") {
      // `export default function [name](){}` — swc exposes it as `.decl`.
      const decl = item.decl;
      if (isFn(decl) && shouldCache(decl)) {
        const name = decl.identifier?.value as string | undefined;
        // Demoting a name-referenced default to an expression would break other
        // references; bail in that (rare) case.
        if (!name || !referencedOutside(body, name, item)) {
          edits.push({
            start: startOf(ctx, decl),
            end: startOf(ctx, decl),
            text: `_dnxUseCache(${JSON.stringify(idFor(name ?? "default"))}, `,
          });
          edits.push({ start: endOf(ctx, decl), end: endOf(ctx, decl), text: `, {})` });
          wrappedAny = true;
        }
      }
    } else if (item.type === "ExportDefaultExpression") {
      // `export default <arrow|fnExpr>` (possibly parenthesized).
      const expr = unwrapParens(item.expression);
      if (isFn(expr) && shouldCache(expr)) wrapExpr(expr, "default");
    }
  }

  // Nothing to wrap and the caller didn't ask for a bare import rewrite ⇒ identity.
  if (!wrappedAny && !opts.alwaysRewriteImports) return { code: source, changed: false };

  // Rewrite relative import/export specifiers, resolved to absolute then mapped
  // through `resolveSpecifier` (to a transformed sibling for transitive caching).
  // The transformed module is written to a temp dir, so relative paths would
  // otherwise break regardless.
  let rewroteImport = false;
  for (const item of body) {
    const src = item.source;
    if (src?.type !== "StringLiteral") continue;
    const spec = src.value as string;
    if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
    const abs = new URL(spec, moduleUrl).href;
    const final = resolveSpecifier(abs);
    edits.push({ start: startOf(ctx, src), end: endOf(ctx, src), text: JSON.stringify(final) });
    rewroteImport = true;
  }

  // A bare-import-rewrite request that found no local imports to rewrite and wrapped
  // nothing leaves the module byte-identical — report unchanged so the caller can
  // import the original.
  if (!wrappedAny && !rewroteImport) return { code: source, changed: false };

  // Inject the runtime import (only when something was actually wrapped) after any
  // leading directive prologue.
  if (wrappedAny) {
    let importAt = 0;
    for (const item of body) {
      if (item.type === "ExpressionStatement" && item.expression?.type === "StringLiteral") {
        importAt = endOf(ctx, item);
      } else break;
    }
    edits.push({
      start: importAt,
      end: importAt,
      // order:-1 so the import precedes a wrapper prefix inserted at the same offset
      // (a cached function declaration at the very top of a prologue-less module).
      order: -1,
      text: `\nimport { __useCache as _dnxUseCache } from ${JSON.stringify(runtimeUrl())};\n`,
    });
  }

  return { code: applyEdits(ctx.bytes, edits), changed: true };
}
