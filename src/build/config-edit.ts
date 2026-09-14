// Comment-preserving, swc-AST-guided editing of `denext.config.ts`.
//
// The project UI (`denext ui`) has to write a user's config back to disk without
// losing what a generator can never reproduce: comments, import statements, plugin
// factory calls, hand-written helper functions. So nothing here regenerates a config
// — every operation is a *splice*: locate the exact byte span of one value (or one
// array element), replace only that span, and leave every other byte alone.
//
// Three tiers, mirroring `src/build/paths.ts`'s loader:
//   1. `export default { … }`                     → form "object"
//   2. `export default defineConfig({ … })`        → form "defineConfig"
//      `export default (phase) => ({ … })` / `export default function () { return { … } }`
//                                                  → form "factory"
//      `export const basePath = "/x"` (per-key)    → form "named"
//   3. anything else                               → form "unsupported", every edit bails
//
// A bail is a first-class outcome ({@linkcode EditResult} `ok: false`) carrying the
// reason, the offending snippet and — where one can be computed — the patch the user
// would have to apply by hand.
//
// All spans are UTF-8 **byte** offsets (swc's span space), so every slice goes through
// the {@linkcode https://jsr.io/@denext/denext | swc-ast} helpers and never indexes the
// JS string with a byte offset.

import {
  applyEdits,
  type Ctx,
  type Edit,
  endOf,
  type Node,
  parseModule,
  startOf,
} from "./swc-ast.ts";
import { createUnifiedDiff } from "./patch-diff.ts";
import { stripComments } from "../utils/strip-comments.ts";

const decoder = new TextDecoder();

/** deno fmt's line width (`deno.json` → `fmt.lineWidth`): serialised values stay inside it. */
const MAX_WIDTH = 100;
/** How much offending source a bail quotes back. */
const SNIPPET_MAX = 200;
/** The file name config diffs are labelled with. */
const CONFIG_LABEL = "denext.config.ts";
/** A key that can be written without quotes. */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// --- public types -----------------------------------------------------------

/** The shape of the config module, which decides whether (and how) it can be edited. */
export type ConfigForm = "object" | "defineConfig" | "named" | "factory" | "unsupported";

/** What {@linkcode readConfigModel} knows about one top-level config key. */
export interface ConfigKeyInfo {
  /** `editable` — a data literal the writer can replace; `readonly` — code it must preserve. */
  kind: "editable" | "readonly";
  /** The value's source text, verbatim (a read-only key renders as a code cell). */
  text: string;
  /** The decoded value, present only when {@linkcode ConfigKeyInfo.kind} is `editable`. */
  value?: unknown;
}

/** A config source as the UI sees it: its form plus one entry per top-level key. */
export interface ConfigModel {
  /** Which of the supported module shapes this source uses. */
  form: ConfigForm;
  /** Top-level keys, in source order; an absent key is simply missing from the record. */
  keys: Record<string, ConfigKeyInfo>;
}

/** The outcome of an edit: the new source plus a diff, or an honest refusal. */
export type EditResult =
  | { ok: true; source: string; diff: string }
  | { ok: false; reason: string; snippet: string; diff?: string };

/** One list-editor operation against an array literal; indices are positions in the current list. */
export type ArrayOp =
  | { op: "insert"; at: number; value: unknown }
  | { op: "remove"; at: number }
  | { op: "move"; from: number; to: number }
  | { op: "update"; at: number; value: unknown };

/** Options for {@linkcode applyArrayOps}. */
export interface ArrayOpsOptions {
  /**
   * How a *missing* key is created. `"function"` writes `key: () => [ … ]` (the shape
   * `redirects`/`rewrites`/`headers` need); omitted writes a plain `key: [ … ]`.
   */
  wrapper?: "function";
}

/** Options shared by the object-splice primitives. */
export interface SpliceOptions {
  /**
   * The target is a JSON document, not TypeScript: quote every key (`"a": 1`) and never
   * write a trailing comma.
   */
  json?: boolean;
}

/** The edits an object splice produced, or why it refused. */
export type SpliceOutcome =
  | { ok: true; edits: Edit[] }
  | { ok: false; reason: string; snippet: string };

// --- diff -------------------------------------------------------------------

/** The unified diff of a proposed write, labelled the way `git diff` labels one. */
function diffOf(before: string, after: string, label: string): string {
  return createUnifiedDiff(before, after, `a/${label}`, `b/${label}`);
}

// --- serialisation ----------------------------------------------------------

/** A value renderer bound to the indent and start column it will be written at. */
type Render = (indent: string, column: number) => string;

/** A key as it is written in source: bare when it is a valid identifier, else quoted. */
function keyText(key: string, json: boolean): string {
  return !json && IDENT.test(key) ? key : JSON.stringify(key);
}

/** The separator after member `i` of `n`: JSON forbids the trailing comma TypeScript likes. */
function comma(i: number, n: number, json: boolean): string {
  return json && i === n - 1 ? "" : ",";
}

/** Wrap `value` in the objects `rest` names (`["a","b"]`, 1 → `{ a: { b: 1 } }`). */
function nestValue(rest: string[], value: unknown): unknown {
  return rest.reduceRight<unknown>((acc, key) => ({ [key]: acc }), value);
}

