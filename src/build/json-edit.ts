// Comment-preserving value splicing for `deno.json` / `deno.jsonc`.
//
// A denext project's `deno.json` is hand-authored: it carries comments, a deliberate key
// order and (for a migrated app) the leading `"//"` sentinel key that marks it generated.
// Rewriting it through `JSON.parse` → `JSON.stringify` would silently destroy all three,
// so this module edits it the same way {@linkcode ./config-edit.ts | config-edit} edits
// `denext.config.ts`: a JSONC document is a JavaScript object literal, so it is parsed
// with the same swc pass (wrapped in parentheses to make it an expression) and only the
// bytes of the targeted value are replaced.
//
// Reading goes through `@std/jsonc`, which understands comments and trailing commas.

import { parse as parseJsonc } from "@std/jsonc";
import { applyEdits, type Ctx, type Node, parseModule } from "./swc-ast.ts";
import {
  type EditResult,
  objectDeleteEdits,
  objectSetEdits,
  type SpliceOutcome,
} from "./config-edit.ts";
import { createUnifiedDiff } from "./patch-diff.ts";

/** The file name diffs are labelled with. */
const LABEL = "deno.json";
/** How much offending source a bail quotes back. */
const SNIPPET_MAX = 200;

/**
 * Parse JSON **or** JSONC (comments and trailing commas allowed) into a plain value.
 *
 * @param source The file's text.
 * @returns The parsed value.
 * @throws {SyntaxError} When the text is not valid JSONC.
 */
export function readJson(source: string): unknown {
  return parseJsonc(source);
}

/** The parsed document: the byte context plus the root object literal. */
interface Document {
  ctx: Ctx;
  root: Node;
}

/**
 * Parse a JSONC document as a parenthesised object expression, so swc's spans line up
 * with the original text (offset by the single `(` byte, which is stripped again on the
 * way out).
 */
async function parseDocument(source: string): Promise<Document | null> {
  const parsed = await parseModule(`(${source})`);
  const item = parsed?.body[0];
  if (!item || item.type !== "ExpressionStatement") return null;
  const root = item.expression?.expression;
  return root?.type === "ObjectExpression" ? { ctx: parsed.ctx, root } : null;
}

/** Apply a splice outcome to the wrapped source, unwrapping the parentheses again. */
function finish(source: string, doc: Document, outcome: SpliceOutcome): EditResult {
  if (!outcome.ok) return { ok: false, reason: outcome.reason, snippet: outcome.snippet };
  const next = applyEdits(doc.ctx.bytes, outcome.edits).slice(1, -1);
  return {
    ok: true,
    source: next,
    diff: createUnifiedDiff(source, next, `a/${LABEL}`, `b/${LABEL}`),
  };
}

/** Run `splice` against the document's root object, or bail when it cannot be parsed. */
async function edit(
  source: string,
  splice: (doc: Document) => SpliceOutcome,
): Promise<EditResult> {
  const doc = await parseDocument(source);
  if (!doc) {
    return {
      ok: false,
      reason: "the file is not a JSON object document",
      snippet: source.slice(0, SNIPPET_MAX),
    };
  }
  return finish(source, doc, splice(doc));
}

/**
 * Set `path` to `value`, replacing only that value's bytes (or inserting the key, and any
 * missing intermediate objects, at the end of its parent). Comments, key order — the
 * leading `"//"` sentinel key included — and the file's own formatting all survive.
 *
 * @param source The `deno.json` / `deno.jsonc` text.
 * @param path The key path, e.g. `["tasks", "dev"]`.
 * @param value The value to write; plain JSON data only.
 * @returns The rewritten text plus a diff, or an honest refusal.
 */
export function setJsonValue(source: string, path: string[], value: unknown): Promise<EditResult> {
  return edit(source, (doc) => objectSetEdits(doc.ctx, doc.root, path, value, { json: true }));
}

/**
 * Delete `path` — the member, its trailing comma and, when it owns the line, the line.
 *
 * @param source The `deno.json` / `deno.jsonc` text.
 * @param path The key path to remove.
 * @returns The rewritten text plus a diff, or an honest refusal.
 */
export function deleteJsonValue(source: string, path: string[]): Promise<EditResult> {
  return edit(source, (doc) => objectDeleteEdits(doc.ctx, doc.root, path));
}
