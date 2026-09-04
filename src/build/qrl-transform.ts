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

import { join } from "@std/path";
import { frameworkFileUrl } from "./bundle.ts";
import {
  applyEdits,
  type Ctx,
  type Edit,
  endOf,
  forEachChild,
  type Node,
  parseModule,
  prologueEnd,
  startOf,
  txt,
  walkAst,
  writeTransformedModules,
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
    if ((decl.declarations ?? []).some(declaresResumableTrue)) return true;
  }
  return false;
}

/** `resumable = true` as a declarator. */
function declaresResumableTrue(d: Node): boolean {
  return d.id?.type === "Identifier" && d.id.value === "resumable" &&
    d.init?.type === "BooleanLiteral" && d.init.value === true;
}

/** Collect the binding names a function introduces: its params plus body locals. */
function functionBindings(fn: Node): Set<string> {
  const out = new Set<string>();
  for (const p of fn.params ?? []) collectPattern(p.pat ?? p, out);
  // `body` may be a BlockStatement (function/arrow block) or an expression (arrow).
  if (fn.body?.type === "BlockStatement") collectBlockDecls(fn.body, out);
  return out;
}

/** One `{ … }` pattern property: shorthand/default, `key: pattern`, or `...rest`. */
function collectObjectPatternProperty(p: Node, out: Set<string>): void {
  if (p.type === "AssignmentPatternProperty") out.add(p.key.value);
  else if (p.type === "KeyValuePatternProperty") collectPattern(p.value, out);
  else if (p.type === "RestElement") collectPattern(p.argument, out);
}

/** Add the names bound by a binding pattern (identifier / object / array / rest). */
function collectPattern(pat: Node, out: Set<string>): void {
  if (!pat || typeof pat !== "object") return;
  switch (pat.type) {
    case "Identifier":
      out.add(pat.value);
      return;
    case "ObjectPattern":
      for (const p of pat.properties ?? []) collectObjectPatternProperty(p, out);
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
  STMT_DECL_HANDLERS[stmt.type as string]?.(stmt, out);
}

function declaratorNames(decl: Node, out: Set<string>): void {
  for (const d of decl.declarations ?? []) collectPattern(d.id, out);
}

function namedDecl(stmt: Node, out: Set<string>): void {
  if (stmt.identifier?.value) out.add(stmt.identifier.value);
}

function loopDecls(stmt: Node, out: Set<string>): void {
  if (stmt.init?.type === "VariableDeclaration") declaratorNames(stmt.init, out);
  if (stmt.left?.type === "VariableDeclaration") declaratorNames(stmt.left, out);
  collectStmtDecls(stmt.body, out);
}

function bodyDecls(stmt: Node, out: Set<string>): void {
  collectStmtDecls(stmt.body, out);
}

/** Per statement type: where declarations hide (unlisted statements declare nothing). */
const STMT_DECL_HANDLERS: Record<string, (stmt: Node, out: Set<string>) => void> = {
  VariableDeclaration: declaratorNames,
  FunctionDeclaration: namedDecl,
  ClassDeclaration: namedDecl,
  BlockStatement: collectBlockDecls,
  IfStatement: (stmt, out) => {
    collectStmtDecls(stmt.consequent, out);
    if (stmt.alternate) collectStmtDecls(stmt.alternate, out);
  },
  ForStatement: loopDecls,
  ForInStatement: loopDecls,
  ForOfStatement: loopDecls,
  WhileStatement: bodyDecls,
  DoWhileStatement: bodyDecls,
  LabeledStatement: bodyDecls,
  TryStatement: (stmt, out) => {
    if (stmt.block) collectBlockDecls(stmt.block, out);
    if (stmt.handler?.body) collectBlockDecls(stmt.handler.body, out);
    if (stmt.finalizer) collectBlockDecls(stmt.finalizer, out);
  },
};

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

type FreeWalk = (node: Node, bound: Set<string>, add: (n: string) => void) => void;

function walkFree(node: Node, bound: Set<string>, add: (n: string) => void): void {
  if (!node || typeof node !== "object") return;
  const handler = FREE_WALK_HANDLERS[node.type as string];
  if (handler) handler(node, bound, add);
  else forEachChild(node, (c) => walkFree(c, bound, add));
}

const FN_CHILD_SKIP: ReadonlySet<string> = new Set(["span", "identifier", "params"]);

/** A nested function extends the bound set with its own params + locals. */
const walkFunctionFree: FreeWalk = (node, bound, add) => {
  const inner = new Set(bound);
  for (const n of functionBindings(node)) inner.add(n);
  if (node.identifier?.value) inner.add(node.identifier.value);
  forEachChild(node, (c) => walkFree(c, inner, add), FN_CHILD_SKIP);
  // Default-value expressions in params are evaluated in the outer-ish scope, but
  // treating them as inner-bound is safe for capture analysis.
  for (const p of node.params ?? []) walkFree(p, inner, add);
};

/** Element name is not a value reference; attributes still are. */
const walkJsxElementFree: FreeWalk = (node, bound, add) => {
  for (const attr of node.attributes ?? []) walkFree(attr, bound, add);
};

/** Per node type: which positions are references (the default walks every child). */
const FREE_WALK_HANDLERS: Record<string, FreeWalk> = {
  Identifier: (node, bound, add) => {
    if (!bound.has(node.value)) add(node.value);
  },
  MemberExpression: (node, bound, add) => {
    walkFree(node.object, bound, add);
    // Only a computed member (`a[b]`) evaluates its property as a reference.
    if (node.property?.type === "Computed") walkFree(node.property, bound, add);
  },
  KeyValueProperty: (node, bound, add) => {
    // Object-literal `{ key: value }` — `key` is not a reference (unless computed).
    if (node.key?.type === "Computed") walkFree(node.key, bound, add);
    walkFree(node.value, bound, add);
  },
  FunctionExpression: walkFunctionFree,
  ArrowFunctionExpression: walkFunctionFree,
  FunctionDeclaration: walkFunctionFree,
  JSXOpeningElement: walkJsxElementFree,
  JSXClosingElement: walkJsxElementFree,
  JSXAttribute: (node, bound, add) => {
    // Attribute name is not a reference; its value is.
    if (node.value) walkFree(node.value, bound, add);
  },
};

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
      if (local) map.set(local, { kind: importKind(spec, local), source });
    }
  }
  return map;
}