/** Own enumerable entries with `undefined` values dropped (JSON semantics). */
function entriesOf(value: object): [string, unknown][] {
  return Object.entries(value).filter(([, v]) => v !== undefined);
}

/** The single-line form of a value (used whenever it fits inside {@linkcode MAX_WIDTH}). */
function compactText(value: unknown, json: boolean): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[${value.map((v) => compactText(v, json)).join(", ")}]`;
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? String(value) : "null";
    case "boolean":
      return String(value);
    case "object": {
      const parts = entriesOf(value as object)
        .map(([k, v]) => `${keyText(k, json)}: ${compactText(v, json)}`);
      return parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`;
    }
    default:
      return "undefined";
  }
}

/**
 * Serialise `value` as source text: one line when the line would stay inside deno fmt's
 * width, otherwise expanded with one member per line (with the trailing comma deno fmt
 * emits, unless the target is JSON). Both forms are fmt-stable, so a written config never
 * reformats on the next `deno fmt`.
 *
 * @param value The value to serialise.
 * @param indent The indent of the line the value starts on.
 * @param column The column the value starts at (indent plus any `key: ` prefix).
 * @param json Write JSON: quoted keys, no trailing comma.
 * @returns The serialised source text, without a trailing comma of its own.
 */
function renderValue(value: unknown, indent: string, column: number, json: boolean): string {
  const compact = compactText(value, json);
  if (column + compact.length + 1 <= MAX_WIDTH) return compact;
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    const parts = value.map((v, i) =>
      `${inner}${renderValue(v, inner, inner.length, json)}${comma(i, value.length, json)}`
    );
    return `[\n${parts.join("\n")}\n${indent}]`;
  }
  if (value && typeof value === "object") {
    const members = entriesOf(value as object);
    const parts = members.map(([k, v], i) => {
      const kt = keyText(k, json);
      const text = renderValue(v, inner, inner.length + kt.length + 2, json);
      return `${inner}${kt}: ${text}${comma(i, members.length, json)}`;
    });
    return `{\n${parts.join("\n")}\n${indent}}`;
  }
  return compact;
}

/** Wrap `inner` in the object literals `rest` names (`["a","b"]` → `{ a: { b: <inner> } }`). */
function nestRender(rest: string[], inner: Render, json: boolean): Render {
  if (rest.length === 0) return inner;
  return (indent, column) => {
    const kt = keyText(rest[0], json);
    const nested = nestRender(rest.slice(1), inner, json);
    const compact = `{ ${kt}: ${nested(indent, column + kt.length + 4)} }`;
    if (!compact.includes("\n") && column + compact.length + 1 <= MAX_WIDTH) return compact;
    const child = `${indent}  `;
    const body = nested(child, child.length + kt.length + 2);
    return `{\n${child}${kt}: ${body}${comma(0, 1, json)}\n${indent}}`;
  };
}

// --- byte-space source helpers ----------------------------------------------

/** The source text of a byte range. */
function slice(ctx: Ctx, start: number, end: number): string {
  return decoder.decode(ctx.bytes.subarray(start, end));
}

/** A space or tab byte. */
function isBlank(byte: number): boolean {
  return byte === 0x20 || byte === 0x09;
}

/** The byte offset just after the newline that precedes `at` (i.e. `at`'s line start). */
function lineStart(ctx: Ctx, at: number): number {
  let i = at;
  while (i > 0 && ctx.bytes[i - 1] !== 0x0a) i--;
  return i;
}

/** The leading whitespace of the line `at` sits on. */
function indentAt(ctx: Ctx, at: number): string {
  const from = lineStart(ctx, at);
  let i = from;
  while (i < at && isBlank(ctx.bytes[i])) i++;
  return slice(ctx, from, i);
}

/** The character column `at` sits at (characters, not bytes — widths are visual). */
function columnAt(ctx: Ctx, at: number): number {
  return slice(ctx, lineStart(ctx, at), at).length;
}

/** Trailing whitespace removed (leading whitespace and inner newlines preserved). */
function rightTrim(text: string): string {
  return text.replace(/\s+$/, "");
}

/** A bail's quoted source, truncated. */
function snippetOf(ctx: Ctx, node: Node): string {
  const text = slice(ctx, startOf(ctx, node), endOf(ctx, node));
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text;
}

// --- AST shape helpers ------------------------------------------------------

/** Strip the wrappers that never change a value's identity (`(x)`, `x as T`, `x satisfies T`). */
function unwrap(node: Node): Node {
  let n = node;
  while (
    n && (n.type === "ParenthesisExpression" || n.type === "TsAsExpression" ||
      n.type === "TsSatisfiesExpression" || n.type === "TsNonNullExpression" ||
      n.type === "TsConstAssertion" || n.type === "TsTypeAssertion")
  ) n = n.expression;
  return n ?? {};
}

/** The literal of `type` an arrow/function body yields, directly or through a lone `return`. */
function literalFromBody(body: Node, type: string): Node | null {
  const b = unwrap(body);
  if (!b.type) return null;
  if (b.type === type) return b;
  if (b.type !== "BlockStatement") return null;
  const stmts = (b.stmts ?? []).filter((s: Node) => s.type !== "EmptyStatement");
  if (stmts.length !== 1 || stmts[0].type !== "ReturnStatement" || !stmts[0].argument) return null;
  return literalFromBody(stmts[0].argument, type);
}

