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

import { ensureDir, walk } from "@std/fs";
import { join, toFileUrl } from "@std/path";
import { frameworkFileUrl } from "./bundle.ts";
import {
  applyEdits,
  collectPatternNames,
  type Ctx,
  type Edit,
  encoder,
  endOf,
  MARKER,
  MARKER_LEN,
  type Node,
  startOf,
  swcParse,
  txt,
  walkAst,
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
  switch (node.type) {
    case "Identifier":
      into.add(node.value);
      return;
    case "MemberExpression":
      collectFreeRefs(node.object, into);
      // Non-computed `.prop` is not a reference; a computed `a[expr]` is.
      if (node.computed || node.property?.type === "Computed") collectFreeRefs(node.property, into);
      return;
    case "KeyValueProperty":
      if (node.computed || node.key?.type === "Computed") collectFreeRefs(node.key, into);
      collectFreeRefs(node.value, into);
      return;
    case "JSXElement":
      collectFreeRefs(node.opening, into);
      for (const c of node.children ?? []) collectFreeRefs(c, into);
      return; // closing tag name is redundant with the opening
    case "JSXFragment":
      for (const c of node.children ?? []) collectFreeRefs(c, into);
      return;
    case "JSXOpeningElement":
      if (isCapitalizedName(node.name)) into.add(node.name.value);
      for (const a of node.attributes ?? []) collectFreeRefs(a, into);
      return;
    case "JSXAttribute":
      collectFreeRefs(node.value, into); // the attribute name is not a reference
      return;
    case "JSXClosingElement":
      return;
    default:
      for (const k of Object.keys(node)) {
        if (k === "type" || k === "span" || k === "ctxt") continue;
        const v = node[k];
        if (Array.isArray(v)) { for (const c of v) collectFreeRefs(c, into); }
        else if (v && typeof v === "object") collectFreeRefs(v, into);
      }
  }
}

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