/** How a specifier binds: default, namespace, or the imported (external) name. */
function importKind(spec: Node, local: string): ImportBinding["kind"] {
  if (spec.type === "ImportDefaultSpecifier") return "default";
  if (spec.type === "ImportNamespaceSpecifier") return "namespace";
  // ImportSpecifier: `import { imported as local }` (imported defaults to local).
  return (spec.imported?.value as string | undefined) ?? local;
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
  // Cheap pre-filter: an `on`-handler and the `resumable` opt-in must both appear.
  if (!opts.force && !(source.includes("resumable") && /on[A-Z]/.test(source))) return identity;
  const parsed = await parseModule(source);
  if (!parsed) return identity; // unparseable/empty → identity
  const { ctx, body } = parsed;
  if (!opts.force && !moduleIsResumable(body)) return identity;

  const imports = collectImports(body, moduleUrl);
  const moduleNames = new Set<string>(imports.keys());
  for (const item of body) collectTopLevelDecls(item, moduleNames);
  const st: QrlState = {
    ctx,
    modId: moduleId(moduleUrl),
    imports,
    moduleNames,
    segmentSpecifier: opts.segmentSpecifier ?? ((stem) => `./${stem}.tsx`),
    edits: [],
    segments: [],
    counter: 0,
  };
  for (const item of body) visitQrl(st, item, new Set<string>());
  if (st.edits.length === 0) return identity;
  // Inject the `qrl` runtime import after any leading directive prologue.
  const importAt = prologueEnd(ctx, body);
  st.edits.push({
    start: importAt,
    end: importAt,
    order: -1,
    text: `\nimport { qrl } from ${JSON.stringify(runtimeUrl())};\n`,
  });
  return { code: applyEdits(ctx.bytes, st.edits), changed: true, segments: st.segments };
}

/** The per-module extraction state. */
interface QrlState {
  readonly ctx: Ctx;
  readonly modId: string;
  readonly imports: Map<string, ImportBinding>;
  /** Module-scope names (imports + top-level declarations). */
  readonly moduleNames: Set<string>;
  readonly segmentSpecifier: (stem: string) => string;
  readonly edits: Edit[];
  readonly segments: QrlSegment[];
  counter: number;
}

/**
 * Top-down walk tracking the union of enclosing component-function bindings, so a
 * handler's free var can be classified capture (component-local) vs module vs global.
 */