/** The name a property binds, or null for a spread/computed member. */
function propName(prop: Node): string | null {
  if (prop.type === "Identifier") return prop.value;
  const key = prop.key;
  if (!key) return null;
  if (key.type === "Identifier" || key.type === "StringLiteral") return key.value;
  if (key.type === "NumericLiteral") return String(key.value);
  return null;
}

/** The byte span of a whole property (key included), which is what a deletion removes. */
function propRange(ctx: Ctx, prop: Node): [number, number] {
  if (prop.type === "KeyValueProperty") return [startOf(ctx, prop.key), endOf(ctx, prop.value)];
  if (prop.type === "SpreadElement") {
    return [prop.spread.start - ctx.base, endOf(ctx, prop.arguments)];
  }
  return [startOf(ctx, prop), endOf(ctx, prop)];
}

/** One editable position: the value node plus the span of the property/statement holding it. */
interface Slot {
  /** The value expression (for a method or shorthand property, the member itself). */
  value: Node;
  /** Byte span of the whole member, for deletion. */
  start: number;
  end: number;
}

/** Every named member of an object literal, in source order. */
function objectSlots(ctx: Ctx, obj: Node): Map<string, Slot> {
  const out = new Map<string, Slot>();
  for (const prop of obj.properties ?? []) {
    const name = propName(prop);
    if (name === null) continue;
    const [start, end] = propRange(ctx, prop);
    out.set(name, { value: prop.type === "KeyValueProperty" ? prop.value : prop, start, end });
  }
  return out;
}

// --- literal decoding -------------------------------------------------------

/** A decoded data literal, or a refusal (the value is code the writer must preserve). */
type Decoded = { ok: true; value: unknown } | { ok: false };

const NOT_DATA: Decoded = { ok: false };

/** Decode every element of an array literal (a hole or a spread makes it code). */
function decodeArray(node: Node): Decoded {
  const out: unknown[] = [];
  for (const el of node.elements ?? []) {
    if (!el || el.spread) return NOT_DATA;
    const v = decodeLiteral(el.expression);
    if (!v.ok) return NOT_DATA;
    out.push(v.value);
  }
  return { ok: true, value: out };
}

/** Decode every member of an object literal (a spread, method or computed key makes it code). */
function decodeObject(node: Node): Decoded {
  const out: Record<string, unknown> = {};
  for (const prop of node.properties ?? []) {
    if (prop.type !== "KeyValueProperty") return NOT_DATA;
    const name = propName(prop);
    if (name === null) return NOT_DATA;
    const v = decodeLiteral(prop.value);
    if (!v.ok) return NOT_DATA;
    out[name] = v.value;
  }
  return { ok: true, value: out };
}

/**
 * Decode a node into the plain value it denotes, or refuse. Only data literals decode:
 * a call, identifier, spread, template literal, `as`/`satisfies` expression or function
 * is code, which the UI shows read-only and the writer never regenerates.
 */
function decodeLiteral(node: Node): Decoded {
  switch (node?.type) {
    case "StringLiteral":
    case "BooleanLiteral":
    case "NumericLiteral":
      return { ok: true, value: node.value };
    case "NullLiteral":
      return { ok: true, value: null };
    case "UnaryExpression": {
      if (node.operator !== "-") return NOT_DATA;
      const inner = decodeLiteral(node.argument);
      return inner.ok && typeof inner.value === "number"
        ? { ok: true, value: -inner.value }
        : NOT_DATA;
    }
    case "ArrayExpression":
      return decodeArray(node);
    case "ObjectExpression":
      return decodeObject(node);
    default:
      return NOT_DATA;
  }
}

// --- object splice primitives -----------------------------------------------

/** Inserts a brand-new member; the caller supplies the rendered value. */
type Inserter = (key: string, render: Render) => Edit;

/** The offset just past a trailing comma after `at`, and whether one was there. */
function afterComma(ctx: Ctx, at: number, limit: number): { at: number; comma: boolean } {
  let i = at;
  while (i < limit && (isBlank(ctx.bytes[i]) || ctx.bytes[i] === 0x0a || ctx.bytes[i] === 0x0d)) {
    i++;
  }
  return i < limit && ctx.bytes[i] === 0x2c ? { at: i + 1, comma: true } : { at, comma: false };
}

/** The verbatim source of every member of an object literal. */
function memberTexts(ctx: Ctx, obj: Node): string[] {
  return (obj.properties ?? []).map((prop: Node) => {
    const [start, end] = propRange(ctx, prop);
    return slice(ctx, start, end);
  });
}

/**
 * Rewrite a single-line (or empty) object literal with one more member: still on one line
 * while it fits deno fmt's width, expanded one-member-per-line when it does not.
 */
function rebuildInsert(ctx: Ctx, obj: Node, key: string, render: Render, json: boolean): Edit {
  const start = startOf(ctx, obj);
  const end = endOf(ctx, obj);
  const indent = indentAt(ctx, start);
  const column = columnAt(ctx, start);
  const kt = keyText(key, json);
  const texts = memberTexts(ctx, obj);
  const est = column + 2 + texts.reduce((n, t) => n + t.length + 2, 0) + kt.length + 2;
  const inline = `{ ${[...texts, `${kt}: ${render(indent, est)}`].join(", ")} }`;
  if (!inline.includes("\n") && column + inline.length + 1 <= MAX_WIDTH) {
    return { start, end, text: inline };
  }
  const inner = `${indent}  `;
  const members = [...texts, `${kt}: ${render(inner, inner.length + kt.length + 2)}`];
  const lines = members.map((m, i) => `${inner}${m}${comma(i, members.length, json)}`);
  return { start, end, text: `{\n${lines.join("\n")}\n${indent}}` };
}

