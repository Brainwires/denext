// Build-time transform that auto-wraps event handlers as `qrl()` in resumable
// routes — the "stage 4" transform `src/runtime/qrl.ts` anticipates.
//
// In a module that opts into resumability (`export const resumable = true`), an
// inline event handler is extracted into its own code-split SEGMENT module and the
// usage site is rewritten to a `qrl(() => import("<segment>"), "<id>", [captures])`
// reference. The handler's code then leaves the initial bundle and loads on first
// use; its captured component-local values (signals/stores/props) are passed
// positionally and read back inside the segment via `capturedScope()`.
//
//   // counter.tsx  ("use client"; export const resumable = true)
//   const count = useSignal(0);
//   <button onClick={() => count.value++}>+</button>
//     ⇒  <button onClick={qrl(() => import("<seg>"), "<mod>#onClick0", [count])}>+</button>
//
//   // <seg>  (generated)
//   import { capturedScope } from "<qrl runtime>";
//   export default function (event) {
//     const [count] = capturedScope();
//     return (() => count.value++)(event);
//   }
//
// Correctness over coverage: a handler is only extracted when the extraction is
// provably sound. Anything else (a reference to a module-scope non-import binding,
// JSX inside the handler, `this`/`arguments`/`super`, an unparseable module) is
// left exactly as written — it keeps working on the existing resume-by-hydrate
// path. The transform never emits a segment it can't resolve.

import { join, toFileUrl } from "@std/path";
import { ensureDir } from "@std/fs";
import { frameworkFileUrl } from "./bundle.ts";
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
  txt,
  walkAst,
} from "./swc-ast.ts";

/** The absolute URL a generated segment imports `capturedScope` from. */
function runtimeUrl(): string {
  return frameworkFileUrl("src/runtime/qrl.ts");
}

