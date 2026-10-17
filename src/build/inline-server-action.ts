// Inline Server Actions: a function whose BODY opens with `"use server"` (Next.js's inline
// action), declared in a module that has no module-top `"use server"`.
//
// - Server side ({@linkcode transformInlineServerActions}): each one becomes a server reference
//   registered under a build-stable id when its module is imported, so `<form action={fn}>`
//   renders the action endpoint, Flight serializes it as a reference, and the endpoint finds it
//   without the page having rendered first. One declared inside a function (a Server Component)
//   is hoisted to module scope, as Next's compiler hoists it:
//
//     export default function Page() {
//       async function add(fd) { "use server"; await db.add(fd.get("title")); }
//       return <form action={add}>…</form>;
//     }
//     ⇒ export default function Page() {
//       const add = _dnxInlineAction0;
//       return <form action={add}>…</form>;
//     }
//     const _dnxInlineAction0 = _dnxServerRef("a…", async function add(fd) { "use server"; … });
//
//   Next binds the values a nested action closes over (encrypted, round-tripped through the
//   page); denext does not, so an action that reads a local of an enclosing function or block
//   is a build error naming the variables, never a reference that runs with another request's
//   values.
// - Client side ({@linkcode findInlineServerActions}, {@linkcode inlineServerActionError}): a
//   module the browser gets must not hold one at all — its body, and whatever it closes over,
//   would ship. Next refuses the build with the same message.

import { actionIdFor } from "../runtime/server-action.ts";
import { scanDirective } from "./directives.ts";
import {
  applyEdits,
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
} from "./swc-ast.ts";
import { BLOCK_SCOPES, boundNames, FN_SCOPES } from "./use-cache-transform.ts";

/** Next.js's build error for an inline `"use server"` function in client code (verbatim). */
export const INLINE_ACTION_IN_CLIENT_ERROR =
  'It is not allowed to define inline "use server" annotated Server Actions in Client ' +
  "Components.\nTo use Server Actions in a Client Component, you can either export them from " +
  'a separate file with "use server" at the top, or pass them down through props from a ' +
  "Server Component.\n\nRead more: https://nextjs.org/docs/app/api-reference/directives/" +
  "use-server#using-server-functions-in-a-client-component";

/** The statements of a function-like node's block body (none for an expression body). */
function bodyStatements(fn: Node): Node[] {
  const body = (fn.function ?? fn).body;
  return body?.type === "BlockStatement" ? body.stmts ?? body.body ?? [] : [];
}

/** The string value of a directive-prologue statement, or null when `stmt` is not one. */
function directiveValue(stmt: Node): string | null {
  const e = stmt?.type === "ExpressionStatement" ? stmt.expression : null;
  return e?.type === "StringLiteral" ? e.value : null;
}

/** Whether a function-like node's body opens with a `"use server"` directive. */
function hasUseServer(fn: Node): boolean {
  for (const stmt of bodyStatements(fn)) {
    const value = directiveValue(stmt);
    if (value === null) return false;
    if (value === "use server") return true;
  }
  return false;
}

/** One inline action found in a module: the node and the scopes enclosing it. */
interface Found {
  readonly fn: Node;
  readonly scopes: readonly Node[];
}

/** Every inline `"use server"` function in `body` (not those nested inside one). */
function collect(body: Node[]): Found[] {
  const found: Found[] = [];
  const visit = (node: Node, scopes: readonly Node[]) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "string" && FN_SCOPES.has(node.type) && hasUseServer(node)) {
      found.push({ fn: node, scopes });
      return;
    }
    const inner = typeof node.type === "string" &&
        (FN_SCOPES.has(node.type) || BLOCK_SCOPES.has(node.type))
      ? [...scopes, node]
      : scopes;
    forEachChild(node, (child) => visit(child, inner));
  };
  for (const item of body) visit(item, []);
  return found;
}

/** `line:column` of `node` in the module. */
function where(ctx: Ctx, node: Node): string {
  const { line, column } = positionAt(ctx.bytes, lineIndex(ctx.bytes), startOf(ctx, node));
  return `${line}:${column}`;
}

/** Cheap pre-filter: the module can't hold an inline action (or is a `"use server"` module). */
function skips(source: string): boolean {
  return !source.includes("use server") || scanDirective(source) === "server";
}

/**
 * The positions (`line:column`) of the inline `"use server"` functions in `source` — a module
 * that is itself `"use server"` has none (its exports are actions, stubbed whole). Empty when
 * the module can't be parsed.
 *
 * @param source A module's source.
 */
export async function findInlineServerActions(source: string): Promise<string[]> {
  if (skips(source)) return [];
  const parsed = await parseModule(source);
  if (!parsed) return [];
  return collect(parsed.body).map(({ fn }) => where(parsed.ctx, fn));
}