/** Append a member to a multi-line object literal, after its last member. */
function appendInsert(ctx: Ctx, obj: Node, key: string, render: Render, json: boolean): Edit {
  const objIndent = indentAt(ctx, startOf(ctx, obj));
  const member = `${objIndent}  `;
  const kt = keyText(key, json);
  const body = `${kt}: ${render(member, member.length + kt.length + 2)}`;
  const props = obj.properties ?? [];
  const [, lastEnd] = propRange(ctx, props[props.length - 1]);
  const tail = afterComma(ctx, lastEnd, endOf(ctx, obj) - 1);
  const text = tail.comma ? `\n${member}${body},` : `,\n${member}${body}${json ? "" : ","}`;
  return { start: tail.at, end: tail.at, text };
}

/**
 * Build the edit that adds `key` to an object literal. A one-line (or empty) object is
 * rebuilt from its members' verbatim source so it stays well formed; a multi-line one is
 * appended to, touching nothing that is already there.
 */
function objectInserter(ctx: Ctx, obj: Node, opts: SpliceOptions): Inserter {
  return (key, render) => {
    const json = opts.json ?? false;
    const text = slice(ctx, startOf(ctx, obj), endOf(ctx, obj));
    const rebuildable = !text.includes("\n") || (obj.properties ?? []).length === 0;
    return rebuildable && stripComments(text) === text
      ? rebuildInsert(ctx, obj, key, render, json)
      : appendInsert(ctx, obj, key, render, json);
  };
}

/** Build the edit that replaces a slot's value with `render`'s output. */
function replaceEdit(ctx: Ctx, slot: Slot, render: Render): Edit {
  const start = startOf(ctx, slot.value);
  return {
    start,
    end: endOf(ctx, slot.value),
    text: render(indentAt(ctx, start), columnAt(ctx, start)),
  };
}

/** The offset of the comma immediately before `at` (whitespace between), else `at` itself. */
function backOverComma(ctx: Ctx, at: number): number {
  let i = at;
  while (
    i > 0 && (isBlank(ctx.bytes[i - 1]) || ctx.bytes[i - 1] === 0x0a || ctx.bytes[i - 1] === 0x0d)
  ) i--;
  return i > 0 && ctx.bytes[i - 1] === 0x2c ? i - 1 : at;
}

/** Whether `slot` is the last member of `obj` (null: a named export, which has no siblings). */
function isLastMember(ctx: Ctx, obj: Node | null, slot: Slot): boolean {
  const props: Node[] = obj?.properties ?? [];
  if (props.length === 0) return false;
  return propRange(ctx, props[props.length - 1])[0] === slot.start;
}

/** The offset past the spaces and tabs that follow `at`. */
function pastBlanks(ctx: Ctx, at: number): number {
  let i = at;
  while (i < ctx.bytes.length && isBlank(ctx.bytes[i])) i++;
  return i;
}

/** The offset past the blanks and the line break that follow `at` (or `at` when none do). */
function pastNewline(ctx: Ctx, at: number): number {
  const j = pastBlanks(ctx, at);
  if (ctx.bytes[j] === 0x0d && ctx.bytes[j + 1] === 0x0a) return j + 2;
  return ctx.bytes[j] === 0x0a ? j + 1 : at;
}

/**
 * Build the edit that removes a member: its span, its trailing comma and, when it owns the
 * line, the line itself. Removing the *last* member of a list that has no trailing comma
 * takes the separator before it instead, so the remaining list stays well formed (JSON).
 */
function deleteEdit(ctx: Ctx, slot: Slot, last: boolean): Edit {
  const tail = afterComma(ctx, slot.end, ctx.bytes.length);
  const from = lineStart(ctx, slot.start);
  const owned = slice(ctx, from, slot.start).trim() === "";
  const start = owned ? from : slot.start;
  if (last && !tail.comma) {
    const back = backOverComma(ctx, start);
    if (back !== start) return { start: back, end: tail.at, text: "" };
  }
  const end = owned ? pastNewline(ctx, tail.at) : pastBlanks(ctx, tail.at);
  return { start, end, text: "" };
}

/**
 * Edits that set `path` inside the object literal `obj` to `value`, creating the missing
 * intermediate objects when the path does not exist yet.
 *
 * @param ctx The parsed source's byte-offset context.
 * @param obj The `ObjectExpression` the path is relative to.
 * @param path The key path (at least one segment).
 * @param value The value to write; it must be plain data.
 * @param opts Splice options (JSON key quoting).
 * @returns The edits to apply, or the reason the splice refused.
 */
export function objectSetEdits(
  ctx: Ctx,
  obj: Node,
  path: string[],
  value: unknown,
  opts: SpliceOptions = {},
): SpliceOutcome {
  const scope: Scope = { form: "object", obj, named: null };
  const found = resolvePath(ctx, scope, path, opts);
  if (!found.ok) return found;
  return setAt(ctx, found.ref, value, opts);
}