/** A short, stable module id (djb2 → base36), the handler-id prefix. */
function moduleId(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** A generated handler segment: a filename stem and its module source. */
export interface QrlSegment {
  /** A stable, module-unique stem (no extension) — the caller writes `<stem>.tsx`. */
  name: string;
  /** The segment module source. */
  code: string;
}

/** The result of transforming one module. */
export interface QrlTransformResult {
  /** The rewritten module source (unchanged when `changed` is false). */
  code: string;
  /** Whether any handler was extracted. */
  changed: boolean;
  /** The segment modules to emit (empty when nothing changed). */
  segments: QrlSegment[];
}

const FN_TYPES = new Set(["FunctionExpression", "ArrowFunctionExpression"]);

/** True if `n` is a function expression or arrow (not a declaration). */
function isFnExpr(n: Node): boolean {
  return !!n && FN_TYPES.has(n.type);
}

/** The statement list of a block body, tolerant of swc field naming. */
function blockStmts(body: Node): Node[] {
  if (!body || body.type !== "BlockStatement") return [];
  return body.stmts ?? body.body ?? [];
}

/** True if the module opts into resumability (`export const resumable = true`). */
function moduleIsResumable(body: Node[]): boolean {
  for (const item of body) {
    const decl = item.type === "ExportDeclaration" ? item.declaration : null;
    if (decl?.type !== "VariableDeclaration") continue;
    for (const d of decl.declarations ?? []) {
      if (d.id?.type === "Identifier" && d.id.value === "resumable") {
        const init = d.init;
        if (init?.type === "BooleanLiteral" && init.value === true) return true;
      }
    }
  }
  return false;
}

/** Collect the binding names a function introduces: its params plus body locals. */
function functionBindings(fn: Node): Set<string> {
  const out = new Set<string>();
  for (const p of fn.params ?? []) collectPattern(p.pat ?? p, out);
  // `body` may be a BlockStatement (function/arrow block) or an expression (arrow).
  if (fn.body?.type === "BlockStatement") collectBlockDecls(fn.body, out);
  return out;
}

/** Add the names bound by a binding pattern (identifier / object / array / rest). */
function collectPattern(pat: Node, out: Set<string>): void {
  if (!pat || typeof pat !== "object") return;
  switch (pat.type) {
    case "Identifier":
      out.add(pat.value);
      return;
    case "ObjectPattern":
      for (const p of pat.properties ?? []) {
        if (p.type === "AssignmentPatternProperty") out.add(p.key.value);
        else if (p.type === "KeyValuePatternProperty") collectPattern(p.value, out);
        else if (p.type === "RestElement") collectPattern(p.argument, out);
      }
      return;
    case "ArrayPattern":
      for (const el of pat.elements ?? []) if (el) collectPattern(el, out);
      return;
    case "AssignmentPattern":
      collectPattern(pat.left, out);
      return;
    case "RestElement":
      collectPattern(pat.argument, out);
      return;
  }
}

/**
 * Collect names declared directly in a function body — `var`/`let`/`const`,
 * function and class declarations — WITHOUT descending into nested functions
 * (whose declarations belong to their own scope). `var` hoists across blocks, so
 * we recurse through non-function statements to catch block-nested `var`/decls.
 */
function collectBlockDecls(block: Node, out: Set<string>): void {
  for (const stmt of blockStmts(block)) collectStmtDecls(stmt, out);
}

function collectStmtDecls(stmt: Node, out: Set<string>): void {
  if (!stmt || typeof stmt !== "object") return;
  switch (stmt.type) {
    case "VariableDeclaration":
      for (const d of stmt.declarations ?? []) collectPattern(d.id, out);
      return;
    case "FunctionDeclaration":
    case "ClassDeclaration":
      if (stmt.identifier?.value) out.add(stmt.identifier.value);
      return;
    case "BlockStatement":
      collectBlockDecls(stmt, out);
      return;
    case "IfStatement":
      collectStmtDecls(stmt.consequent, out);
      if (stmt.alternate) collectStmtDecls(stmt.alternate, out);
      return;
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
      if (stmt.init?.type === "VariableDeclaration") {
        for (const d of stmt.init.declarations ?? []) collectPattern(d.id, out);
      }
      if (stmt.left?.type === "VariableDeclaration") {
        for (const d of stmt.left.declarations ?? []) collectPattern(d.id, out);
      }
      collectStmtDecls(stmt.body, out);
      return;
    case "WhileStatement":
    case "DoWhileStatement":
    case "LabeledStatement":
      collectStmtDecls(stmt.body, out);
      return;
    case "TryStatement":
      if (stmt.block) collectBlockDecls(stmt.block, out);
      if (stmt.handler?.body) collectBlockDecls(stmt.handler.body, out);
      if (stmt.finalizer) collectBlockDecls(stmt.finalizer, out);
      return;
  }
}

/**
 * The free variables of an expression subtree, in first-appearance order —
 * referenced identifiers minus those bound within the subtree (params, locals,
 * nested-function scopes). Skips non-reference positions: a non-computed member
 * `.property`, non-computed object keys, and JSX element/attribute names.
 */
function freeVars(node: Node): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    if (!seen.has(name)) {
      seen.add(name);
      order.push(name);
    }
  };
  walkFree(node, new Set<string>(), add);
  return order;
}

function walkFree(node: Node, bound: Set<string>, add: (n: string) => void): void {
  if (!node || typeof node !== "object") return;

  switch (node.type) {
    case "Identifier":
      if (!bound.has(node.value)) add(node.value);
      return;
    case "MemberExpression": {
      walkFree(node.object, bound, add);
      // Only a computed member (`a[b]`) evaluates its property as a reference.
      if (node.property?.type === "Computed") walkFree(node.property, bound, add);
      return;
    }
    case "KeyValueProperty":
      // Object-literal `{ key: value }` — `key` is not a reference (unless computed).
      if (node.key?.type === "Computed") walkFree(node.key, bound, add);
      walkFree(node.value, bound, add);
      return;
    case "FunctionExpression":
    case "ArrowFunctionExpression":
    case "FunctionDeclaration": {
      // A nested function extends the bound set with its own params + locals.
      const inner = new Set(bound);
      for (const n of functionBindings(node)) inner.add(n);
      if (node.identifier?.value) inner.add(node.identifier.value);
      for (const key of Object.keys(node)) {
        if (key === "span" || key === "identifier" || key === "params") continue;
        walkChildFree(node[key], inner, add);
      }
      for (const p of node.params ?? []) {
        // Default-value expressions in params are evaluated in the outer-ish scope,
        // but treating them as inner-bound is safe for capture analysis.
        walkChildFree(p, inner, add);
      }
      return;
    }
    case "JSXOpeningElement":
    case "JSXClosingElement":
      // Element name is not a value reference; attributes/children still are.
      for (const attr of node.attributes ?? []) walkFree(attr, bound, add);
      return;
    case "JSXAttribute":
      // Attribute name is not a reference; its value is.
      if (node.value) walkFree(node.value, bound, add);
      return;
  }

  for (const key of Object.keys(node)) {
    if (key === "span") continue;
    walkChildFree(node[key], bound, add);
  }
}

