// `denext_search_docs` retrieval: BM25 over the shipped docs corpus (./corpus.ts) — every
// docs-site guide section plus every API symbol. The index is built once, lazily, on the first
// search.
//
// Ranking. Guide sections and API symbols are scored in one BM25 index with field weights (the
// section heading / symbol name above the body; a section's page title as weaker context), then
// re-ranked: guide sections get a small boost (a how-to question is usually answered by prose,
// and a symbol's own page is one `denext_read_docs` away from the section that introduces it),
// and at most {@link PER_PAGE} sections of one page are kept so a long page cannot crowd out
// the rest.

import { Bm25, tokenize } from "./bm25.ts";
import { snippet } from "./snippet.ts";
import {
  chunkLabel,
  chunkRef,
  chunkUrl,
  type Corpus,
  type DocChunk,
  isGuide,
  loadCorpus,
} from "./corpus.ts";

/** One presented search result. */
export interface SearchHit {
  /** "Page › Section" for a guide section, the symbol name for an API symbol. */
  title: string;
  /** `guide`, or the API symbol kind (`function`, `interface`, …). */
  kind: string;
  /** The page slug (guide) or module (`denext/server`, API). */
  module: string;
  url: string;
  /** What to pass to `denext_read_docs` for the full text. */
  ref: string;
  snippet: string;
  score: number;
  denextOnly: boolean;
}

/** Which chunks a search considers. */
export type DocsKind = "guide" | "api" | "all";

/** Options for {@link searchDocs}. */
export interface SearchOptions {
  /** Max results (default 8). */
  limit?: number;
  /** `guide` (docs pages), `api` (symbols) or `all` (default). */
  kind?: DocsKind;
}

const HEADING_WEIGHT = 3;
const PAGE_TITLE_WEIGHT = 1.5;
const BODY_WEIGHT = 1;
/** Multiplier on a guide section's score (see the module comment). */
const GUIDE_BOOST = 1.25;
/** Multiplier on an API symbol whose name IS the query (`useApi` → the `useApi` symbol). */
const EXACT_NAME_BOOST = 1.6;
/** Multiplier on the Expo compat shims (`denext/expo/*`): drop-in surfaces, not denext's own API. */
const COMPAT_SHIM_FACTOR = 0.75;
/** Most sections of one page kept in a result list. */
const PER_PAGE = 3;
/** Candidates scored before filtering / re-ranking. */
const POOL = 400;

let index: Promise<{ idx: Bm25; corpus: Corpus }> | null = null;

/** The weighted fields one chunk is indexed under. */
function fieldsOf(corpus: Corpus, c: DocChunk) {
  if (!isGuide(c)) {
    return [{ text: c.title, weight: HEADING_WEIGHT }, { text: c.text, weight: BODY_WEIGHT }];
  }
  const page = corpus.pageBySlug.get(c.page!)?.title ?? "";
  const parent = corpus.parentOf.get(c.id)?.title ?? "";
  return [
    { text: c.title || page, weight: HEADING_WEIGHT },
    // The anchor often carries the page's topic word (`desktop-notifications` under
    // "Notifications and menus"), so it rides with the page title as context.
    { text: `${page} ${parent} ${c.anchor ?? ""}`, weight: PAGE_TITLE_WEIGHT },
    { text: c.text, weight: BODY_WEIGHT },
  ];
}

/** Build (once) and return the BM25 index over the corpus. */
function ensureIndex(): Promise<{ idx: Bm25; corpus: Corpus }> {
  index ??= loadCorpus().then((corpus) => {
    const idx = new Bm25();
    for (const c of corpus.chunks) idx.add(c.id, fieldsOf(corpus, c));
    return { idx, corpus };
  });
  return index;
}

/** Does `c` belong to the requested kind? */
function wanted(c: DocChunk, kind: DocsKind): boolean {
  return kind === "all" || (kind === "guide") === isGuide(c);
}

/** The re-rank multiplier for one chunk (see the constants above). */
function boostOf(c: DocChunk, query: string): number {
  if (isGuide(c)) return GUIDE_BOOST;
  let f = c.title.toLowerCase() === query.trim().toLowerCase() ? EXACT_NAME_BOOST : 1;
  if (c.module?.startsWith("denext/expo/")) f *= COMPAT_SHIM_FACTOR;
  return f;
}

/** Present one chunk as a hit. */
function toHit(corpus: Corpus, c: DocChunk, score: number, terms: string[]): SearchHit {
  const body = c.text.replace(/^#+ .*\n+/, "").replace(/\s+/g, " ");
  return {
    title: chunkLabel(corpus, c),
    kind: c.kind,
    module: isGuide(c) ? c.page! : c.module ?? "",
    url: chunkUrl(corpus, c),
    ref: chunkRef(c),
    snippet: snippet(body, terms),
    score,
    denextOnly: Boolean(c.denextOnly),
  };
}

/**
 * Search the denext docs (guide pages + API reference); the top hits, highest score first.
 *
 * @param query Keywords or a natural-language question.
 * @param opts `limit` (default 8) and `kind` (`guide` | `api` | `all`, default `all`).
 */
export async function searchDocs(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  const { idx, corpus } = await ensureIndex();
  const limit = Math.max(1, Math.floor(opts.limit ?? 8));
  const kind = opts.kind ?? "all";
  const terms = tokenize(query);
  const ranked = idx.search(query, POOL)
    .map((m) => ({ c: corpus.byId.get(m.id)!, score: m.score }))
    .filter(({ c }) => c && wanted(c, kind))
    .map(({ c, score }) => ({ c, score: score * boostOf(c, query) }))
    .sort((a, b) => b.score - a.score);
  const perPage = new Map<string, number>();
  const hits: SearchHit[] = [];
  for (const { c, score } of ranked) {
    if (isGuide(c)) {
      const n = perPage.get(c.page!) ?? 0;
      if (n >= PER_PAGE) continue;
      perPage.set(c.page!, n + 1);
    }
    hits.push(toHit(corpus, c, score, terms));
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Render hits as a readable text block for the MCP tool result. */
export function formatHits(hits: SearchHit[], query: string): string {
  if (hits.length === 0) {
    return `No denext docs matched "${query}". Try fewer or different keywords.`;
  }
  const lines = hits.map((h, i) => {
    const only = h.denextOnly ? " · denext-only" : "";
    const where = h.kind === "guide" ? "guide" : `${h.kind} · ${h.module}${only}`;
    return `${i + 1}. ${h.title}  [${where}]\n   read: ${h.ref}   ${h.url}\n   ${h.snippet}`;
  });
  return `${hits.length} result(s) for "${query}" — pass a \`read:\` ref to denext_read_docs ` +
    `for the full text:\n\n${lines.join("\n\n")}`;
}