/**
 * Edits that delete `path` from the object literal `obj`.
 *
 * @param ctx The parsed source's byte-offset context.
 * @param obj The `ObjectExpression` the path is relative to.
 * @param path The key path (at least one segment).
 * @returns The edits to apply, or the reason the splice refused.
 */
export function objectDeleteEdits(ctx: Ctx, obj: Node, path: string[]): SpliceOutcome {
  const found = resolvePath(ctx, { form: "object", obj, named: null }, path, {});
  if (!found.ok) return found;
  const { slot, key, parent } = found.ref;
  if (!slot) return { ok: false, reason: `\`${key}\` is not set`, snippet: "" };
  return { ok: true, edits: [deleteEdit(ctx, slot, isLastMember(ctx, parent, slot))] };
}

/** Edits that write `value` at a resolved path (replacing a literal or creating the key). */
function setAt(ctx: Ctx, ref: PathRef, value: unknown, opts: SpliceOptions): SpliceOutcome {
  const json = opts.json ?? false;
  if (!ref.slot) {
    const nested = nestValue(ref.rest, value);
    const create: Render = (indent, column) => renderValue(nested, indent, column, json);
    return { ok: true, edits: [ref.insert(ref.key, create)] };
  }
  const render: Render = (indent, column) => renderValue(value, indent, column, json);
  if (!decodeLiteral(ref.slot.value).ok) {
    return {
      ok: false,
      reason: `\`${ref.key}\` holds code, not a data literal — denext will not overwrite it`,
      snippet: snippetOf(ctx, ref.slot.value),
    };
  }
  return { ok: true, edits: [replaceEdit(ctx, ref.slot, render)] };
}

// --- config scopes ----------------------------------------------------------

/** Where top-level config keys live: one object literal, or a set of named exports. */
interface Scope {
  form: ConfigForm;
  obj: Node | null;
  named: Map<string, Slot> | null;
}

/** The default export's config object literal, with the form it was written in. */
function defaultExportObject(item: Node): Scope | null {
  if (item.type === "ExportDefaultDeclaration") {
    const decl = item.decl;
    if (decl?.type !== "FunctionExpression") return null;
    const obj = literalFromBody(decl.body, "ObjectExpression");
    return obj ? { form: "factory", obj, named: null } : null;
  }
  if (item.type !== "ExportDefaultExpression") return null;
  const expr = unwrap(item.expression);
  if (expr.type === "ObjectExpression") return { form: "object", obj: expr, named: null };
  if (expr.type === "CallExpression") {
    const arg = unwrap(expr.arguments?.[0]?.expression ?? {});
    return arg.type === "ObjectExpression" ? { form: "defineConfig", obj: arg, named: null } : null;
  }
  if (expr.type === "ArrowFunctionExpression") {
    const obj = literalFromBody(expr.body, "ObjectExpression");
    return obj ? { form: "factory", obj, named: null } : null;
  }
  return null;
}

/** `export const <key> = <value>;` statements, which `loadDenextConfig` merges as config keys. */
function namedExportSlots(ctx: Ctx, body: Node[]): Map<string, Slot> {
  const out = new Map<string, Slot>();
  for (const item of body) {
    if (item.type !== "ExportDeclaration") continue;
    const decl = item.declaration;
    if (decl?.type !== "VariableDeclaration" || decl.declarations.length !== 1) continue;
    const d = decl.declarations[0];
    if (d.id?.type !== "Identifier" || !d.init) continue;
    out.set(d.id.value, { value: d.init, start: startOf(ctx, item), end: endOf(ctx, item) });
  }
  return out;
}

/** Append `export const <key> = <value>;` at the end of the module. */
function namedInserter(ctx: Ctx): Inserter {
  return (key, render) => {
    const at = ctx.bytes.length;
    const lead = at > 0 && ctx.bytes[at - 1] !== 0x0a ? "\n" : "";
    return {
      start: at,
      end: at,
      text: `${lead}export const ${key} = ${render("", 16 + key.length)};\n`,
    };
  };
}

/** Parse a config source and locate the scope its top-level keys live in. */
async function locateScope(source: string): Promise<{ ctx: Ctx; scope: Scope } | null> {
  const parsed = await parseModule(source);
  if (!parsed) return null;
  for (const item of parsed.body) {
    const scope = defaultExportObject(item);
    if (scope) return { ctx: parsed.ctx, scope };
  }
  const named = namedExportSlots(parsed.ctx, parsed.body);
  const scope: Scope = named.size > 0
    ? { form: "named", obj: null, named }
    : { form: "unsupported", obj: null, named: null };
  return { ctx: parsed.ctx, scope };
}

/** The slot a top-level key occupies in this scope, if it is set. */
function scopeSlot(ctx: Ctx, scope: Scope, key: string): Slot | null {
  if (scope.obj) return objectSlots(ctx, scope.obj).get(key) ?? null;
  return scope.named?.get(key) ?? null;
}

/** The inserter that creates a new top-level key in this scope. */
function scopeInserter(ctx: Ctx, scope: Scope, opts: SpliceOptions): Inserter {
  return scope.obj ? objectInserter(ctx, scope.obj, opts) : namedInserter(ctx);
}

