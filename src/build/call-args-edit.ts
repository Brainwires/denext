// Comment-preserving editing of a plugin factory call's options in `denext.config.ts`.
//
// `injectPlugin`/`ejectPlugin` (`src/build/plugin-install.ts`) add and remove a zero-argument
// `factory()` call in the `plugins` array. This module edits the ARGUMENTS of a call that is
// already there — the project UI's plugin-options panel writes `openapi({ info: { … } })`
// through it. It is the same swc-AST splice as `config-edit.ts`, whose config locator, value
// serialiser and object-splice primitives it reuses: only the argument list's interior (for a
// zero-argument call) or one option's span is replaced, every other byte stays where it is,
// and a call shape the writer cannot edit safely is an honest {@linkcode EditResult} refusal.
// {@linkcode readCallArguments} is the read half: the same locator and the same refusals, so a
// call the panel can show is exactly a call the writer can edit.

import {
  bail,
  columnAt,
  commit,
  CONFIG_LABEL,
  type EditResult,
  indentAt,
  objectDeleteEdits,
  objectSetEdits,
  objectSlots,
  readConfigModel,
  renderValue,
  scopeOf,
  scopeSlot,
  snippetOf,
  type SpliceOutcome,
  unwrap,
} from "./config-edit.ts";
import { applyEdits, type Ctx, type Edit, endOf, type Node, startOf, txt } from "./swc-ast.ts";

/** Columns reserved after an inserted options object for the `)` and `]` that close it. */
const CLOSERS = 2;

// --- public types -----------------------------------------------------------

/** Which factory call {@linkcode setCallArguments} edits: `<arrayKey>: [ …, <callee>(…), … ]`. */
export interface CallTarget {
  /** The config key holding the array of factory calls. */
  arrayKey: "plugins";
  /** The factory's local binding — `openapi` for `openapi({ … })`. */
  callee: string;
}

/** One option write: `value` at `path` inside the call's options object. */
export interface CallArgSet {
  /** The key path inside the options object, e.g. `["info", "title"]` (at least one segment). */
  path: string[];
  /** The value to write (plain data), or `undefined` to delete the key. */
  value: unknown | undefined;
}

/** What {@linkcode readCallArguments} found in a factory call's options object. */
export type CallArgsRead =
  | {
    ok: true;
    /** Every option whose value is a data literal, decoded. */
    values: Record<string, unknown>;
    /** Options whose value is code (a function, a variable, a call), in source order. */
    codeKeys: string[];
    /** The verbatim source of each code-valued option, keyed like {@linkcode codeKeys}. */
    codeText: Record<string, string>;
  }
  | { ok: false; reason: string; snippet?: string };

// --- locating the call ------------------------------------------------------

/** The one matching call, with its options object (null for a zero-argument call). */
interface FoundCall {
  ctx: Ctx;
  call: Node;
  obj: Node | null;
}

/** A located call, or the refusal to hand back. */
type Located = ({ ok: true } & FoundCall) | { ok: false; result: EditResult };

/** A refusal in the {@linkcode Located} shape. */
function refuse(reason: string, snippet: string): { ok: false; result: EditResult } {
  return { ok: false, result: bail(reason, snippet) };
}

/** How a callee relates to the factory name: called directly, through a member, or not at all. */
function calleeKind(node: Node, name: string): "direct" | "member" | null {
  const callee = unwrap(node);
  if (callee.type === "Identifier") return callee.value === name ? "direct" : null;
  const prop = callee.type === "MemberExpression" ? callee.property : null;
  return prop?.type === "Identifier" && prop.value === name ? "member" : null;
}

/** The single `callee(…)` element of an array literal, or why there is not exactly one. */
function pickCall(
  ctx: Ctx,
  arr: Node,
  target: CallTarget,
): { ok: true; call: Node } | { ok: false; result: EditResult } {
  const direct: Node[] = [];
  const member: Node[] = [];
  for (const el of arr.elements ?? []) {
    const call = el && !el.spread ? unwrap(el.expression) : null;
    if (call?.type !== "CallExpression") continue;
    const kind = calleeKind(call.callee, target.callee);
    if (kind === "direct") direct.push(call);
    else if (kind === "member") member.push(call);
  }
  const name = `\`${target.callee}(…)\``;
  if (direct.length === 1) return { ok: true, call: direct[0] };
  if (direct.length > 1) {
    return refuse(
      `${name} appears ${direct.length} times in \`${target.arrayKey}\` — ambiguous, denext will not guess`,
      direct.map((c) => snippetOf(ctx, c)).join("\n"),
    );
  }
  if (member.length > 0) {
    return refuse(
      `${name} is called through a member expression — denext edits only a direct call`,
      snippetOf(ctx, member[0]),
    );
  }
  return refuse(`plugin call not found: no ${name} in \`${target.arrayKey}\``, snippetOf(ctx, arr));
}

