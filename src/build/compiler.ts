// Experimental auto-memoization compiler (a React-Compiler-style pass).
//
// denext owns no transpile hook — `deno bundle` runs swc internally — so this is a
// separate build-time pass that rewrites user modules and feeds the rewritten
// versions into the *client* bundle via the existing import-map redirect seam
// (the same mechanism that swaps `"use server"` modules for stubs). It only ever
// needs to touch the client bundle: on the server `useMemoCache` returns a fresh
// sentinel-filled array each render, so transformed code is byte-for-byte
// equivalent to the original there — SSR/hydration stay consistent.
//
// The transform is deliberately conservative: it lifts each JSX *component
// element* into a `memoValue(cache, slot, () => <El/>, [deps])` call so an element
// whose reactive dependencies did not change keeps the same reference across
// renders, which lets the reconciler bail out of that subtree. Anything it cannot
// analyze with confidence is emitted unchanged (bail to identity). Correctness
// over coverage.

import { walk } from "@std/fs";
import { join } from "@std/path";
import { frameworkFileUrl } from "./bundle.ts";
import {
  absolutizeSpecifiers,
  applyEdits,
  collectPatternNames,
  type Ctx,
  type Edit,
  endOf,
  forEachChild,
  isRelativeSpecifier,
  type Node,
  parseModule,
  prologueEnd,
  startOf,
  txt,
  walkAst,
  writeTransformedModules,
} from "./swc-ast.ts";

/** The absolute URL generated modules import the memo runtime from. */
function runtimeUrl(): string {
  return frameworkFileUrl("src/runtime/compiler-runtime.ts");
}

/**
 * Render-stable global identifiers: a memoized expression may reference these
 * freely without listing them as reactive dependencies (their bindings never
 * change between renders). Used by {@link containerAnalysis}'s soundness check.
 */
const SAFE_GLOBALS = new Set([
  "Math",
  "JSON",
  "Object",
  "Array",
  "Number",
  "String",
  "Boolean",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Symbol",
  "BigInt",
  "console",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "undefined",
  "NaN",
  "Infinity",
  "globalThis",
  "structuredClone",
  "Error",
  "encodeURIComponent",
  "decodeURIComponent",
]);

/** True if a JSX element's tag is a component (Capitalized identifier). */
function isComponentElement(node: Node): boolean {
  const name = node.opening?.name;
  return name?.type === "Identifier" && /^[A-Z]/.test(name.value);
}

/** True if `name` is a capitalized identifier node (a component reference). */
function isCapitalizedName(node: Node): boolean {
  return node?.type === "Identifier" && /^[A-Z]/.test(node.value);
}

/** True if the subtree contains at least one component JSX element. */
function containsComponentElement(node: Node): boolean {
  let found = false;
  walkAst(node, (n) => {
    if (n.type === "JSXElement" && isComponentElement(n)) found = true;
  });
  return found;
}

/**
 * Collect the free *reference* identifiers of an expression into `into`, skipping
 * positions that are never variable reads: a non-computed member `.property`
 * (`a.b` → `b`), a JSX attribute *name*, and a *lowercase* host tag name (`<div>`).
 * A capitalized tag (`<Card>`) IS collected — it names a component reference. This
 * may over-collect (an unusual property position) but never under-collects, so a
 * reactive dep is never missed. It does NOT stop at nested function scopes; inner
 * params/locals are removed separately (see {@link locallyBound}).
 */
function collectFreeRefs(node: Node, into: Set<string>): void {
  if (!node || typeof node !== "object") return;
  const handler = FREE_REF_HANDLERS[node.type as string];
  if (handler) handler(node, into);
  else forEachChild(node, (c) => collectFreeRefs(c, into), FREE_REF_SKIP);
}

const FREE_REF_SKIP: ReadonlySet<string> = new Set(["type", "span", "ctxt"]);