// --- path resolution --------------------------------------------------------

/** A resolved path: the slot it names, or the insertion point and remaining keys to create. */
interface PathRef {
  /** The slot the full path names, or null when the key is absent. */
  slot: Slot | null;
  /** The object literal holding {@linkcode PathRef.key}, or null for a named export. */
  parent: Node | null;
  /** How to create the missing key. */
  insert: Inserter;
  /** The key to create when {@linkcode PathRef.slot} is null. */
  key: string;
  /** Key path still to be nested under {@linkcode PathRef.key} (empty unless a parent was absent). */
  rest: string[];
}

/** Walk `path` from a scope, stopping at the first absent key (which becomes the insert point). */
function resolvePath(
  ctx: Ctx,
  scope: Scope,
  path: string[],
  opts: SpliceOptions,
): { ok: true; ref: PathRef } | { ok: false; reason: string; snippet: string } {
  if (path.length === 0) {
    return { ok: false, reason: "an empty key path cannot be edited", snippet: "" };
  }
  let insert = scopeInserter(ctx, scope, opts);
  let parent = scope.obj;
  let slot = scopeSlot(ctx, scope, path[0]);
  for (let i = 1; i < path.length; i++) {
    if (!slot) {
      return {
        ok: true,
        ref: { slot: null, parent, insert, key: path[i - 1], rest: path.slice(i) },
      };
    }
    const obj = unwrap(slot.value);
    if (obj.type !== "ObjectExpression") {
      return {
        ok: false,
        reason: `\`${path.slice(0, i).join(".")}\` is not an object literal`,
        snippet: snippetOf(ctx, slot.value),
      };
    }
    insert = objectInserter(ctx, obj, opts);
    parent = obj;
    slot = objectSlots(ctx, obj).get(path[i]) ?? null;
  }
  return { ok: true, ref: { slot, parent, insert, key: path[path.length - 1], rest: [] } };
}

// --- result helpers ---------------------------------------------------------

/** Apply edits and package them as a successful {@linkcode EditResult}. */
function commit(source: string, ctx: Ctx, edits: Edit[], label: string): EditResult {
  const next = applyEdits(ctx.bytes, edits);
  return { ok: true, source: next, diff: diffOf(source, next, label) };
}

/** A refusal, optionally carrying the patch the user would have to apply by hand. */
function bail(reason: string, snippet: string, diff?: string): EditResult {
  return diff ? { ok: false, reason, snippet, diff } : { ok: false, reason, snippet };
}

/** The scope for a source, or the refusal to hand back when there is none. */
async function scopeOf(
  source: string,
): Promise<{ ok: true; ctx: Ctx; scope: Scope } | { ok: false; result: EditResult }> {
  const found = await locateScope(source);
  if (!found) {
    return {
      ok: false,
      result: bail("the config could not be parsed", source.slice(0, SNIPPET_MAX)),
    };
  }
  if (found.scope.form === "unsupported") {
    return {
      ok: false,
      result: bail(
        "no editable config object found (denext.config.ts must export a config object, " +
          "a defineConfig(…) call, a function returning one, or named config exports)",
        source.slice(0, SNIPPET_MAX),
      ),
    };
  }
  return { ok: true, ctx: found.ctx, scope: found.scope };
}

/** Resolve a source and key path to an edit point, or the refusal to hand back. */
async function locatePath(
  source: string,
  path: string[],
): Promise<{ ok: true; ctx: Ctx; ref: PathRef } | { ok: false; result: EditResult }> {
  const scope = await scopeOf(source);
  if (!scope.ok) return scope;
  const found = resolvePath(scope.ctx, scope.scope, path, {});
  if (!found.ok) return { ok: false, result: bail(found.reason, found.snippet) };
  return { ok: true, ctx: scope.ctx, ref: found.ref };
}

// --- public API -------------------------------------------------------------

/**
 * Read a config source into the model the UI renders: the module's form plus, per
 * top-level key, whether its value is an editable data literal or read-only code.
 *
 * @param source The `denext.config.ts` source.
 * @returns The config model; `form: "unsupported"` with no keys when nothing was found.
 */
export async function readConfigModel(source: string): Promise<ConfigModel> {
  const found = await locateScope(source);
  if (!found) return { form: "unsupported", keys: {} };
  const { ctx, scope } = found;
  const slots = scope.obj ? objectSlots(ctx, scope.obj) : scope.named ?? new Map<string, Slot>();
  const keys: Record<string, ConfigKeyInfo> = {};
  for (const [name, slot] of slots) {
    const text = slice(ctx, startOf(ctx, slot.value), endOf(ctx, slot.value));
    const decoded = decodeLiteral(slot.value);
    keys[name] = decoded.ok
      ? { kind: "editable", text, value: decoded.value }
      : { kind: "readonly", text };
  }
  return { form: scope.form, keys };
}

/**
 * Set `path` to `value`, replacing only that value's byte span (or inserting the key,
 * creating any missing intermediate objects). Refuses — with the patch as a diff — when
 * the existing value is code rather than a data literal.
 *
 * @param source The `denext.config.ts` source.
 * @param path The key path, e.g. `["images", "domains"]`.
 * @param value The value to write; plain data only.
 * @returns The rewritten source plus a diff, or an honest refusal.
 */