function visitQrl(st: QrlState, node: Node, compScope: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (node.type === "JSXAttribute") {
    const attrName = node.name?.value as string | undefined;
    const expr = node.value?.type === "JSXExpressionContainer" ? node.value.expression : null;
    if (
      attrName && isHandlerAttrName(attrName) && expr && tryExtract(st, attrName, expr, compScope)
    ) {
      return; // don't descend into an extracted handler
    }
  }
  const isFn = node.type === "FunctionDeclaration" || isFnExpr(node);
  const nextScope = isFn ? new Set(compScope) : compScope;
  if (isFn) {
    for (const n of functionBindings(node)) nextScope.add(n);
    if (node.identifier?.value) nextScope.add(node.identifier.value);
  }
  forEachChild(node, (c) => visitQrl(st, c, nextScope));
}

/** Replace the handler expression with a `qrl(() => import(<segment>), <id>[, [captures]])` reference. */
function replaceWithQrl(
  st: QrlState,
  expr: Node,
  id: string,
  stem: string,
  captures: string[],
): void {
  const spec = st.segmentSpecifier(stem);
  const cap = captures.length ? `, [${captures.join(", ")}]` : "";
  st.edits.push({
    start: startOf(st.ctx, expr),
    end: endOf(st.ctx, expr),
    text: `qrl(() => import(${JSON.stringify(spec)}), ${JSON.stringify(id)}${cap})`,
  });
}

/** `onClick={imported}` → a segment that re-exports the imported handler; no capture. */
function extractImportRef(st: QrlState, expr: Node, id: string, stem: string): void {
  const b = st.imports.get(expr.value)!;
  const line = b.kind === "default"
    ? `export { default } from ${JSON.stringify(b.source)};`
    : b.kind === expr.value
    ? `export { ${expr.value} as default } from ${JSON.stringify(b.source)};`
    : `export { ${b.kind} as default } from ${JSON.stringify(b.source)};`;
  st.segments.push({ name: stem, code: line + "\n" });
  replaceWithQrl(st, expr, id, stem, []);
}

/**
 * An inline handler: classify its free vars as captures (component-local), imports to
 * re-bind in the segment, or globals (available in the segment). A module-scope non-import
 * binding can't be reached from the segment → bail (false).
 */
function extractInlineHandler(
  st: QrlState,
  expr: Node,
  compScope: Set<string>,
  id: string,
  stem: string,
): boolean {
  const captures: string[] = [];
  const neededImports: string[] = [];
  for (const name of freeVars(expr)) {
    if (compScope.has(name)) captures.push(name);
    else if (st.imports.has(name)) neededImports.push(name);
    else if (st.moduleNames.has(name)) return false;
  }
  const importLines = neededImports.map((n) => importLine(n, st.imports.get(n)!));
  const capBind = captures.length ? `  const [${captures.join(", ")}] = capturedScope();\n` : "";
  const seg = [
    `import { capturedScope } from ${JSON.stringify(runtimeUrl())};`,
    ...importLines,
    ``,
    `export default function (event) {`,
    capBind + `  return (${txt(st.ctx, expr)})(event);`,
    `}`,
    ``,
  ].join("\n");
  st.segments.push({ name: stem, code: seg });
  replaceWithQrl(st, expr, id, stem, captures);
  return true;
}

/**
 * Extract one handler attribute when the extraction is provably sound: an inline function
 * (without JSX/`this`/`arguments`/`super`) or a bare reference to an imported handler.
 */
function tryExtract(st: QrlState, attrName: string, expr: Node, compScope: Set<string>): boolean {
  const isInlineFn = isFnExpr(expr);
  const isBareImportRef = expr.type === "Identifier" && st.imports.has(expr.value);
  if (!isInlineFn && !isBareImportRef) return false;
  if (isInlineFn && hasUnsafeConstruct(expr)) return false;
  const id = `${st.modId}#${attrName}${st.counter}`;
  const stem = `qseg_${st.modId}_${attrName}${st.counter}`;
  st.counter++;
  if (isBareImportRef) {
    extractImportRef(st, expr, id, stem);
    return true;
  }
  return extractInlineHandler(st, expr, compScope, id, stem);
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
  return await writeTransformedModules(files, dir, async (source, url) => {
    const result = await transformQrl(source, url);
    // A segment is written beside its transformed module (same output directory).
    for (const seg of result.segments) {
      await Deno.writeTextFile(join(dir, `${seg.name}.tsx`), seg.code);
    }
    return result;
  });
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