/** Collect a module's top-level binding names (imports + top-level declarations). */
function collectModuleNames(body: Node[]): Set<string> {
  const names = new Set<string>();
  for (const item of body) {
    if (item.type === "ImportDeclaration") {
      for (const s of item.specifiers ?? []) if (s.local?.value) names.add(s.local.value);
      continue;
    }
    const decl = item.type === "ExportDeclaration"
      ? item.declaration
      : item.type === "ExportDefaultDeclaration"
      ? item.decl
      : item;
    if (!decl) continue;
    if (decl.type === "VariableDeclaration") {
      for (const d of decl.declarations ?? []) collectPatternNames(d.id, names);
    } else if (
      (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") && decl.identifier
    ) {
      names.add(decl.identifier.value);
    }
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

/** Extract the underlying function node from a component declaration, or null. */
function componentFunction(item: Node): Node | null {
  let decl = item;
  if (item.type === "ExportDeclaration") decl = item.declaration;
  else if (item.type === "ExportDefaultDeclaration") decl = item.decl;

  if (decl.type === "FunctionDeclaration" || decl.type === "FunctionExpression") {
    // A default-exported anonymous function is a component candidate too.
    const name = decl.identifier?.value;
    if (name && !/^[A-Z]/.test(name)) return null;
    return decl;
  }
  if (decl.type === "VariableDeclaration") {
    // `const Name = (…) => …` / `= function(){}`
    if (decl.declarations.length !== 1) return null;
    const d = decl.declarations[0];
    if (d.id?.type !== "Identifier" || !/^[A-Z]/.test(d.id.value)) return null;
    if (d.init?.type === "ArrowFunctionExpression" || d.init?.type === "FunctionExpression") {
      return d.init;
    }
  }
  return null;
}

/** Gather a function's parameter + top-level local bindings. */
function functionBindings(ctx: Ctx, fn: Node): Bindings {
  const bindings: Bindings = new Map();
  for (const p of fn.params ?? []) {
    const pat = p.type === "Parameter" ? p.pat : p;
    const names = new Set<string>();
    collectPatternNames(pat, names);
    for (const n of names) bindings.set(n, -1);
  }
  if (fn.body?.type === "BlockStatement") {
    for (const stmt of fn.body.stmts ?? fn.body.body ?? []) {
      if (stmt.type === "VariableDeclaration") {
        for (const d of stmt.declarations) {
          const names = new Set<string>();
          collectPatternNames(d.id, names);
          const end = stmt.span.end - ctx.base;
          for (const n of names) if (!bindings.has(n)) bindings.set(n, end);
        }
      } else if (stmt.type === "FunctionDeclaration" && stmt.identifier) {
        bindings.set(stmt.identifier.value, stmt.span.end - ctx.base);
      }
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
  const parse = await swcParse();
  // swc reports UTF-8 byte offsets against a per-parse base, but `Module.span`
  // skips leading comments — so it is not a reliable base. Prepend a marker token
  // (`MARKER`) so the first AST node sits at byte 0 of the parsed text, giving an
  // exact base regardless of leading trivia. All offsets are then mapped back to
  // the original source (subtracting the marker length).
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
  const moduleNames = collectModuleNames(body);
  const edits: Edit[] = [];
  let memoized = false;

  for (const item of body) {
    const fn = componentFunction(item);
    if (!fn) continue;
    const bindings = functionBindings(ctx, fn);
    const slots: Slots = { count: 0 };
    const e: EmitCtx = { ctx, bindings, slots, moduleNames };

    if (fn.body?.type === "BlockStatement") {
      for (const ret of ownReturns(fn)) {
        if (!ret.argument) continue;
        const arg = unwrapParens(ret.argument);
        if (!isJsx(arg)) continue;
        const newText = emitNode(e, arg);
        edits.push({
          start: startOf(ctx, ret.argument),
          end: ret.argument.span.end - ctx.base,
          text: newText,
        });
      }
      if (slots.count > 0) {
        const insertAt = (fn.body.span.start - ctx.base) + 1; // just after `{`
        edits.push({
          start: insertAt,
          end: insertAt,
          text: `\n  const _dnxC = _dnxUseMemoCache(${slots.count});`,
        });
        memoized = true;
      }
    } else {
      // Arrow with an expression body: `(p) => <jsx>`.
      const arrowBody = unwrapParens(fn.body);
      if (!isJsx(arrowBody)) continue;
      const newText = emitNode(e, arrowBody);
      if (slots.count > 0) {
        edits.push({
          start: startOf(ctx, fn.body),
          end: fn.body.span.end - ctx.base,
          text: `{ const _dnxC = _dnxUseMemoCache(${slots.count}); return ${newText}; }`,
        });
        memoized = true;
      }
    }
  }

  if (!memoized) return { code: source, changed: false };

  // Rewrite relative import/export specifiers to absolute URLs (the transformed
  // module lives in a temp dir, so relative paths would otherwise break).
  for (const item of body) {
    const src = item.source;
    if (src?.type !== "StringLiteral") continue;
    const spec = src.value as string;
    if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
    const abs = new URL(spec, moduleUrl).href;
    edits.push({
      start: startOf(ctx, src),
      end: src.span.end - ctx.base,
      text: JSON.stringify(abs),
    });
  }

  // A dynamic `import("./rel")` specifier needs the same absolutizing as a static
  // one (its argument is a call arg, not a top-level `.source`, so walk for it).
  // This is why the transform no longer bails a module just for using `import(…)`.
  for (const item of body) {
    walkAst(item, (n) => {
      if (n.type !== "CallExpression" || n.callee?.type !== "Import") return;
      const arg = n.arguments?.[0]?.expression;
      if (arg?.type !== "StringLiteral") return;
      const spec = arg.value as string;
      if (!spec.startsWith("./") && !spec.startsWith("../")) return;
      edits.push({
        start: startOf(ctx, arg),
        end: endOf(ctx, arg),
        text: JSON.stringify(new URL(spec, moduleUrl).href),
      });
    });
  }

  // Inject the runtime import after any leading directive prologue.
  let importAt = 0;
  for (const item of body) {
    if (
      item.type === "ExpressionStatement" &&
      item.expression?.type === "StringLiteral"
    ) {
      importAt = item.span.end - ctx.base;
    } else break;
  }
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

/** Deterministic short filename for a module URL. */
function moduleFileName(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) >>> 0;
  return `m_${h.toString(36)}.tsx`;
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
  const dir = join(opts.outDir, "compiled");
  await ensureDir(dir);
  const map: Record<string, string> = {};
  for (const file of files) {
    let source: string;
    try {
      source = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    const url = toFileUrl(file).href;
    let result: { code: string; changed: boolean };
    try {
      result = await transformModule(source, url);
    } catch {
      continue; // any failure → leave the original module untouched
    }
    if (!result.changed) continue;
    const out = join(dir, moduleFileName(url));
    await Deno.writeTextFile(out, result.code);
    map[url] = toFileUrl(out).href;
  }
  return map;
}