function walkChildFree(v: Node, bound: Set<string>, add: (n: string) => void): void {
  if (Array.isArray(v)) {
    for (const c of v) walkFree(c, bound, add);
  } else if (v && typeof v === "object") {
    walkFree(v, bound, add);
  }
}

/** True if the subtree contains JSX, `this`/`super`, or an `arguments` reference. */
function hasUnsafeConstruct(node: Node): boolean {
  let bad = false;
  walkAst(node, (n) => {
    if (
      n.type === "JSXElement" || n.type === "JSXFragment" ||
      n.type === "ThisExpression" || n.type === "Super" ||
      (n.type === "Identifier" && n.value === "arguments")
    ) bad = true;
  });
  return bad;
}

/** An `on*` DOM/React event-handler attribute name (`onClick`, `onInput`, …). */
function isHandlerAttrName(name: string): boolean {
  return /^on[A-Z]/.test(name);
}

/** Reconstruct a minimal single-binding import for a name (specifier resolved absolute). */
interface ImportBinding {
  /** `default` | `namespace` | the imported (external) name for a named import. */
  kind: "default" | "namespace" | string;
  /** The import's source specifier, already resolved to absolute. */
  source: string;
}

/** Map every top-level import binding name → how to re-import it into a segment. */
function collectImports(body: Node[], moduleUrl: string): Map<string, ImportBinding> {
  const map = new Map<string, ImportBinding>();
  for (const item of body) {
    if (item.type !== "ImportDeclaration") continue;
    const raw = item.source?.value as string | undefined;
    if (!raw) continue;
    const source = raw.startsWith("./") || raw.startsWith("../")
      ? new URL(raw, moduleUrl).href
      : raw;
    for (const spec of item.specifiers ?? []) {
      const local = spec.local?.value as string | undefined;
      if (!local) continue;
      if (spec.type === "ImportDefaultSpecifier") map.set(local, { kind: "default", source });
      else if (spec.type === "ImportNamespaceSpecifier") {
        map.set(local, { kind: "namespace", source });
      } else {
        // ImportSpecifier: `import { imported as local }` (imported defaults to local).
        const imported = (spec.imported?.value as string | undefined) ?? local;
        map.set(local, { kind: imported, source });
      }
    }
  }
  return map;
}

/** Emit the import line that re-binds `local` inside a segment. */
function importLine(local: string, b: ImportBinding): string {
  const from = ` from ${JSON.stringify(b.source)};`;
  if (b.kind === "default") return `import ${local}${from}`;
  if (b.kind === "namespace") return `import * as ${local}${from}`;
  if (b.kind === local) return `import { ${local} }${from}`;
  return `import { ${b.kind} as ${local} }${from}`;
}

/**
 * Transform one module's source, auto-wrapping its inline event handlers as `qrl`
 * segment references when the module is resumable. Returns the rewritten code, a
 * changed flag, and the segment modules to emit.
 *
 * @param source The module source.
 * @param moduleUrl The module's absolute URL (id prefix + relative-specifier base).
 * @param opts.segmentSpecifier Maps a segment stem to the specifier the rewritten
 *   module imports it by. Defaults to `"./<stem>.tsx"` (co-located). The build wires
 *   this to the segment's written location.
 * @param opts.force Transform even without the `resumable` opt-in (tests only).
 */
