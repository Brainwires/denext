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
import { frameworkRoot } from "./bundle.ts";

// deno-lint-ignore no-explicit-any
type Node = any;

let swcReady: Promise<(src: string) => Promise<Node>> | null = null;

/** Initialize @swc/wasm-web once and return a bound `parse` (TSX). */
function swcParse(): Promise<(src: string) => Promise<Node>> {
  if (!swcReady) {
    swcReady = (async () => {
      const mod = await import("@swc/wasm-web");
      await mod.default(); // initialize the wasm module
      return (src: string) =>
        mod.parse(src, { syntax: "typescript", tsx: true, target: "es2022" }) as Promise<Node>;
    })();
  }
  return swcReady;
}

/** The absolute URL generated modules import the memo runtime from. */
function runtimeUrl(): string {
  return toFileUrl(join(frameworkRoot(), "src/runtime/compiler-runtime.ts")).href;
}

/** A source edit: replace `[start, end)` with `text` (insert when start === end). */
interface Edit {
  start: number;
  end: number;
  text: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Apply non-overlapping edits whose offsets are UTF-8 *byte* positions (swc spans
 * are byte offsets, which differ from JS string indices whenever the source has
 * multi-byte characters). Splicing happens in byte space, then decodes back.
 */
function applyEdits(bytes: Uint8Array, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const parts: Uint8Array[] = [];
  let pos = 0;
  for (const e of sorted) {
    if (e.start > pos) parts.push(bytes.subarray(pos, e.start));
    parts.push(encoder.encode(e.text));
    pos = e.end;
  }
  if (pos < bytes.length) parts.push(bytes.subarray(pos));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return decoder.decode(out);
}

/** Collect bound names from a binding pattern into `out` (name → true). */
function collectPatternNames(pat: Node, out: Set<string>): void {
  if (!pat || typeof pat !== "object") return;
  switch (pat.type) {
    case "Identifier":
      out.add(pat.value);
      return;
    case "ObjectPattern":
      for (const p of pat.properties) {
        if (p.type === "AssignmentPatternProperty") out.add(p.key.value);
        else if (p.type === "KeyValuePatternProperty") collectPatternNames(p.value, out);
        else if (p.type === "RestElement") collectPatternNames(p.argument, out);
      }
      return;
    case "ArrayPattern":
      for (const el of pat.elements) if (el) collectPatternNames(el, out);
      return;
    case "AssignmentPattern":
      collectPatternNames(pat.left, out);
      return;
    case "RestElement":
      collectPatternNames(pat.argument, out);
      return;
  }
}

/** Walk a subtree, invoking `visit` on every node (depth-first). */
function walkAst(node: Node, visit: (n: Node) => void): void {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) walkAst(c, visit);
    } else if (v && typeof v === "object") {
      walkAst(v, visit);
    }
  }
}

/** True if the module uses a dynamic `import(...)` (we bail such modules). */
function hasDynamicImport(ast: Node): boolean {
  let found = false;
  walkAst(ast, (n) => {
    if (n.type === "CallExpression" && n.callee?.type === "Import") found = true;
  });
  return found;
}

/**
 * The per-module transform context: source text and the span base offset swc
 * reports (span offsets are relative to it).
 */
interface Ctx {
  bytes: Uint8Array;
  base: number;
}

const txt = (ctx: Ctx, n: Node): string =>
  decoder.decode(ctx.bytes.subarray(n.span.start - ctx.base, n.span.end - ctx.base));
const startOf = (ctx: Ctx, n: Node): number => n.span.start - ctx.base;

/** True if a JSX element's tag is a component (Capitalized identifier). */
function isComponentElement(node: Node): boolean {
  const name = node.opening?.name;
  return name?.type === "Identifier" && /^[A-Z]/.test(name.value);
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

/**
 * Emit a JSX node as an expression string, memoizing component elements. `child`
 * marks JSX-child position (a component there is wrapped in `{…}`).
 */
function emitNode(ctx: Ctx, node: Node, bindings: Bindings, slots: Slots): string {
  if (node.type === "JSXElement" && isComponentElement(node)) {
    const deps = depsOf(ctx, node, bindings);
    const slot = slots.count;
    slots.count += 1 + deps.length;
    const inner = rebuildElement(ctx, node, bindings, slots);
    return `_dnxMemo(_dnxC, ${slot}, () => (${inner}), [${deps.join(", ")}])`;
  }
  // Host element or fragment: keep as JSX, but rebuild children so nested
  // components still get memoized.
  return rebuildElement(ctx, node, bindings, slots);
}

/** Rebuild a JSX element/fragment's source with its children transformed. */
function rebuildElement(ctx: Ctx, node: Node, bindings: Bindings, slots: Slots): string {
  if (node.type === "JSXElement") {
    const opening = txt(ctx, node.opening);
    if (node.opening.selfClosing) return opening;
    const kids = node.children.map((c: Node) => emitChild(ctx, c, bindings, slots)).join("");
    const closing = node.closing ? txt(ctx, node.closing) : "";
    return opening + kids + closing;
  }
  // JSXFragment
  return txt(ctx, node.opening) +
    node.children.map((c: Node) => emitChild(ctx, c, bindings, slots)).join("") +
    txt(ctx, node.closing);
}

/** Emit a JSX child (child position: components become `{memoValue(...)}`). */
function emitChild(ctx: Ctx, child: Node, bindings: Bindings, slots: Slots): string {
  if (child.type === "JSXElement") {
    if (isComponentElement(child)) return `{${emitNode(ctx, child, bindings, slots)}}`;
    return rebuildElement(ctx, child, bindings, slots); // host: recurse
  }
  if (child.type === "JSXFragment") return rebuildElement(ctx, child, bindings, slots);
  // JSXText / JSXExpressionContainer / JSXSpreadChild: keep verbatim (we do not
  // reach into `{…}` expressions — conservative).
  return txt(ctx, child);
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
  // (`0;\n`) so the first AST node sits at byte 0 of the parsed text, giving an
  // exact base regardless of leading trivia. All offsets are then mapped back to
  // the original source (subtracting the marker length).
  const MARKER = "0;\n";
  const MARKER_LEN = MARKER.length; // ASCII: bytes === chars
  let ast: Node;
  try {
    ast = await parse(MARKER + source);
  } catch {
    return { code: source, changed: false }; // unparseable → identity
  }
  if (!ast.body || ast.body.length === 0) return { code: source, changed: false };
  if (hasDynamicImport(ast)) return { code: source, changed: false };

  const base = ast.body[0].span.start; // the marker sits at parsed byte 0
  const ctx: Ctx = { bytes: encoder.encode(source), base: base + MARKER_LEN };
  const body: Node[] = ast.body.slice(1); // drop the marker statement
  const edits: Edit[] = [];
  let memoized = false;

  for (const item of body) {
    const fn = componentFunction(item);
    if (!fn) continue;
    const bindings = functionBindings(ctx, fn);
    const slots: Slots = { count: 0 };

    if (fn.body?.type === "BlockStatement") {
      for (const ret of ownReturns(fn)) {
        if (!ret.argument) continue;
        const arg = unwrapParens(ret.argument);
        if (!isJsx(arg)) continue;
        const newText = emitNode(ctx, arg, bindings, slots);
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
      const body = unwrapParens(fn.body);
      if (!isJsx(body)) continue;
      const newText = emitNode(ctx, body, bindings, slots);
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