export async function setConfigValue(
  source: string,
  path: string[],
  value: unknown,
): Promise<EditResult> {
  const at = await locatePath(source, path);
  if (!at.ok) return at.result;
  const { ctx, ref } = at;
  const outcome = setAt(ctx, ref, value, {});
  if (outcome.ok) return commit(source, ctx, outcome.edits, CONFIG_LABEL);
  const slot = ref.slot;
  const patch = slot
    ? diffOf(
      source,
      applyEdits(ctx.bytes, [replaceEdit(ctx, slot, (i, c) => renderValue(value, i, c, false))]),
      CONFIG_LABEL,
    )
    : undefined;
  return bail(outcome.reason, outcome.snippet, patch || undefined);
}

/**
 * Delete `path` — the property span plus its trailing comma and, when it owns the line,
 * the line itself.
 *
 * @param source The `denext.config.ts` source.
 * @param path The key path to remove.
 * @returns The rewritten source plus a diff, or an honest refusal.
 */
export async function deleteConfigValue(source: string, path: string[]): Promise<EditResult> {
  const at = await locatePath(source, path);
  if (!at.ok) return at.result;
  const { ctx, ref } = at;
  const { slot, parent } = ref;
  if (!slot) return bail(`\`${path.join(".")}\` is not set`, "");
  const edit = deleteEdit(ctx, slot, isLastMember(ctx, parent, slot));
  return commit(source, ctx, [edit], CONFIG_LABEL);
}

// --- array list editing -----------------------------------------------------

/** One original array element: its span, its separator tail, and its decoded value. */
interface ElementUnit {
  /** Byte offset of the element (its `...` for a spread). */
  start: number;
  /** Byte offset just past the element. */
  end: number;
  /** The element's source text, verbatim. */
  text: string;
  /** Everything up to the next element: the comma, whitespace and any comment riding along. */
  tail: string;
  /** The decoded value, when the element is data. */
  value?: unknown;
  /** Whether the element is a data literal (rather than a call, spread or identifier). */
  data: boolean;
}

/** The byte offset an array element starts at (`...x` starts at the dots). */
function elementStart(ctx: Ctx, el: Node): number {
  return el.spread ? el.spread.start - ctx.base : startOf(ctx, el.expression);
}

/** Split an array literal into per-element units; null when it has holes (`[, 1]`). */
function arrayUnits(ctx: Ctx, arr: Node): ElementUnit[] | null {
  const els: Node[] = arr.elements ?? [];
  const close = endOf(ctx, arr) - 1;
  const units: ElementUnit[] = [];
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    if (!el) return null;
    const start = elementStart(ctx, el);
    const end = endOf(ctx, el.expression);
    const next = i + 1 < els.length ? elementStart(ctx, els[i + 1]) : close;
    const decoded = el.spread ? NOT_DATA : decodeLiteral(el.expression);
    units.push({
      start,
      end,
      text: slice(ctx, start, end),
      tail: slice(ctx, end, next),
      data: decoded.ok,
      value: decoded.ok ? decoded.value : undefined,
    });
  }
  return units;
}

/**
 * An element rewritten with exactly one separator comma, keeping any comment that rode
 * with it. Null when the separator could not be identified safely (a comma hidden behind
 * a comment) — the caller bails rather than risk corrupting the file.
 */
function unitText(unit: ElementUnit): string | null {
  const lead = /^\s*,/.exec(unit.tail);
  if (lead) return `${unit.text},${rightTrim(unit.tail.slice(lead[0].length))}`;
  if (stripComments(unit.tail).includes(",")) return null;
  return `${unit.text},${rightTrim(unit.tail)}`;
}

/** An entry in the list being edited: a surviving original element, or a new value. */
type Item = { kind: "existing"; index: number } | { kind: "new"; value: unknown };

/** Apply one op in place; returns the reason it could not be applied, or null. */
function applyOp(items: Item[], op: ArrayOp): string | null {
  const ok = (i: number, max: number) => Number.isInteger(i) && i >= 0 && i <= max;
  switch (op.op) {
    case "insert":
      if (!ok(op.at, items.length)) return `insert index ${op.at} is out of range`;
      items.splice(op.at, 0, { kind: "new", value: op.value });
      return null;
    case "remove":
      if (!ok(op.at, items.length - 1)) return `remove index ${op.at} is out of range`;
      items.splice(op.at, 1);
      return null;
    case "update":
      if (!ok(op.at, items.length - 1)) return `update index ${op.at} is out of range`;
      items[op.at] = { kind: "new", value: op.value };
      return null;
    default: {
      if (!ok(op.from, items.length - 1) || !ok(op.to, items.length - 1)) {
        return `move ${op.from} → ${op.to} is out of range`;
      }
      const [moved] = items.splice(op.from, 1);
      items.splice(op.to, 0, moved);
      return null;
    }
  }
}

/** Run every op over a list of `count` existing elements. */
function applyOps(
  count: number,
  ops: ArrayOp[],
): { ok: true; items: Item[] } | { ok: false; reason: string } {
  const items: Item[] = Array.from({ length: count }, (_, index) => ({
    kind: "existing" as const,
    index,
  }));
  for (const op of ops) {
    const reason = applyOp(items, op);
    if (reason) return { ok: false, reason };
  }
  return { ok: true, items };
}

