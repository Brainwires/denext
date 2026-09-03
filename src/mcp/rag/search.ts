// `denext_search_docs` retrieval: BM25 over the shipped docs corpus (src/mcp/docs-corpus.json).
// The corpus is a STATIC json import so it stays in the JSR module graph (offline, sync, no
// fetch). The index is built once, lazily, on first search.

import corpus from "../docs-corpus.json" with { type: "json" };
import { Bm25, type Match, tokenize } from "./bm25.ts";
import { snippet } from "./snippet.ts";

interface Chunk {
  id: string;
  kind: string;
  title: string;
  module: string;
  url: string;
  text: string;
  denextOnly: boolean;
}

/** One presented search result. */
export interface SearchHit {
  title: string;
  kind: string;
  module: string;
  url: string;
  snippet: string;
  score: number;
  denextOnly: boolean;
}

const TITLE_WEIGHT = 3;
const BODY_WEIGHT = 1;

const CHUNKS = corpus.chunks as Chunk[];

let index: Bm25 | null = null;
let byId: Map<string, Chunk> | null = null;

/** Build (once) and return the BM25 index + an id→chunk lookup. */
function ensureIndex(): { idx: Bm25; map: Map<string, Chunk> } {
  if (index && byId) return { idx: index, map: byId };
  const idx = new Bm25();
  const map = new Map<string, Chunk>();
  for (const c of CHUNKS) {
    idx.add(c.id, [{ text: c.title, weight: TITLE_WEIGHT }, { text: c.text, weight: BODY_WEIGHT }]);
    map.set(c.id, c);
  }
  index = idx;
  byId = map;
  return { idx, map };
}

/** Turn one BM25 match into a presented hit. */
function toHit(m: Match, map: Map<string, Chunk>, terms: string[]): SearchHit | null {
  const c = map.get(m.id);
  if (!c) return null;
  return {
    title: c.title,
    kind: c.kind,
    module: c.module,
    url: c.url,
    snippet: snippet(c.text, terms),
    score: m.score,
    denextOnly: c.denextOnly,
  };
}

/** Search the denext docs corpus; returns the top `limit` hits, highest score first. */
export function searchDocs(query: string, limit = 8): SearchHit[] {
  const { idx, map } = ensureIndex();
  const terms = tokenize(query);
  return idx.search(query, limit)
    .map((m) => toHit(m, map, terms))
    .filter((h): h is SearchHit => h !== null);
}

/** Render hits as a readable text block for the MCP tool result. */
export function formatHits(hits: SearchHit[], query: string): string {
  if (hits.length === 0) {
    return `No denext docs matched "${query}". Try fewer or different keywords.`;
  }
  const lines = hits.map((h, i) => {
    const only = h.denextOnly ? " · denext-only" : "";
    return `${i + 1}. ${h.title}  [${h.kind} · ${h.module}${only}]\n   ${h.url}\n   ${h.snippet}`;
  });
  return `${hits.length} result(s) for "${query}":\n\n${lines.join("\n\n")}`;
}
