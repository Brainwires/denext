// Build-time transform that makes denext's first-party AsyncContext (src/runtime/
// async-context.ts) propagate across `await` — the piece a native `await` gives no
// runtime hook for. Enabled by `experimental.asyncContext`.
//
// denext owns no transpile hook (`deno bundle` runs swc internally), so this is a
// separate pass that rewrites CLIENT modules and feeds the rewritten versions into
// the client bundle via the import-map redirect seam (the same mechanism the
// auto-memo compiler and the qrl extractor use). It only ever touches the client
// bundle: the runtime helpers are pure context bookkeeping — they change which
// AsyncContext value is visible, never a rendered value — so a transformed module is
// behavior-equivalent on the server, and SSR/hydration stay aligned.
//
// Each instrumented async function is bracketed like the TC39 AsyncContext polyfill:
//
//   async (args) => { … await X … }
//     ⇒
//   async (args) => {
//     const $ = __asyncScope();                    // capture the frame's context
//     try { … await __asyncAwait($, X) … }         // survive each await
//     finally { __asyncScopeEnd($); }              // restore the ambient on completion
//   }
//
// `for await (a of R)` wraps the iterable as `__asyncIter($, R)`. An async generator
// (`async function*`) is instrumented too: each `await` is bracketed as above and
// each `yield V` becomes `__asyncResume($, yield __asyncYield($, V))`, so the frame's
// context is handed back to the caller while suspended and restored on resume. Its
// frame is captured at the first `.next()` (resume-time — TC39 has not settled
// creation- vs. resume-time capture). Correctness over coverage: a generator that
// uses `yield*` delegation is left uninstrumented (delegation suspends through a
// sub-iterator, which needs different bracketing) — a rare shape. Top-level `await`
// (module init) is likewise left alone.

import { join, toFileUrl } from "@std/path";
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
  writeTransformedModules,
} from "./swc-ast.ts";

/**
 * The absolute URL a transformed module imports the AsyncContext helpers from: the
 * compiler-runtime entry (`denext/compiler-runtime`), the one stable surface every
 * build transform's output imports — not the internal async-context module.
 */
function runtimeUrl(): string {
  return frameworkFileUrl("src/runtime/compiler-runtime.ts");
}

/** The result of transforming one module. */
export interface AsyncContextResult {
  /** The rewritten source (unchanged when `changed` is false). */
  code: string;
  /** Whether any await/for-await was instrumented. */
  changed: boolean;
}

/** The async/generator/params/body of any function-like node, or null if not one. */
interface FnParts {
  async: boolean;
  generator: boolean;
  params: Node[];
  /** A BlockStatement, or (arrow only) an expression. */
  body: Node;
  /** Whether `body` is an expression (concise arrow) rather than a block. */
  exprBody: boolean;
}

function getFn(node: Node): FnParts | null {
  switch (node.type) {
    case "ArrowFunctionExpression": {
      const exprBody = node.body?.type !== "BlockStatement";
      return {
        async: !!node.async,
        generator: !!node.generator,
        params: node.params ?? [],
        body: node.body,
        exprBody,
      };
    }
    case "FunctionExpression":
    case "FunctionDeclaration":
    case "MethodProperty":
      return {
        async: !!node.async,
        generator: !!node.generator,
        params: node.params ?? [],
        body: node.body,
        exprBody: false,
      };
    case "ClassMethod":
    case "PrivateMethod": {
      const fn = node.function;
      if (!fn) return null;
      return {
        async: !!fn.async,
        generator: !!fn.generator,
        params: fn.params ?? [],
        body: fn.body,
        exprBody: false,
      };
    }
  }
  return null;
}

/**
 * True if `body` contains an `await` or `for await` that belongs directly to its
 * function — i.e. not nested inside another function. Only such a function needs a
 * scope; an async function with no direct await never suspends through one.
 */
/**
 * Walk `body`'s OWN scope — every node except those inside a nested function (whose
 * awaits/yields are its own). `visit` returning true stops descent below that node.
 */
function walkOwnScope(body: Node, visit: (n: Node) => boolean | void): void {
  const rec = (n: Node): void => {
    if (!n || typeof n !== "object" || getFn(n)) return;
    if (visit(n) === true) return;
    forEachChild(n, rec);
  };
  rec(body);
}

function hasDirectAwait(body: Node): boolean {
  let found = false;
  walkOwnScope(body, (n) => {
    if (n.type === "AwaitExpression" || (n.type === "ForOfStatement" && n.await === true)) {
      found = true;
    }
    return found;
  });
  return found;
}