/** The array literal a value holds: direct, an arrow body, or a lone `return` in a body. */
function arrayLiteralOf(node: Node): Node | null {
  const n = unwrap(node);
  if (n.type === "ArrayExpression") return n;
  if (
    n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression" ||
    n.type === "MethodProperty"
  ) return literalFromBody(n.body, "ArrayExpression");
  return null;
}

/** Re-serialise the whole array (fast path: every element is data and no comment is at risk). */
function renderWholeArray(ctx: Ctx, arr: Node, items: Item[], units: ElementUnit[]): string {
  const values = items.map((it) => it.kind === "new" ? it.value : units[it.index].value);
  const start = startOf(ctx, arr);
  return renderValue(values, indentAt(ctx, start), columnAt(ctx, start), false);
}

/** Splice element-for-element, keeping every surviving element's bytes verbatim. */
function renderPreservedArray(
  ctx: Ctx,
  arr: Node,
  items: Item[],
  units: ElementUnit[],
): string | null {
  if (items.length === 0) return "[]";
  const start = startOf(ctx, arr);
  const arrIndent = indentAt(ctx, start);
  const elemIndent = `${arrIndent}  `;
  const parts: string[] = [];
  for (const it of items) {
    if (it.kind === "new") {
      parts.push(`${renderValue(it.value, elemIndent, elemIndent.length, false)},`);
      continue;
    }
    const text = unitText(units[it.index]);
    if (text === null) return null;
    parts.push(text);
  }
  const lead = units.length > 0 ? rightTrim(slice(ctx, start + 1, units[0].start)) : "";
  return `[${lead}\n${elemIndent}${parts.join(`\n${elemIndent}`)}\n${arrIndent}]`;
}

/** Rewrite an existing array literal under `ops`. */
function spliceArray(ctx: Ctx, source: string, arr: Node, ops: ArrayOp[]): EditResult {
  const units = arrayUnits(ctx, arr);
  if (!units) {
    return bail("the array has holes, which denext will not rewrite", snippetOf(ctx, arr));
  }
  const text = slice(ctx, startOf(ctx, arr), endOf(ctx, arr));
  const commented = stripComments(text) !== text;
  if (units.length === 0 && commented) {
    return bail("the empty array holds comments denext would lose", snippetOf(ctx, arr));
  }
  const applied = applyOps(units.length, ops);
  if (!applied.ok) return bail(applied.reason, snippetOf(ctx, arr));
  const next = !commented && units.every((u) => u.data)
    ? renderWholeArray(ctx, arr, applied.items, units)
    : renderPreservedArray(ctx, arr, applied.items, units);
  if (next === null) {
    return bail("an element separator could not be read safely", snippetOf(ctx, arr));
  }
  const edit: Edit = { start: startOf(ctx, arr), end: endOf(ctx, arr), text: next };
  return commit(source, ctx, [edit], CONFIG_LABEL);
}

/** Create a missing key as an array literal (optionally wrapped in `() => …`). */
function insertArray(
  ctx: Ctx,
  source: string,
  ref: PathRef,
  ops: ArrayOp[],
  opts: ArrayOpsOptions,
): EditResult {
  const applied = applyOps(0, ops);
  if (!applied.ok) return bail(applied.reason, "");
  const values = applied.items.map((it) => it.kind === "new" ? it.value : null);
  const wrap = opts.wrapper === "function";
  const render: Render = (indent, column) => {
    const body = renderValue(values, indent, wrap ? column + 6 : column, false);
    return wrap ? `() => ${body}` : body;
  };
  return commit(
    source,
    ctx,
    [ref.insert(ref.key, nestRender(ref.rest, render, false))],
    CONFIG_LABEL,
  );
}

/**
 * Apply list-editor operations to the array literal at `path` — `redirects`, `headers`,
 * `images.remotePatterns`, `i18n.locales` and friends.
 *
 * The array is found directly (`key: [ … ]`), through an arrow body (`key: () => [ … ]`)
 * or through a method's lone `return` (`key() { return [ … ]; }`). When every element is
 * a data literal and no comment is at risk the whole array is re-serialised; otherwise
 * elements are spliced individually so call expressions and comments survive byte for
 * byte. A missing key is created — as `key: () => [ … ]` when `opts.wrapper` is
 * `"function"`, else as `key: [ … ]`.
 *
 * @param source The `denext.config.ts` source.
 * @param path The key path of the array, e.g. `["redirects"]`.
 * @param ops The operations, applied in order against the evolving list.
 * @param opts How a missing key should be written.
 * @returns The rewritten source plus a diff, or an honest refusal.
 */
export async function applyArrayOps(
  source: string,
  path: string[],
  ops: ArrayOp[],
  opts: ArrayOpsOptions = {},
): Promise<EditResult> {
  const at = await locatePath(source, path);
  if (!at.ok) return at.result;
  const { ctx, ref } = at;
  if (!ref.slot) return insertArray(ctx, source, ref, ops, opts);
  const arr = arrayLiteralOf(ref.slot.value);
  if (!arr) {
    return bail(
      `\`${path.join(".")}\` is not an array literal (nor a function returning one)`,
      snippetOf(ctx, ref.slot.value),
    );
  }
  return spliceArray(ctx, source, arr, ops);
}
