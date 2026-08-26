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
// `for await (a of R)` wraps the iterable as `__asyncIter($, R)`. Correctness over
// coverage: async generators (`async function*`) are NOT instrumented in v1 (their
// `yield` suspension needs different bracketing) — documented, and a rare shape in
// client code. Top-level `await` (module init) is likewise left alone.

import { ensureDir } from "@std/fs";
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
} from "./swc-ast.ts";

/** The absolute URL a transformed module imports the AsyncContext helpers from. */
function runtimeUrl(): string {
  return toFileUrl(join(frameworkRoot(), "src/runtime/async-context.ts")).href;
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
function hasDirectAwait(body: Node): boolean {
  let found = false;
  const rec = (n: Node): void => {
    if (found || !n || typeof n !== "object") return;
    if (getFn(n)) return; // a nested function boundary — its awaits are its own
    if (n.type === "AwaitExpression" || (n.type === "ForOfStatement" && n.await === true)) {
      found = true;
      return;
    }
    for (const key of Object.keys(n)) {
      if (key === "span") continue;
      const v = n[key];
      if (Array.isArray(v)) { for (const c of v) rec(c); }
      else if (v && typeof v === "object") rec(v);
    }
  };
  rec(body);
  return found;
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

  const edits: Edit[] = [];
  const used = new Set<string>();
  let counter = 0;

  // Bracket a block or expression body with the scope open/try + finally/close.
  const wrapBody = (fnBody: Node, exprBody: boolean, scope: string): void => {
    used.add("__asyncScope").add("__asyncScopeEnd");
    if (exprBody) {
      // `=> EXPR` becomes `=> { const $=__asyncScope(); try { return (EXPR) } finally {…} }`
      edits.push({
        start: startOf(ctx, fnBody),
        end: startOf(ctx, fnBody),
        order: 0,
        text: `{ const ${scope} = __asyncScope(); try { return (`,
      });
      edits.push({
        start: endOf(ctx, fnBody),
        end: endOf(ctx, fnBody),
        order: 5,
        text: `); } finally { __asyncScopeEnd(${scope}); } }`,
      });
    } else {
      // Insert just after `{` and just before the closing `}`.
      edits.push({
        start: startOf(ctx, fnBody) + 1,
        end: startOf(ctx, fnBody) + 1,
        order: 0,
        text: ` const ${scope} = __asyncScope(); try {`,
      });
      edits.push({
        start: endOf(ctx, fnBody) - 1,
        end: endOf(ctx, fnBody) - 1,
        order: 5,
        text: `} finally { __asyncScopeEnd(${scope}); } `,
      });
    }
  };

  // Wrap one `await X` argument, or one `for await (… of R)` iterable.
  const wrapAwait = (arg: Node, scope: string): void => {
    used.add("__asyncAwait");
    edits.push({
      start: startOf(ctx, arg),
      end: startOf(ctx, arg),
      order: 1,
      text: `__asyncAwait(${scope}, `,
    });
    edits.push({ start: endOf(ctx, arg), end: endOf(ctx, arg), order: 1, text: `)` });
  };
  const wrapIter = (arg: Node, scope: string): void => {
    used.add("__asyncIter");
    edits.push({
      start: startOf(ctx, arg),
      end: startOf(ctx, arg),
      order: 1,
      text: `__asyncIter(${scope}, `,
    });
    edits.push({ start: endOf(ctx, arg), end: endOf(ctx, arg), order: 1, text: `)` });
  };

  // Depth-first walk carrying the nearest enclosing instrumented scope var (or null).
  const visit = (node: Node, scope: string | null): void => {
    if (!node || typeof node !== "object") return;

    const fn = getFn(node);
    if (fn) {
      let childScope: string | null = null;
      // Instrument async, non-generator functions that actually await. (Generators —
      // sync or async — are left alone in v1.)
      if (fn.async && !fn.generator && fn.body && hasDirectAwait(fn.body)) {
        childScope = `__dnxAc${counter++}`;
        wrapBody(fn.body, fn.exprBody, childScope);
      }
      // Param defaults are evaluated before the body scope exists → no scope there.
      for (const p of fn.params) visit(p, null);
      // The body carries the (possibly new) scope so nested functions re-establish theirs.
      if (fn.body) visit(fn.body, childScope);
      // A computed method key is evaluated in the enclosing scope.
      if (node.key) visit(node.key, scope);
      return;
    }

    if (node.type === "AwaitExpression") {
      if (scope) wrapAwait(node.argument, scope);
      visit(node.argument, scope); // nested `await` inside the argument
      return;
    }
    if (node.type === "ForOfStatement" && node.await === true) {
      if (scope) wrapIter(node.right, scope);
      visit(node.left, scope);
      visit(node.right, scope);
      visit(node.body, scope);
      return;
    }

    for (const key of Object.keys(node)) {
      if (key === "span") continue;
      const v = node[key];
      if (Array.isArray(v)) { for (const c of v) visit(c, scope); }
      else if (v && typeof v === "object") visit(v, scope);
    }
  };

  for (const item of body) visit(item, null);

  if (edits.length === 0) return identity;

  // Inject the helper import after any leading directive prologue.
  let importAt = 0;
  for (const item of body) {
    if (item.type === "ExpressionStatement" && item.expression?.type === "StringLiteral") {
      importAt = endOf(ctx, item);
    } else break;
  }
  const names = [...used].sort().join(", ");
  const spec = opts.runtime ?? runtimeUrl();
  edits.push({
    start: importAt,
    end: importAt,
    order: -10,
    text: `\nimport { ${names} } from ${JSON.stringify(spec)};\n`,
  });

  return { code: applyEdits(ctx.bytes, edits), changed: true };
}

/** Deterministic short filename for a module URL. */
function moduleFileName(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) >>> 0;
  return `m_${h.toString(36)}.tsx`;
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
  await ensureDir(dir);
  const map: Record<string, string> = {};
  for (const file of files) {
    let source: string;
    try {
      source = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    let result: AsyncContextResult;
    try {
      result = await transformAsyncContext(source);
    } catch {
      continue; // any failure → leave the original module untouched
    }
    if (!result.changed) continue;
    const url = toFileUrl(file).href;
    const out = join(dir, moduleFileName(url));
    await Deno.writeTextFile(out, result.code);
    map[url] = toFileUrl(out).href;
  }

  // Flip the reconciler into scoping mode by redirecting the mode module to `true`.
  const modeSrc = "export const asyncContextScopingEnabled = true;\n";
  const modeOut = join(dir, "mode.ts");
  await Deno.writeTextFile(modeOut, modeSrc);
  const modeUrl = toFileUrl(join(frameworkRoot(), "src/runtime/async-context-mode.ts")).href;
  map[modeUrl] = toFileUrl(modeOut).href;

  return map;
}