export async function transformQrl(
  source: string,
  moduleUrl: string,
  opts: { segmentSpecifier?: (stem: string) => string; force?: boolean } = {},
): Promise<QrlTransformResult> {
  const identity: QrlTransformResult = { code: source, changed: false, segments: [] };
  const segmentSpecifier = opts.segmentSpecifier ?? ((stem) => `./${stem}.tsx`);

  // Cheap pre-filter: an `on`-handler and the `resumable` opt-in must both appear.
  if (!opts.force && !(source.includes("resumable") && /on[A-Z]/.test(source))) return identity;

  const parse = await swcParse();
  let ast: Node;
  try {
    ast = await parse(MARKER + source);
  } catch {
    return identity; // unparseable → identity
  }
  if (!ast.body || ast.body.length === 0) return identity;

  const base = ast.body[0].span.start;
  const ctx: Ctx = { bytes: encoder.encode(source), base: base + MARKER_LEN };
  const body: Node[] = ast.body.slice(1);

  if (!opts.force && !moduleIsResumable(body)) return identity;

  const modId = moduleId(moduleUrl);
  const imports = collectImports(body, moduleUrl);
  const moduleNames = new Set<string>(imports.keys());
  for (const item of body) collectTopLevelDecls(item, moduleNames);

  const edits: Edit[] = [];
  const segments: QrlSegment[] = [];
  let counter = 0;
  let needsQrlImport = false;

  // Top-down walk tracking the union of enclosing component-function bindings, so a
  // handler's free var can be classified capture (component-local) vs module vs global.
  const visit = (node: Node, compScope: Set<string>): void => {
    if (!node || typeof node !== "object") return;

    if (node.type === "JSXAttribute") {
      const attrName = node.name?.value as string | undefined;
      const expr = node.value?.type === "JSXExpressionContainer" ? node.value.expression : null;
      if (attrName && isHandlerAttrName(attrName) && expr) {
        if (tryExtract(node, attrName, expr, compScope)) return; // don't descend extracted
      }
    }

    const isFn = node.type === "FunctionDeclaration" || isFnExpr(node);
    const nextScope = isFn ? new Set(compScope) : compScope;
    if (isFn) {
      for (const n of functionBindings(node)) nextScope.add(n);
      if (node.identifier?.value) nextScope.add(node.identifier.value);
    }
    for (const key of Object.keys(node)) {
      if (key === "span") continue;
      const v = node[key];
      if (Array.isArray(v)) { for (const c of v) visit(c, nextScope); }
      else if (v && typeof v === "object") visit(v, nextScope);
    }
  };

  const tryExtract = (
    _attr: Node,
    attrName: string,
    expr: Node,
    compScope: Set<string>,
  ): boolean => {
    // Only inline function handlers, or a bare reference to an imported handler.
    const isInlineFn = isFnExpr(expr);
    const isBareImportRef = expr.type === "Identifier" && imports.has(expr.value);
    if (!isInlineFn && !isBareImportRef) return false;
    if (isInlineFn && hasUnsafeConstruct(expr)) return false;

    const id = `${modId}#${attrName}${counter}`;
    const stem = `qseg_${modId}_${attrName}${counter}`;
    counter++;

    if (isBareImportRef) {
      // `onClick={imported}` → segment re-exports the imported handler; no capture.
      const b = imports.get(expr.value)!;
      const line = b.kind === "default"
        ? `export { default } from ${JSON.stringify(b.source)};`
        : b.kind === expr.value
        ? `export { ${expr.value} as default } from ${JSON.stringify(b.source)};`
        : `export { ${b.kind} as default } from ${JSON.stringify(b.source)};`;
      segments.push({ name: stem, code: line + "\n" });
      replaceWithQrl(expr, id, stem, []);
      return true;
    }

    // Inline function: classify free vars.
    const frees = freeVars(expr);
    const captures: string[] = [];
    const neededImports: string[] = [];
    for (const name of frees) {
      if (compScope.has(name)) captures.push(name);
      else if (imports.has(name)) neededImports.push(name);
      else if (moduleNames.has(name)) return false; // module-scope non-import → bail
      // else: a global (window, document, fetch, …) — available in the segment.
    }

    const importLines = neededImports.map((n) => importLine(n, imports.get(n)!));
    const capBind = captures.length ? `  const [${captures.join(", ")}] = capturedScope();\n` : "";
    const handlerSrc = txt(ctx, expr);
    const seg = [
      `import { capturedScope } from ${JSON.stringify(runtimeUrl())};`,
      ...importLines,
      ``,
      `export default function (event) {`,
      capBind + `  return (${handlerSrc})(event);`,
      `}`,
      ``,
    ].join("\n");
    segments.push({ name: stem, code: seg });
    replaceWithQrl(expr, id, stem, captures);
    return true;
  };

  const replaceWithQrl = (expr: Node, id: string, stem: string, captures: string[]): void => {
    const spec = segmentSpecifier(stem);
    const cap = captures.length ? `, [${captures.join(", ")}]` : "";
    edits.push({
      start: startOf(ctx, expr),
      end: endOf(ctx, expr),
      text: `qrl(() => import(${JSON.stringify(spec)}), ${JSON.stringify(id)}${cap})`,
    });
    needsQrlImport = true;
  };

  for (const item of body) visit(item, new Set<string>());

  if (edits.length === 0) return identity;

  // Inject the `qrl` runtime import after any leading directive prologue.
  let importAt = 0;
  for (const item of body) {
    if (item.type === "ExpressionStatement" && item.expression?.type === "StringLiteral") {
      importAt = endOf(ctx, item);
    } else break;
  }
  if (needsQrlImport) {
    edits.push({
      start: importAt,
      end: importAt,
      order: -1,
      text: `\nimport { qrl } from ${JSON.stringify(runtimeUrl())};\n`,
    });
  }

  return { code: applyEdits(ctx.bytes, edits), changed: true, segments };
}

