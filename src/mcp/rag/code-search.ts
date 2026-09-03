// The query layer over a project's `CodeIndex`: lexical search, definition lookup, and
// reference scan — the read side of `denext_query_codebase` / `find_definition` /
// `find_references`. BM25 (from bm25.ts) ranks free-text queries; regex scans answer the
// symbol lookups (fast, no subprocess, and they find non-exported code `deno doc` would miss).

import { Bm25, type Match, tokenize } from "./bm25.ts";
import { type CodeChunk, type CodeIndex, ensureCodeIndex } from "./codebase.ts";
import { snippet } from "./snippet.ts";

const SNIPPET_LEN = 200;
const DEFAULT_LIMIT = 8;
const REF_LIMIT = 50;
/** A valid JS/TS identifier — guards the regex scans against injection. */
const IDENT = /^[A-Za-z_$][\w$]*$/;

// ---------- shared presentation ----------

/** One free-text search hit. */
export interface CodeHit {
  file: string;
  startLine: number;
  snippet: string;
  score: number;
}

/** One symbol location (a definition or a reference). */
export interface CodeSite {
  file: string;
  line: number;
  snippet: string;
}

/** A single source line trimmed for display. */
function lineSnippet(line: string): string {
  const t = line.trim();
  return t.length > SNIPPET_LEN ? t.slice(0, SNIPPET_LEN) + "…" : t;
}

// ---------- free-text search ----------

/** Search the project's code for chunks relevant to `query` (BM25, highest score first). */
export async function queryCodebase(
  dir: string,
  query: string,
  limit = DEFAULT_LIMIT,
): Promise<CodeHit[]> {
  const idx = await ensureCodeIndex(dir);
  const bm = new Bm25();
  const byId = new Map<string, CodeChunk>();
  for (const c of idx.chunks) {
    bm.add(c.id, [{ text: c.text, weight: 1 }]);
    byId.set(c.id, c);
  }
  const terms = tokenize(query);
  return bm.search(query, limit)
    .map((m: Match) => toHit(m, byId, terms))
    .filter((h): h is CodeHit => h !== null);
}

/** Turn one BM25 match into a presented hit. */
function toHit(m: Match, byId: Map<string, CodeChunk>, terms: string[]): CodeHit | null {
  const c = byId.get(m.id);
  if (!c) return null;
  return { file: c.file, startLine: c.startLine, snippet: snippet(c.text, terms), score: m.score };
}

// ---------- symbol scans ----------

/** Scan every chunk line-by-line for `re`, returning the matched sites (up to `cap`). */
function scan(index: CodeIndex, re: RegExp, cap: number): { sites: CodeSite[]; total: number } {
  const sites: CodeSite[] = [];
  let total = 0;
  for (const c of index.chunks) {
    const lines = c.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      total++;
      if (sites.length < cap) {
        sites.push({ file: c.file, line: c.startLine + i, snippet: lineSnippet(lines[i]) });
      }
    }
  }
  return { sites, total };
}

/** A declaration matcher for `symbol` (function/class/const/let/var/type/interface/enum). */
function declRe(symbol: string): RegExp {
  return new RegExp(
    `\\b(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:abstract\\s+)?` +
      `(?:function\\*?|class|const|let|var|type|interface|enum)\\s+${symbol}\\b`,
  );
}

/** Find where `symbol` is declared. Exported declarations are ranked first. */
export async function findDefinition(dir: string, symbol: string): Promise<CodeSite[]> {
  if (!IDENT.test(symbol)) return [];
  const idx = await ensureCodeIndex(dir);
  const { sites } = scan(idx, declRe(symbol), 100);
  return sites.sort((a, b) => rankExport(b) - rankExport(a));
}

/** 1 when a declaration snippet begins with `export`, else 0 (used to float exports up). */
function rankExport(site: CodeSite): number {
  return site.snippet.startsWith("export") ? 1 : 0;
}

/** Find usages of `symbol` (word-boundary matches, capped). Includes declaration sites. */
export async function findReferences(
  dir: string,
  symbol: string,
  limit = REF_LIMIT,
): Promise<{ sites: CodeSite[]; total: number }> {
  if (!IDENT.test(symbol)) return { sites: [], total: 0 };
  const idx = await ensureCodeIndex(dir);
  return scan(idx, new RegExp(`\\b${symbol}\\b`), limit);
}

// ---------- formatting ----------

/** Render free-text hits as a readable text block. */
export function formatCodeHits(hits: CodeHit[], query: string): string {
  if (hits.length === 0) return `No code matched "${query}". Try different or fewer keywords.`;
  const lines = hits.map((h, i) => `${i + 1}. ${h.file}:${h.startLine}\n   ${h.snippet}`);
  return `${hits.length} result(s) for "${query}":\n\n${lines.join("\n\n")}`;
}

/** Render definition sites. */
export function formatDefs(sites: CodeSite[], symbol: string): string {
  if (sites.length === 0) {
    return `No definition found for \`${symbol}\`. It may be imported from a dependency, or ` +
      `declared in a form the scanner doesn't recognize.`;
  }
  const lines = sites.map((s) => `  ${s.file}:${s.line}\n    ${s.snippet}`);
  return `${sites.length} definition(s) of \`${symbol}\`:\n${lines.join("\n")}`;
}

/** Render reference sites with a truncation note when capped. */
export function formatRefs(result: { sites: CodeSite[]; total: number }, symbol: string): string {
  const { sites, total } = result;
  if (total === 0) return `No references to \`${symbol}\` found in the project.`;
  const shown = sites.length < total ? ` (showing first ${sites.length})` : "";
  const lines = sites.map((s) => `  ${s.file}:${s.line}  ${s.snippet}`);
  return `${total} reference(s) to \`${symbol}\`${shown}:\n${lines.join("\n")}`;
}