/**
 * The build error for inline `"use server"` functions in modules a client bundle would ship:
 * Next's message, then each module and position.
 *
 * @param found Each module's display path → the positions of its inline actions.
 */
export function inlineServerActionError(found: ReadonlyMap<string, readonly string[]>): string {
  const lines = [...found].map(([module, at]) => `  ${module}:${at.join(", ")}`);
  return `${INLINE_ACTION_IN_CLIENT_ERROR}\n\n${lines.join("\n")}`;
}

/** The function's name (a declaration's or a named expression's), if any. */
function fnName(fn: Node): string | undefined {
  return (fn.identifier?.value as string | undefined) ?? undefined;
}

/** A build error for `fn` in `moduleUrl`. */
function inlineError(ctx: Ctx, moduleUrl: string, fn: Node, message: string): Error {
  return new Error(`denext: ${message}\n    at ${moduleUrl}:${where(ctx, fn)}`);
}

/** Reject what denext can't make a server reference of (see the module comment). */
function assertHoistable(ctx: Ctx, moduleUrl: string, { fn, scopes }: Found): void {
  if (
    fn.type !== "FunctionDeclaration" && fn.type !== "FunctionExpression" &&
    fn.type !== "ArrowFunctionExpression"
  ) {
    throw inlineError(
      ctx,
      moduleUrl,
      fn,
      'a "use server" method is not supported: declare the action as a function, or export it ' +
        'from a "use server" module.',
    );
  }
  const bound = boundNames(fn, scopes);
  if (bound.length === 0) return;
  throw inlineError(
    ctx,
    moduleUrl,
    fn,
    `the inline Server Action ${fnName(fn) ?? "(anonymous)"} reads ${
      bound.map((n) => `\`${n}\``).join(", ")
    } from an enclosing function or block. denext hoists inline actions to module scope and ` +
      "does not bind the values they close over: pass them in the form (a hidden input) or as " +
      "an argument (`action.bind(null, value)` is not supported either), or move the action to " +
      'a "use server" module.',
  );
}

/**
 * Rewrite each inline `"use server"` function of a SERVER module into a registered server
 * reference (see the module comment). A module with none (or a `"use server"` module) is
 * returned unchanged.
 *
 * @param source The module source.
 * @param moduleUrl The module's absolute URL: it keys the action ids.
 * @returns The rewritten code and whether anything changed.
 * @throws When an inline action closes over an enclosing function's or block's values, or is
 *   a method.
 */
export async function transformInlineServerActions(
  source: string,
  moduleUrl: string,
): Promise<{ code: string; changed: boolean }> {
  const identity = { code: source, changed: false };
  if (skips(source)) return identity;
  const parsed = await parseModule(source);
  if (!parsed) return identity;
  const { ctx, body } = parsed;
  const found = collect(body);
  if (found.length === 0) return identity;
  const edits: Edit[] = [];
  const hoisted: string[] = [];
  found.forEach((f, i) => {
    assertHoistable(ctx, moduleUrl, f);
    const { fn, scopes } = f;
    const name = fnName(fn);
    const id = JSON.stringify(actionIdFor(moduleUrl, `inline:${i}:${name ?? ""}`));
    const isDecl = fn.type === "FunctionDeclaration";
    const start = startOf(ctx, fn);
    const end = endOf(ctx, fn);
    if (scopes.length === 0) {
      // Module scope: register in place (a declaration keeps its binding, `export` included).
      const prefix = isDecl ? `const ${name} = _dnxServerRef(${id}, ` : `_dnxServerRef(${id}, `;
      edits.push({ start, end: start, text: prefix });
      edits.push({ start: end, end, text: isDecl ? ");" : ")" });
      return;
    }
    // Nested: the function moves to module scope; its site reads the registered reference.
    const ref = `_dnxInlineAction${i}`;
    hoisted.push(`const ${ref} = _dnxServerRef(${id}, ${txt(ctx, fn)});`);
    edits.push({ start, end, text: isDecl ? `const ${name} = ${ref};` : ref });
  });
  const importAt = prologueEnd(ctx, body);
  const runtime = JSON.stringify(new URL("../runtime/server-action.ts", import.meta.url).href);
  edits.push({
    start: importAt,
    end: importAt,
    order: -1,
    text: `\nimport { registerServerReference as _dnxServerRef } from ${runtime};\n`,
  });
  if (hoisted.length > 0) {
    const tail = ctx.bytes.length;
    edits.push({ start: tail, end: tail, text: `\n${hoisted.join("\n")}\n` });
  }
  return { code: applyEdits(ctx.bytes, edits), changed: true };
}