/** Per node type: which positions are references (the default walks every child). */
const FREE_REF_HANDLERS: Record<string, (node: Node, into: Set<string>) => void> = {
  Identifier: (n, into) => into.add(n.value),
  MemberExpression: (n, into) => {
    collectFreeRefs(n.object, into);
    // Non-computed `.prop` is not a reference; a computed `a[expr]` is.
    if (n.computed || n.property?.type === "Computed") collectFreeRefs(n.property, into);
  },
  KeyValueProperty: (n, into) => {
    if (n.computed || n.key?.type === "Computed") collectFreeRefs(n.key, into);
    collectFreeRefs(n.value, into);
  },
  JSXElement: (n, into) => {
    collectFreeRefs(n.opening, into);
    for (const c of n.children ?? []) collectFreeRefs(c, into);
    // The closing tag name is redundant with the opening.
  },
  JSXFragment: (n, into) => {
    for (const c of n.children ?? []) collectFreeRefs(c, into);
  },
  JSXOpeningElement: (n, into) => {
    if (isCapitalizedName(n.name)) into.add(n.name.value);
    for (const a of n.attributes ?? []) collectFreeRefs(a, into);
  },
  JSXAttribute: (n, into) => collectFreeRefs(n.value, into), // the attribute name is not a reference
  JSXClosingElement: () => {},
};

/**
 * Collect the names bound *inside* an expression — inner function/arrow params and
 * any local declarations (so a `.map((it) => …)` callback's `it` is excluded from
 * the expression's free-variable set).
 */
function locallyBound(node: Node, out: Set<string>): void {
  walkAst(node, (n) => {
    if (
      n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression" ||
      n.type === "FunctionDeclaration"
    ) {
      for (const p of n.params ?? []) collectPatternNames(p.type === "Parameter" ? p.pat : p, out);
    } else if (n.type === "VariableDeclarator") {
      collectPatternNames(n.id, out);
    } else if (n.type === "CatchClause" && n.param) {
      collectPatternNames(n.param, out);
    }
  });
}

/**
 * Analyze a JSX expression container for whole-expression memoization: its reactive
 * dependencies (component-scope bindings it reads) and whether memoizing it is
 * *sound*. Every free identifier must be classifiable as a component-scope binding
 * (→ a dep), a module-level/imported name, or a {@link SAFE_GLOBALS} global. An
 * unclassifiable free var — e.g. a nested-block binding the top-level scope scan
 * cannot see — forces `sound: false`, so the caller leaves the container verbatim
 * rather than risk caching a stale value. Over-bailing is safe; a missed dep is not.
 */
function containerAnalysis(
  ctx: Ctx,
  expr: Node,
  bindings: Bindings,
  moduleNames: Set<string>,
): { deps: string[]; sound: boolean } {
  const refs = new Set<string>();
  collectFreeRefs(expr, refs);
  const local = new Set<string>();
  locallyBound(expr, local);
  const at = startOf(ctx, expr);
  const deps: string[] = [];
  let sound = true;
  for (const name of refs) {
    if (local.has(name)) continue; // bound within the expression
    const declEnd = bindings.get(name);
    if (declEnd !== undefined) {
      // A component-scope binding declared before this point is a reactive dep. One
      // declared after (an unreachable early-return branch) is in-scope-classified
      // but not a dep — matching the element-memo path's `depsOf`.
      if (declEnd === -1 || declEnd <= at) deps.push(name);
      continue;
    }
    if (moduleNames.has(name) || SAFE_GLOBALS.has(name)) continue; // render-stable
    sound = false; // unclassifiable → unsafe to memoize
  }
  return { deps, sound };
}

/** The declaration a top-level item carries (unwrapping `export` / `export default`). */
function declarationOf(item: Node): Node | null {
  if (item.type === "ExportDeclaration") return item.declaration ?? null;
  if (item.type === "ExportDefaultDeclaration") return item.decl ?? null;
  return item;
}