/**
 * Scan a generator body for `yield`s that belong directly to it (not to a nested
 * function): whether any exist, and whether any is a `yield*` delegate (which we
 * leave uninstrumented — delegation suspends through a sub-iterator).
 */
function directYields(body: Node): { hasYield: boolean; hasDelegate: boolean } {
  let hasYield = false;
  let hasDelegate = false;
  walkOwnScope(body, (n) => {
    if (n.type !== "YieldExpression") return;
    hasYield = true;
    if (n.delegate === true) hasDelegate = true;
  });
  return { hasYield, hasDelegate };
}

/** The per-module transform state: edits, the helper names used, the scope counter. */
interface AcState {
  readonly ctx: Ctx;
  readonly edits: Edit[];
  readonly used: Set<string>;
  counter: number;
}

function insertAt(st: AcState, at: number, text: string, order: number): void {
  st.edits.push({ start: at, end: at, order, text });
}

/**
 * Bracket a block or expression body with the scope open/try + finally/close:
 * `=> EXPR` becomes `=> { const $=__asyncScope(); try { return (EXPR) } finally {…} }`;
 * a block gets the open just after `{` and the close just before `}`.
 */
function wrapBody(st: AcState, fnBody: Node, exprBody: boolean, scope: string): void {
  st.used.add("__asyncScope").add("__asyncScopeEnd");
  const { ctx } = st;
  if (exprBody) {
    insertAt(st, startOf(ctx, fnBody), `{ const ${scope} = __asyncScope(); try { return (`, 0);
    insertAt(st, endOf(ctx, fnBody), `); } finally { __asyncScopeEnd(${scope}); } }`, 5);
  } else {
    insertAt(st, startOf(ctx, fnBody) + 1, ` const ${scope} = __asyncScope(); try {`, 0);
    insertAt(st, endOf(ctx, fnBody) - 1, `} finally { __asyncScopeEnd(${scope}); } `, 5);
  }
}

/** Wrap an `await X` argument (`__asyncAwait`) or a `for await (… of R)` iterable (`__asyncIter`). */
function wrapWith(
  st: AcState,
  helper: "__asyncAwait" | "__asyncIter",
  arg: Node,
  scope: string,
): void {
  st.used.add(helper);
  insertAt(st, startOf(st.ctx, arg), `${helper}(${scope}, `, 1);
  insertAt(st, endOf(st.ctx, arg), `)`, 1);
}

/**
 * Wrap one `yield V` (or bare `yield`): `__asyncResume($, yield __asyncYield($, V))` —
 * hand the caller back its context before suspending, restore the frame's on resume.
 * Insertion-based (never re-emits V), so a nested await/yield inside V is still
 * instrumented by the walk.
 */
function wrapYield(st: AcState, node: Node, scope: string): void {
  st.used.add("__asyncYield").add("__asyncResume");
  const { ctx } = st;
  insertAt(st, startOf(ctx, node), `__asyncResume(${scope}, `, 0);
  if (node.argument) {
    insertAt(st, startOf(ctx, node.argument), `__asyncYield(${scope}, `, 1);
    insertAt(st, endOf(ctx, node.argument), `)`, 1);
  } else {
    // Bare `yield` (no argument): supply `__asyncYield($)` as the yielded value.
    insertAt(st, endOf(ctx, node), ` __asyncYield(${scope})`, 1);
  }
  insertAt(st, endOf(ctx, node), `)`, 5);
}

/**
 * Instrument an async function/arrow that actually awaits, OR an async generator that
 * awaits or yields (its yields need the same suspension bracketing), returning the new
 * scope var; null when the function is left alone. A generator that uses `yield*`
 * delegation is left alone — its delegated suspension needs different handling. Sync
 * generators never cross an async boundary, so they're left alone too.
 */
function scopeForFunction(st: AcState, fn: FnParts): string | null {
  if (!fn.async || !fn.body) return null;
  let instrument: boolean;
  if (fn.generator) {
    const { hasYield, hasDelegate } = directYields(fn.body);
    instrument = !hasDelegate && (hasDirectAwait(fn.body) || hasYield);
  } else {
    instrument = hasDirectAwait(fn.body);
  }
  if (!instrument) return null;
  const scope = `__dnxAc${st.counter++}`;
  wrapBody(st, fn.body, fn.exprBody, scope);
  return scope;
}

/**
 * Visit a function node. Param defaults are evaluated before the body scope exists (no
 * scope there); the body carries the (possibly new) scope so nested functions
 * re-establish theirs; a computed method key is evaluated in the enclosing scope.
 */