/** Deterministic short filename for a transformed module URL. */
function moduleFileName(url: string): string {
  return `m_${moduleId(url)}.tsx`;
}

/**
 * Transform each resumable source file's handlers into `qrl` segment references,
 * writing the rewritten module and its segments into `<outDir>/qrl/` and returning
 * an import-map of `original file URL → transformed file URL` to merge into the
 * client bundle's redirects. Server rendering keeps the originals (the segment
 * `qrl(...)` runs at hydration), so SSR/hydration stay aligned. Modules that don't
 * change (non-resumable, or no extractable handler) are omitted.
 *
 * A segment is written beside its transformed module, so the module's
 * `import("./<stem>.tsx")` resolves within the same output directory.
 *
 * @param files Absolute paths of candidate source modules.
 * @param opts.outDir The build output directory.
 */
export async function compileQrlModules(
  files: string[],
  opts: { outDir: string },
): Promise<Record<string, string>> {
  const dir = join(opts.outDir, "qrl");
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
    let result: QrlTransformResult;
    try {
      result = await transformQrl(source, url);
    } catch {
      continue; // any failure → leave the original module untouched
    }
    if (!result.changed) continue;
    for (const seg of result.segments) {
      await Deno.writeTextFile(join(dir, `${seg.name}.tsx`), seg.code);
    }
    const out = join(dir, moduleFileName(url));
    await Deno.writeTextFile(out, result.code);
    map[url] = toFileUrl(out).href;
  }
  return map;
}

/** Add the names a top-level statement binds (imports handled separately). */
function collectTopLevelDecls(item: Node, out: Set<string>): void {
  const decl = item.type === "ExportDeclaration" ? item.declaration : item;
  if (!decl) return;
  if (decl.type === "VariableDeclaration") {
    for (const d of decl.declarations ?? []) collectPattern(d.id, out);
  } else if (
    (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") &&
    decl.identifier?.value
  ) {
    out.add(decl.identifier.value);
  }
}
