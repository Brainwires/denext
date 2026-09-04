// Shared swc (@swc/wasm-web) AST primitives for denext's build-time source
// transforms (the auto-memo compiler and the `"use cache"` rewrite).
//
// denext owns no transpile hook — `deno bundle` runs swc internally — so a
// build-time pass that needs to *rewrite* user source parses it with the vendored
// `@swc/wasm-web` and splices edits back in **byte space** (swc spans are UTF-8
// byte offsets, which differ from JS string indices whenever the source has
// multi-byte characters). These helpers are the shared substrate: parse once,
// walk the AST, and apply non-overlapping byte-offset edits.

import { ensureDir } from "@std/fs";
import { join, toFileUrl } from "@std/path";

// deno-lint-ignore no-explicit-any -- swc's AST is an untyped node graph.
export type Node = any;

let swcReady: Promise<(src: string) => Promise<Node>> | null = null;

/**
 * Initialize `@swc/wasm-web` once (process-wide) and return a bound `parse` that
 * accepts TSX source. The wasm module is loaded and initialized lazily on first
 * use and the resulting parser is memoized.
 */
export function swcParse(): Promise<(src: string) => Promise<Node>> {
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

/** A source edit: replace `[start, end)` with `text` (insert when start === end). */
export interface Edit {
  start: number;
  end: number;
  text: string;
  /**
   * Tiebreak for two insertions at the same `start` (lower emits first). Lets a
   * caller force, e.g., an injected `import` to precede a wrapper prefix inserted
   * at the same offset. Defaults to 0.
   */
  order?: number;
}

export const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Apply non-overlapping edits whose offsets are UTF-8 *byte* positions (swc spans
 * are byte offsets, which differ from JS string indices whenever the source has
 * multi-byte characters). Splicing happens in byte space, then decodes back.
 */
export function applyEdits(bytes: Uint8Array, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || (a.order ?? 0) - (b.order ?? 0));
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
export function collectPatternNames(pat: Node, out: Set<string>): void {
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
export function walkAst(node: Node, visit: (n: Node) => void): void {
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

/**
 * The per-module transform context: source text (as bytes) and the span base
 * offset swc reports (span offsets are relative to it).
 *
 * swc reports UTF-8 byte offsets against a per-parse base, but `Module.span` skips
 * leading comments — so it is not a reliable base. Callers prepend a marker token
 * (see {@link MARKER}) so the first AST node sits at byte 0 of the parsed text,
 * giving an exact base regardless of leading trivia.
 */
export interface Ctx {
  bytes: Uint8Array;
  base: number;
}

/** A marker token prepended before parsing so the first real node sits at byte 0. */
export const MARKER = "0;\n";
/** Byte length of {@link MARKER} (ASCII: bytes === chars). */
const MARKER_LEN = MARKER.length;

/** The original-source text of a node (its span, mapped back through the base). */
export const txt = (ctx: Ctx, n: Node): string =>
  decoder.decode(ctx.bytes.subarray(n.span.start - ctx.base, n.span.end - ctx.base));

/** The start byte offset of a node in the original source. */
export const startOf = (ctx: Ctx, n: Node): number => n.span.start - ctx.base;

/** The end byte offset of a node in the original source. */
export const endOf = (ctx: Ctx, n: Node): number => n.span.end - ctx.base;

/** A parsed module: the byte-offset context and its top-level items (the marker dropped). */
export interface ParsedModule {
  ctx: Ctx;
  body: Node[];
}

/**
 * Parse `source` with {@link MARKER} prepended so offsets have an exact base regardless
 * of leading trivia. Returns null for an unparseable or empty module (callers return the
 * source unchanged).
 */
export async function parseModule(source: string): Promise<ParsedModule | null> {
  const parse = await swcParse();
  let ast: Node;
  try {
    ast = await parse(MARKER + source);
  } catch {
    return null;
  }
  if (!ast.body || ast.body.length === 0) return null;
  const base = ast.body[0].span.start; // the marker sits at parsed byte 0
  return {
    ctx: { bytes: encoder.encode(source), base: base + MARKER_LEN },
    body: ast.body.slice(1),
  };
}

/**
 * The byte offset just after the leading directive prologue (`"use client";`, `"use
 * strict";` …) — where an injected `import` belongs so it never precedes a directive.
 */
export function prologueEnd(ctx: Ctx, body: Node[]): number {
  let at = 0;
  for (const item of body) {
    if (item.type !== "ExpressionStatement" || item.expression?.type !== "StringLiteral") break;
    at = endOf(ctx, item);
  }
  return at;
}

const SPAN_ONLY: ReadonlySet<string> = new Set(["span"]);

/** Invoke `fn` on every child node of `node` (array members included), skipping `skip` keys. */
export function forEachChild(
  node: Node,
  fn: (child: Node) => void,
  skip: ReadonlySet<string> = SPAN_ONLY,
): void {
  for (const key of Object.keys(node)) {
    if (skip.has(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c === "object") fn(c);
    } else if (v && typeof v === "object") {
      fn(v);
    }
  }
}

/** A `./` or `../` specifier. */
export function isRelativeSpecifier(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../");
}

/**
 * Rewrite the module's relative import/export specifiers to absolute URLs (mapped through
 * `resolve`), as edits — a transformed module lives in a temp dir, so relative paths would
 * otherwise break. Returns whether any specifier was rewritten.
 */
export function absolutizeSpecifiers(
  ctx: Ctx,
  body: Node[],
  moduleUrl: string,
  edits: Edit[],
  resolve: (absUrl: string) => string = (u) => u,
): boolean {
  let any = false;
  for (const item of body) {
    const src = item.source;
    if (src?.type !== "StringLiteral" || !isRelativeSpecifier(src.value as string)) continue;
    const abs = new URL(src.value as string, moduleUrl).href;
    edits.push({
      start: startOf(ctx, src),
      end: endOf(ctx, src),
      text: JSON.stringify(resolve(abs)),
    });
    any = true;
  }
  return any;
}

/** Deterministic short filename for a transformed module URL (djb2 of the URL). */
function hashedModuleFileName(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) >>> 0;
  return `m_${h.toString(36)}.tsx`;
}

/**
 * Run `transform` over each source file, writing the changed modules into `dir` and
 * returning an import-map of `original file URL → transformed file URL`. Unreadable or
 * failing modules are left untouched (omitted); so are unchanged ones.
 */
export async function writeTransformedModules(
  files: string[],
  dir: string,
  transform: (source: string, url: string) => Promise<{ code: string; changed: boolean }>,
): Promise<Record<string, string>> {
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
      result = await transform(source, url);
    } catch {
      continue; // any failure → leave the original module untouched
    }
    if (!result.changed) continue;
    const out = join(dir, hashedModuleFileName(url));
    await Deno.writeTextFile(out, result.code);
    map[url] = toFileUrl(out).href;
  }
  return map;
}