/** Pair a call with its options object, or refuse an argument list denext cannot rewrite. */
function withOptions(ctx: Ctx, call: Node): Located {
  const args: Node[] = call.arguments ?? [];
  if (args.length === 0) return { ok: true, ctx, call, obj: null };
  const quote = snippetOf(ctx, call);
  if (args.length > 1) {
    return refuse(
      `the call passes ${args.length} arguments — denext edits one options object`,
      quote,
    );
  }
  if (args[0].spread) {
    return refuse("the call spreads its arguments — denext will not rewrite them", quote);
  }
  const obj = unwrap(args[0].expression);
  if (obj.type !== "ObjectExpression") {
    return refuse(
      "the call's argument is not an object literal — a variable or call is code denext will not rewrite",
      quote,
    );
  }
  if ((obj.properties ?? []).some((p: Node) => p.type === "SpreadElement")) {
    return refuse("the options object spreads another object — denext will not rewrite it", quote);
  }
  return { ok: true, ctx, call, obj };
}

/** Parse a config source and locate the one `target` call in its array. */
async function locateCall(source: string, target: CallTarget): Promise<Located> {
  const scope = await scopeOf(source);
  if (!scope.ok) return scope;
  const { ctx } = scope;
  const slot = scopeSlot(ctx, scope.scope, target.arrayKey);
  if (!slot) return refuse(`plugin call not found: \`${target.arrayKey}\` is not set`, "");
  const arr = unwrap(slot.value);
  if (arr.type !== "ArrayExpression") {
    return refuse(
      `\`${target.arrayKey}\` is not an array literal — denext will not edit calls it cannot see`,
      snippetOf(ctx, slot.value),
    );
  }
  const picked = pickCall(ctx, arr, target);
  return picked.ok ? withOptions(ctx, picked.call) : picked;
}

// --- a zero-argument call ---------------------------------------------------

/** A plain object with no prototype, so a `__proto__` key stays an ordinary member. */
type Bag = Record<string, unknown>;