/** Add the names a variable/function/class declaration binds. */
function addDeclaredNames(decl: Node, names: Set<string>): void {
  if (decl.type === "VariableDeclaration") {
    for (const d of decl.declarations ?? []) collectPatternNames(d.id, names);
  } else if (
    (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") && decl.identifier
  ) {
    names.add(decl.identifier.value);
  }
}

/** Collect a module's top-level binding names (imports + top-level declarations). */
function collectModuleNames(body: Node[]): Set<string> {
  const names = new Set<string>();
  for (const item of body) {
    if (item.type === "ImportDeclaration") {
      for (const s of item.specifiers ?? []) if (s.local?.value) names.add(s.local.value);
      continue;
    }
    const decl = declarationOf(item);
    if (decl) addDeclaredNames(decl, names);
  }
  return names;
}

/** Bindings visible in a component: name → declaration end offset (params: -1). */
type Bindings = Map<string, number>;

/**
 * The reactive dependencies of a JSX node: component-scope bindings referenced in
 * its span that are already declared at its start (avoids capturing a
 * yet-undeclared local from an early-return branch).
 */
function depsOf(ctx: Ctx, node: Node, bindings: Bindings): string[] {
  const at = startOf(ctx, node);
  const seen = new Set<string>();
  const out: string[] = [];
  walkAst(node, (n) => {
    if (n.type !== "Identifier") return;
    const declEnd = bindings.get(n.value);
    if (declEnd === undefined) return;
    if (declEnd !== -1 && declEnd > at) return; // declared after this element
    if (!seen.has(n.value)) {
      seen.add(n.value);
      out.push(n.value);
    }
  });
  return out;
}

/** Mutable slot allocator shared across one component's cache. */
interface Slots {
  count: number;
}

/** Per-component emit context threaded through the JSX rebuild. */
interface EmitCtx {
  ctx: Ctx;
  bindings: Bindings;
  slots: Slots;
  /** Module-level binding names (imports + top-level declarations) — render-stable. */
  moduleNames: Set<string>;
}

/**
 * Emit a JSX node as an expression string, memoizing component elements. `child`
 * marks JSX-child position (a component there is wrapped in `{…}`).
 */
function emitNode(e: EmitCtx, node: Node): string {
  if (node.type === "JSXElement" && isComponentElement(node)) {
    const deps = depsOf(e.ctx, node, e.bindings);
    const slot = e.slots.count;
    e.slots.count += 1 + deps.length;
    const inner = rebuildElement(e, node);
    return `_dnxMemo(_dnxC, ${slot}, () => (${inner}), [${deps.join(", ")}])`;
  }
  // Host element or fragment: keep as JSX, but rebuild children so nested
  // components still get memoized.
  return rebuildElement(e, node);
}

/** Rebuild a JSX element/fragment's source with its children transformed. */
function rebuildElement(e: EmitCtx, node: Node): string {
  if (node.type === "JSXElement") {
    const opening = txt(e.ctx, node.opening);
    if (node.opening.selfClosing) return opening;
    const kids = node.children.map((c: Node) => emitChild(e, c)).join("");
    const closing = node.closing ? txt(e.ctx, node.closing) : "";
    return opening + kids + closing;
  }
  // JSXFragment
  return txt(e.ctx, node.opening) +
    node.children.map((c: Node) => emitChild(e, c)).join("") +
    txt(e.ctx, node.closing);
}

/** Emit a JSX child (child position: components become `{memoValue(...)}`). */
function emitChild(e: EmitCtx, child: Node): string {
  if (child.type === "JSXElement") {
    if (isComponentElement(child)) return `{${emitNode(e, child)}}`;
    return rebuildElement(e, child); // host: recurse
  }
  if (child.type === "JSXFragment") return rebuildElement(e, child);
  // A `{…}` expression container holding component elements (the `.map()` list
  // idiom is the big payoff) is memoized as a WHOLE — its inner elements aren't
  // individually memoized because a list produces a variable element count and no
  // stable per-element slot. Memoize only when the analysis proves it sound (every
  // free var is a tracked dep or render-stable); otherwise leave it verbatim.
  if (child.type === "JSXExpressionContainer" && child.expression) {
    const expr = child.expression;
    if (containsComponentElement(expr)) {
      const { deps, sound } = containerAnalysis(e.ctx, expr, e.bindings, e.moduleNames);
      if (sound) {
        const slot = e.slots.count;
        e.slots.count += 1 + deps.length;
        return `{_dnxMemo(_dnxC, ${slot}, () => (${txt(e.ctx, expr)}), [${deps.join(", ")}])}`;
      }
    }
  }
  // JSXText / non-memoizable JSXExpressionContainer / JSXSpreadChild: keep verbatim.
  return txt(e.ctx, child);
}

/** Unwrap parentheses around a return/arrow-body expression. */
function unwrapParens(node: Node): Node {
  let n = node;
  while (n && (n.type === "ParenthesisExpression" || n.type === "ParenthesizedExpression")) {
    n = n.expression;
  }
  return n;
}

const isJsx = (n: Node): boolean => n && (n.type === "JSXElement" || n.type === "JSXFragment");

const isFnExpression = (n: Node): boolean =>
  n?.type === "ArrowFunctionExpression" || n?.type === "FunctionExpression";

/** Extract the underlying function node from a component declaration, or null. */
function componentFunction(item: Node): Node | null {
  const decl = declarationOf(item);
  if (!decl) return null;
  if (decl.type === "FunctionDeclaration" || decl.type === "FunctionExpression") {
    // A default-exported anonymous function is a component candidate too.
    const name = decl.identifier?.value;
    return name && !/^[A-Z]/.test(name) ? null : decl;
  }
  // `const Name = (…) => …` / `= function(){}`
  if (decl.type !== "VariableDeclaration" || decl.declarations.length !== 1) return null;
  const d = decl.declarations[0];
  if (d.id?.type !== "Identifier" || !/^[A-Z]/.test(d.id.value)) return null;
  return isFnExpression(d.init) ? d.init : null;
}

/** Bind every name of a pattern to `end` (params: -1); body locals never shadow an earlier binding. */
function bindPattern(pat: Node, bindings: Bindings, end: number): void {
  const names = new Set<string>();
  collectPatternNames(pat, names);
  for (const n of names) if (end === -1 || !bindings.has(n)) bindings.set(n, end);
}

/** Gather a function's parameter + top-level local bindings. */
function functionBindings(ctx: Ctx, fn: Node): Bindings {
  const bindings: Bindings = new Map();
  for (const p of fn.params ?? []) bindPattern(p.type === "Parameter" ? p.pat : p, bindings, -1);
  if (fn.body?.type !== "BlockStatement") return bindings;
  for (const stmt of fn.body.stmts ?? fn.body.body ?? []) {
    const end = stmt.span.end - ctx.base;
    if (stmt.type === "VariableDeclaration") {
      for (const d of stmt.declarations) bindPattern(d.id, bindings, end);
    } else if (stmt.type === "FunctionDeclaration" && stmt.identifier) {
      bindings.set(stmt.identifier.value, end);
    }
  }
  return bindings;
}

/** Find return statements belonging to `fn` (not nested functions). */
function ownReturns(fn: Node): Node[] {
  const returns: Node[] = [];
  const NESTED = new Set([
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
  ]);
  const visit = (node: Node): void => {
    if (!node || typeof node !== "object") return;
    if (node.type === "ReturnStatement") returns.push(node);
    for (const key of Object.keys(node)) {
      const v = node[key];
      const each = (c: Node) => {
        if (c && typeof c === "object") {
          if (NESTED.has(c.type)) return; // do not descend into nested functions
          visit(c);
        }
      };
      if (Array.isArray(v)) v.forEach(each);
      else each(v);
    }
  };
  // Visit the body's statements, not `fn` itself (which is a function node).
  for (const stmt of fn.body?.stmts ?? fn.body?.body ?? []) visit(stmt);
  return returns;
}

/**
 * Memoize the JSX returned by a block-bodied component (each own `return <jsx>`), then
 * declare the cache just after `{`. Returns whether anything was memoized.
 */
function memoizeBlockBody(e: EmitCtx, fn: Node, edits: Edit[]): boolean {
  const { ctx, slots } = e;
  for (const ret of ownReturns(fn)) {
    if (!ret.argument) continue;
    const arg = unwrapParens(ret.argument);
    if (!isJsx(arg)) continue;
    edits.push({
      start: startOf(ctx, ret.argument),
      end: endOf(ctx, ret.argument),
      text: emitNode(e, arg),
    });
  }
  if (slots.count === 0) return false;
  const insertAt = startOf(ctx, fn.body) + 1; // just after `{`
  edits.push({
    start: insertAt,
    end: insertAt,
    text: `\n  const _dnxC = _dnxUseMemoCache(${slots.count});`,
  });
  return true;
}

/** Memoize an arrow with an expression body (`(p) => <jsx>`), turning it into a block. */
function memoizeExprBody(e: EmitCtx, fn: Node, edits: Edit[]): boolean {
  const arrowBody = unwrapParens(fn.body);
  if (!isJsx(arrowBody)) return false;
  const newText = emitNode(e, arrowBody);
  if (e.slots.count === 0) return false;
  edits.push({
    start: startOf(e.ctx, fn.body),
    end: endOf(e.ctx, fn.body),
    text: `{ const _dnxC = _dnxUseMemoCache(${e.slots.count}); return ${newText}; }`,
  });
  return true;
}

/** Memoize one component's returned JSX; false when it has none to memoize. */
function memoizeComponent(ctx: Ctx, fn: Node, moduleNames: Set<string>, edits: Edit[]): boolean {
  const e: EmitCtx = { ctx, bindings: functionBindings(ctx, fn), slots: { count: 0 }, moduleNames };
  return fn.body?.type === "BlockStatement"
    ? memoizeBlockBody(e, fn, edits)
    : memoizeExprBody(e, fn, edits);
}

/**
 * A dynamic `import("./rel")` specifier needs the same absolutizing as a static one (its
 * argument is a call arg, not a top-level `.source`, so walk for it). This is why the
 * transform no longer bails a module just for using `import(…)`.
 */
function absolutizeDynamicImports(ctx: Ctx, body: Node[], moduleUrl: string, edits: Edit[]): void {
  for (const item of body) {
    walkAst(item, (n) => {
      if (n.type !== "CallExpression" || n.callee?.type !== "Import") return;
      const arg = n.arguments?.[0]?.expression;
      if (arg?.type !== "StringLiteral" || !isRelativeSpecifier(arg.value as string)) return;
      edits.push({
        start: startOf(ctx, arg),
        end: endOf(ctx, arg),
        text: JSON.stringify(new URL(arg.value as string, moduleUrl).href),
      });
    });
  }
}

/**
 * Transform one module's source, memoizing component elements. Returns the new
 * code and whether anything changed (unchanged ⇒ the caller keeps the original).
 *
 * @param source The module source.
 * @param moduleUrl The module's absolute URL (for rewriting relative imports).
 */
export async function transformModule(
  source: string,
  moduleUrl: string,
): Promise<{ code: string; changed: boolean }> {
  const identity = { code: source, changed: false };
  const parsed = await parseModule(source);
  if (!parsed) return identity; // unparseable/empty → identity
  const { ctx, body } = parsed;
  const moduleNames = collectModuleNames(body);
  const edits: Edit[] = [];
  let memoized = false;
  for (const item of body) {
    const fn = componentFunction(item);
    if (fn && memoizeComponent(ctx, fn, moduleNames, edits)) memoized = true;
  }
  if (!memoized) return identity;
  // The transformed module lives in a temp dir, so relative specifiers must be absolute.
  absolutizeSpecifiers(ctx, body, moduleUrl, edits);
  absolutizeDynamicImports(ctx, body, moduleUrl, edits);
  // Inject the runtime import after any leading directive prologue.
  const importAt = prologueEnd(ctx, body);
  edits.push({
    start: importAt,
    end: importAt,
    text: `\nimport { c as _dnxUseMemoCache, memoValue as _dnxMemo } from ${
      JSON.stringify(runtimeUrl())
    };`,
  });
  return { code: applyEdits(ctx.bytes, edits), changed: true };
}

/**
 * Discover the `.tsx`/`.jsx` source files in a project that the compiler should
 * consider (JSX-bearing modules). Non-component modules among these are cheaply
 * skipped by {@linkcode compileModules} (they don't change).
 *
 * @param projectDir The project root to scan.
 */
export async function collectComponentSources(projectDir: string): Promise<string[]> {
  const files: string[] = [];
  for await (
    const entry of walk(projectDir, {
      exts: [".tsx", ".jsx"],
      includeDirs: false,
      skip: [/[/\\]\.denext[/\\]/, /[/\\]node_modules[/\\]/, /[/\\]\.git[/\\]/],
    })
  ) {
    files.push(entry.path);
  }
  return files.sort();
}

/**
 * Transform each source file for the auto-memo compiler, writing changed modules
 * into `<outDir>/compiled/` and returning an import-map of
 * `original file URL → transformed file URL` (to merge into the client bundle's
 * redirects). Modules that don't change are omitted (the original is used).
 *
 * @param files Absolute paths of candidate source modules.
 * @param opts.outDir The build output directory.
 */
export async function compileModules(
  files: string[],
  opts: { outDir: string },
): Promise<Record<string, string>> {
  return await writeTransformedModules(files, join(opts.outDir, "compiled"), transformModule);
}