function visitFunction(st: AcState, node: Node, fn: FnParts, scope: string | null): void {
  const childScope = scopeForFunction(st, fn);
  for (const p of fn.params) visit(st, p, null);
  if (fn.body) visit(st, fn.body, childScope);
  if (node.key) visit(st, node.key, scope);
}

/** Handle an `await`, `for await` or `yield` node; false when `node` is none of those. */
function visitSuspension(st: AcState, node: Node, scope: string | null): boolean {
  if (node.type === "AwaitExpression") {
    if (scope) wrapWith(st, "__asyncAwait", node.argument, scope);
    visit(st, node.argument, scope); // nested `await` inside the argument
    return true;
  }
  if (node.type === "ForOfStatement" && node.await === true) {
    if (scope) wrapWith(st, "__asyncIter", node.right, scope);
    visit(st, node.left, scope);
    visit(st, node.right, scope);
    visit(st, node.body, scope);
    return true;
  }
  if (node.type === "YieldExpression") {
    // A `yield*` delegate is never instrumented (its generator was bailed, so scope is
    // null here anyway); a plain `yield` is bracketed when in an async-gen scope.
    if (scope && node.delegate !== true) wrapYield(st, node, scope);
    if (node.argument) visit(st, node.argument, scope); // nested await/yield inside V
    return true;
  }
  return false;
}

/** Depth-first walk carrying the nearest enclosing instrumented scope var (or null). */
function visit(st: AcState, node: Node, scope: string | null): void {
  if (!node || typeof node !== "object") return;
  const fn = getFn(node);
  if (fn) return visitFunction(st, node, fn, scope);
  if (visitSuspension(st, node, scope)) return;
  forEachChild(node, (c) => visit(st, c, scope));
}

/**
 * Transform one module's source, bracketing every instrumentable `await`/`for await`
 * so denext's AsyncContext survives it. Returns the rewritten code and a changed flag.
 *
 * @param source The module source.
 * @param opts.runtime Override the helper import specifier (tests point it at the
 *   real runtime module; the build defaults to its absolute framework URL).
 */
export async function transformAsyncContext(
  source: string,
  opts: { runtime?: string } = {},
): Promise<AsyncContextResult> {
  const identity: AsyncContextResult = { code: source, changed: false };
  // Cheap pre-filter: no `await` anywhere → nothing to do.
  if (!source.includes("await")) return identity;
  const parsed = await parseModule(source);
  if (!parsed) return identity; // unparseable/empty → identity
  const { ctx, body } = parsed;
  const st: AcState = { ctx, edits: [], used: new Set(), counter: 0 };
  for (const item of body) visit(st, item, null);
  if (st.edits.length === 0) return identity;
  // Inject the helper import after any leading directive prologue.
  const names = [...st.used].sort().join(", ");
  const spec = opts.runtime ?? runtimeUrl();
  insertAt(
    st,
    prologueEnd(ctx, body),
    `\nimport { ${names} } from ${JSON.stringify(spec)};\n`,
    -10,
  );
  return { code: applyEdits(ctx.bytes, st.edits), changed: true };
}

/**
 * Transform each source file so AsyncContext survives its awaits, writing changed
 * modules into `<outDir>/asyncctx/` and returning an import-map of
 * `original file URL → transformed file URL` to merge into the client bundle's
 * redirects. Server rendering keeps the originals (the transform is behavior-neutral
 * there), so SSR/hydration stay aligned. Unchanged modules are omitted.
 *
 * Also emits the mode module (`async-context-mode.ts` → `true`) as a redirect so the
 * reconciler flips into identity scoping for this build.
 *
 * @param files Absolute paths of candidate source modules.
 * @param opts.outDir The build output directory.
 */
export async function compileAsyncContextModules(
  files: string[],
  opts: { outDir: string },
): Promise<Record<string, string>> {
  const dir = join(opts.outDir, "asyncctx");
  const map = await writeTransformedModules(files, dir, (source) => transformAsyncContext(source));
  // Flip the reconciler into scoping mode by redirecting the mode module to `true`.
  const modeSrc = "export const asyncContextScopingEnabled = true;\n";
  const modeOut = join(dir, "mode.ts");
  await Deno.writeTextFile(modeOut, modeSrc);
  const modeUrl = frameworkFileUrl("src/runtime/async-context-mode.ts");
  map[modeUrl] = toFileUrl(modeOut).href;

  return map;
}
