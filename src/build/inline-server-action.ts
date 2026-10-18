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
//   A declaration is hoisted to the top of its block, as JavaScript hoists it. One that reads
//   locals of an enclosing function or block gets them as leading arguments, bound at its site
//   and sealed into its reference id (AES-GCM, ../server/action-bound.ts), as Next.js encrypts
//   them:
//
//     const del = _dnxBindAction(_dnxInlineAction0, () => [id], "del");
//     const _dnxInlineAction0 = _dnxServerRef("a…", (id, ...args) => (async function del() {
//       "use server"; await remove(id);
//     })(...args));
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
import { projectSourceFiles } from "./platform-extensions.ts";
import { toPosixPath } from "./mobile-paths.ts";

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
  // `/`-separated on every OS, as Next prints it (a Windows caller's `relative()` gives backslashes).
  const lines = [...found].map(([module, at]) => `  ${toPosixPath(module)}:${at.join(", ")}`);
  return `${INLINE_ACTION_IN_CLIENT_ERROR}\n\n${lines.join("\n")}`;
}

/** The function's name (a declaration's or a named expression's), if any. */
function fnName(fn: Node): string | undefined {
  return (fn.identifier?.value as string | undefined) ?? undefined;
}

/**
 * An inline `"use server"` function denext can't make a server reference of. The server copy
 * compiler (./use-cache-loader.ts) lets it through instead of loading the module as written,
 * where the form would silently render with no `action`.
 */
export class InlineServerActionError extends Error {
  override name = "InlineServerActionError";
}

/** A build error for `fn` in `moduleUrl`. */
function inlineError(ctx: Ctx, moduleUrl: string, fn: Node, message: string): Error {
  return new InlineServerActionError(`denext: ${message}\n    at ${moduleUrl}:${where(ctx, fn)}`);
}

/**
 * Whether `source` holds an inline `"use server"` function (a module that is itself
 * `"use server"` holds none). A cheap text test first: only a module that mentions the
 * directive is parsed.
 *
 * @param source A module's source.
 */
export async function hasInlineServerActions(source: string): Promise<boolean> {
  return (await findInlineServerActions(source)).length > 0;
}

/**
 * The modules among `files` (absolute paths) that hold an inline `"use server"` function: the
 * native server render loads each through a compiled copy (./use-cache-loader.ts). An unreadable
 * file holds none.
 *
 * @param files The project's source modules.
 */
export async function inlineServerActionModules(files: Iterable<string>): Promise<string[]> {
  const all = [...files];
  const found: string[] = [];
  // A bounded number of reads at a time (a large project has thousands of modules).
  for (let i = 0; i < all.length; i += 64) {
    const batch = all.slice(i, i + 64);
    const hits = await Promise.all(batch.map(async (file) => {
      const source = await Deno.readTextFile(file).catch(() => "");
      return await hasInlineServerActions(source);
    }));
    batch.forEach((file, j) => hits[j] && found.push(file));
  }
  return found;
}

/**
 * The project's modules that hold an inline `"use server"` function (absolute paths): whether
 * the native server render needs its copy compiler at all, when nothing else (Cache Components,
 * platform files, stylesheets) asks for it.
 *
 * @param projectDir The project root.
 */
export async function projectInlineServerActionModules(projectDir: string): Promise<string[]> {
  return await inlineServerActionModules(await Array.fromAsync(projectSourceFiles(projectDir)));
}

/**
 * Where a declaration hoisted to the top of `scope` goes: after a block's opening brace (and a
 * function body's directives), or null for a scope that is not a block (it stays in place).
 */
function blockStart(ctx: Ctx, scope: Node): number | null {
  if (scope?.type !== "BlockStatement") return null;
  const directives = prologueEnd(ctx, scope.stmts ?? []);
  return directives > 0 ? directives : startOf(ctx, scope) + 1;
}

/** Reject what denext can't make a server reference of (see the module comment). */
function assertHoistable(ctx: Ctx, moduleUrl: string, { fn }: Found): void {
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
}

/** A module-scope inline action, registered in place (a declaration keeps its binding). */
function moduleScopeEdits(ctx: Ctx, fn: Node, id: string, name: string | undefined): Edit[] {
  const isDecl = fn.type === "FunctionDeclaration";
  const start = startOf(ctx, fn);
  const end = endOf(ctx, fn);
  const prefix = isDecl ? `const ${name} = _dnxServerRef(${id}, ` : `_dnxServerRef(${id}, `;
  return [
    { start, end: start, text: prefix },
    { start: end, end, text: isDecl ? ");" : ")" },
  ];
}

/**
 * A nested inline action: the function moves to module scope (the returned statement, `ref`)
 * and its site reads the registered reference, bound to the enclosing values it reads (sealed
 * into its id, ../server/action-bound.ts). Pushes the site's edits onto `edits`.
 */
function nestedEdits(
  ctx: Ctx,
  { fn, scopes }: Found,
  id: string,
  name: string | undefined,
  ref: string,
  edits: Edit[],
): string {
  const bound = boundNames(fn, scopes);
  const params = bound.join(", ");
  const handler = bound.length === 0
    ? txt(ctx, fn)
    : `(${params}, ...args) => (${txt(ctx, fn)})(...args)`;
  const site = bound.length === 0
    ? ref
    : `_dnxBindAction(${ref}, () => [${params}], ${JSON.stringify(name ?? "")})`;
  const start = startOf(ctx, fn);
  const end = endOf(ctx, fn);
  // A declaration is hoisted in its block, as JavaScript hoists it: a use above it (or a value it
  // reads declared below it) still finds it. The values are read when the reference is first
  // rendered or called.
  const at = fn.type === "FunctionDeclaration" ? blockStart(ctx, scopes[scopes.length - 1]) : null;
  if (fn.type !== "FunctionDeclaration") edits.push({ start, end, text: site });
  else if (at === null) edits.push({ start, end, text: `const ${name} = ${site};` });
  else {
    edits.push({ start, end, text: "" });
    edits.push({ start: at, end: at, text: `const ${name} = ${site};` });
  }
  return `const ${ref} = _dnxServerRef(${id}, ${handler});`;
}

/**
 * Rewrite each inline `"use server"` function of a SERVER module into a registered server
 * reference (see the module comment). A module with none (or a `"use server"` module) is
 * returned unchanged.
 *
 * @param source The module source.
 * @param moduleUrl The module's absolute URL: it keys the action ids.
 * @returns The rewritten code and whether anything changed.
 * @throws {InlineServerActionError} When an inline action is a method.
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
    const name = fnName(f.fn);
    const id = JSON.stringify(actionIdFor(moduleUrl, `inline:${i}:${name ?? ""}`));
    if (f.scopes.length === 0) edits.push(...moduleScopeEdits(ctx, f.fn, id, name));
    else hoisted.push(nestedEdits(ctx, f, id, name, `_dnxInlineAction${i}`, edits));
  });
  const importAt = prologueEnd(ctx, body);
  const runtime = JSON.stringify(new URL("../server/action-bound.ts", import.meta.url).href);
  edits.push({
    start: importAt,
    end: importAt,
    order: -1,
    text:
      `\nimport { bindInlineAction as _dnxBindAction, inlineServerReference as _dnxServerRef } ` +
      `from ${runtime};\n`,
  });
  if (hoisted.length > 0) {
    const tail = ctx.bytes.length;
    edits.push({ start: tail, end: tail, text: `\n${hoisted.join("\n")}\n` });
  }
  return { code: applyEdits(ctx.bytes, edits), changed: true };
}