/** Whether `value` is a plain object (not an array, not null). */
function isBag(value: unknown): value is Bag {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every defined set merged into one options value (`undefined` — a delete — has nothing to delete). */
function mergeSets(sets: CallArgSet[]): Bag {
  const out: Bag = Object.create(null);
  for (const { path, value } of sets) {
    if (value === undefined) continue;
    let node = out;
    for (const key of path.slice(0, -1)) {
      const child = node[key];
      const next: Bag = Object.assign(Object.create(null), isBag(child) ? child : {});
      node[key] = next;
      node = next;
    }
    node[path[path.length - 1]] = value;
  }
  return out;
}

/** A whitespace byte (space, tab, CR, LF). */
function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/** The offset just past the `(` when only whitespace sits between it and `close`, else null. */
function blankParenStart(ctx: Ctx, close: number): number | null {
  let i = close;
  while (i > 0 && isSpace(ctx.bytes[i - 1])) i--;
  return i > 0 && ctx.bytes[i - 1] === 0x28 ? i : null;
}

/**
 * The edit that gives a zero-argument call its options object — rendered at the call's
 * indent, on one line while it fits deno fmt's width. A comment inside the empty argument
 * list stays: the object is inserted after it.
 */
function insertOptions(ctx: Ctx, call: Node, sets: CallArgSet[]): Edit[] {
  const value = mergeSets(sets);
  if (Object.keys(value).length === 0) return [];
  const close = endOf(ctx, call) - 1;
  const start = blankParenStart(ctx, close) ?? close;
  const indent = indentAt(ctx, startOf(ctx, call));
  const text = renderValue(value, indent, columnAt(ctx, start) + CLOSERS, false);
  return [{ start, end: close, text }];
}

// --- an existing options object ---------------------------------------------

/** Whether `path` names nothing in `obj` (an absent key, or an absent parent object). */
function isAbsent(ctx: Ctx, obj: Node, path: string[]): boolean {
  let node = obj;
  for (const key of path) {
    const o = unwrap(node);
    if (o.type !== "ObjectExpression") return false; // not an object: let the splice refuse
    const slot = objectSlots(ctx, o).get(key);
    if (!slot) return true;
    node = slot.value;
  }
  return false;
}

/** The edits for one set against the options object (deleting an absent key is a no-op). */
function optionEdits(ctx: Ctx, obj: Node, set: CallArgSet): SpliceOutcome {
  if (set.value !== undefined) return objectSetEdits(ctx, obj, set.path, set.value);
  if (isAbsent(ctx, obj, set.path)) return { ok: true, edits: [] };
  return objectDeleteEdits(ctx, obj, set.path);
}

/**
 * Apply the sets one at a time — splice, re-parse, re-locate — so two sets that touch the
 * same object never produce overlapping edits; the last splice is committed against the
 * original source, so the diff covers every set.
 */
async function setEach(
  source: string,
  target: CallTarget,
  sets: CallArgSet[],
  first: FoundCall & { obj: Node },
): Promise<EditResult> {
  let { ctx, obj } = first;
  let edits: Edit[] = [];
  for (let i = 0; i < sets.length; i++) {
    if (i > 0) {
      const next = await locateCall(applyEdits(ctx.bytes, edits), target);
      if (!next.ok) return next.result;
      if (!next.obj) {
        return bail("the options object vanished mid-edit", snippetOf(next.ctx, next.call));
      }
      ({ ctx, obj } = next);
    }
    const outcome = optionEdits(ctx, obj, sets[i]);
    if (!outcome.ok) return bail(outcome.reason, outcome.snippet);
    edits = outcome.edits;
  }
  return await commit(source, ctx, edits, CONFIG_LABEL);
}

// --- public API -------------------------------------------------------------

/**
 * Write options into a factory call in the config's `plugins` array — `openapi()` becomes
 * `openapi({ info: { title: "API" } })`, and an existing `openapi({ … })` has single keys set,
 * updated or deleted in place, comments and code around them untouched.
 *
 * The config object is found the way {@linkcode setConfigValue} finds it (default-export
 * literal, `defineConfig({ … })`, a factory returning a literal, or named exports). A
 * zero-argument call gains one rendered object literal holding every defined set; a call
 * with one object-literal argument has each set spliced into it (a nested path creates the
 * missing intermediate objects; `value: undefined` deletes, and deleting an absent key is a
 * no-op). Refuses — `ok: false` with the call's source as the snippet — when:
 *
 * - `plugins` is unset, or is not an array literal (a variable, a function);
 * - no element is a direct `callee(…)` call ("plugin call not found"), or two are ("ambiguous");
 * - the only match is a member call (`x.openapi()`);
 * - the call passes more than one argument, spreads its arguments, passes a non-literal
 *   (a variable or call), or its object spreads another object;
 * - a set would overwrite a code-valued option (`transform: (d) => d`) or write through one
 *   that is not an object literal — exactly as {@linkcode setConfigValue} refuses;
 * - any set has an empty path.
 *
 * Sets apply atomically: one refusal means nothing is written. The result is re-parsed
 * before it is returned.
 *
 * @param source The `denext.config.ts` source.
 * @param target Which call to edit: the array's key and the factory's local name.
 * @param sets The option writes, applied in order.
 * @returns The rewritten source plus a diff (empty when nothing changed), or an honest refusal.
 */
export async function setCallArguments(
  source: string,
  target: CallTarget,
  sets: CallArgSet[],
): Promise<EditResult> {
  if (sets.some((s) => s.path.length === 0)) return bail("an empty key path cannot be edited", "");
  const found = await locateCall(source, target);
  if (!found.ok) return found.result;
  const { ctx, call, obj } = found;
  if (!obj) return await commit(source, ctx, insertOptions(ctx, call, sets), CONFIG_LABEL);
  return await setEach(source, target, sets, { ctx, call, obj });
}

/**
 * Read the options a factory call in the config's `plugins` array is given — the read half of
 * {@linkcode setCallArguments}, with the same locator and the same refusals (no `plugins` array
 * literal, no direct call or an ambiguous one, a member callee, spread or non-literal
 * arguments, a spreading options object), so a call this reads is a call the writer can edit.
 *
 * A zero-argument call reads as `{}`. Each top-level option whose value is a data literal
 * (string, number, boolean, null, and arrays/objects of those) is decoded into `values`; any
 * other value — a function, a thunk, an identifier, a call, a template literal — is code the
 * writer will not regenerate, so it is listed in `codeKeys` with its source in `codeText`.
 *
 * @param source The `denext.config.ts` source.
 * @param target Which call to read: the array's key and the factory's local name.
 * @returns The decoded options and the code-valued keys, or an honest refusal.
 */
export async function readCallArguments(
  source: string,
  target: CallTarget,
): Promise<CallArgsRead> {
  const found = await locateCall(source, target);
  if (!found.ok) {
    const result = found.result;
    return result.ok
      ? { ok: false, reason: "the call could not be read" }
      : { ok: false, reason: result.reason, snippet: result.snippet };
  }
  const values: Record<string, unknown> = {};
  const codeKeys: string[] = [];
  const codeText: Record<string, string> = {};
  // The options object, re-read as a config object: `readConfigModel` already knows which
  // members are data literals and which are code, with the same decoder `setConfigValue` uses.
  const text = found.obj ? txt(found.ctx, found.obj) : "{}";
  const model = await readConfigModel(`export default ${text};\n`);
  for (const [key, info] of Object.entries(model.keys)) {
    if (info.kind === "editable" && info.wrapper === undefined) values[key] = info.value;
    else {
      codeKeys.push(key);
      codeText[key] = info.text;
    }
  }
  return { ok: true, values, codeKeys, codeText };
}
