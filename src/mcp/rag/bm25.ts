// A tiny, dependency-free BM25 lexical index — the retrieval engine behind
// `denext_search_docs`. Pure TypeScript (no npm, no model, offline), so it ships in the
// zero-npm package and runs in-process. `Retriever` is the seam: a future embeddings
// retriever implements the same shape and callers don't change.

/** One ranked hit: the document id and its relevance score. */
export interface Match {
  id: string;
  score: number;
}

/** The pluggable retrieval seam. BM25 today; a vector retriever could implement it later. */
export interface Retriever {
  search(query: string, k: number): Match[];
}

/** One weighted field of a document (e.g. a title weighted above the body). */
export interface Field {
  text: string;
  weight: number;
}

const K1 = 1.5;
const B = 0.75;
const MIN_LEN = 2;

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "is",
  "it",
  "for",
  "with",
  "on",
  "at",
  "by",
  "as",
  "be",
  "are",
  "this",
  "that",
  "from",
  "you",
  "your",
  "how",
  "do",
  "i",
  "can",
  "if",
  "so",
  "its",
  "into",
  "when",
  "then",
  "not",
  "no",
]);

// ---------- tokenizer ----------

/** Maximal `[A-Za-z0-9_]` runs, case preserved (so camelCase can be split next). */
function rawWords(text: string): string[] {
  return text.match(/[A-Za-z0-9_]+/g) ?? [];
}

/** `getSession`/`HTTPServer`/`use_cache` → their component words (case preserved). */
function splitCompound(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[_\s]+/)
    .filter(Boolean);
}

/** The whole word plus its component parts, all lower-cased and de-duplicated. */
function expand(word: string): string[] {
  const parts = splitCompound(word).map((p) => p.toLowerCase());
  return [...new Set([word.toLowerCase(), ...parts])];
}

/** Keep terms that carry signal: long enough and not a stopword. */
function keep(term: string): boolean {
  return term.length >= MIN_LEN && !STOPWORDS.has(term);
}

/** Split text into search terms (camelCase/snake-aware, stopwords dropped). */
export function tokenize(text: string): string[] {
  return rawWords(text).flatMap(expand).filter(keep);
}

// ---------- scoring ----------

/** Inverse document frequency (BM25's probabilistic idf, always positive here). */
function idf(n: number, df: number): number {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

/** One term's BM25 contribution for a document. */
function termScore(tf: number, len: number, avgdl: number, w: number): number {
  return w * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * len) / avgdl)));
}

/** Sum a numeric iterable. */
function sum(nums: Iterable<number>): number {
  let total = 0;
  for (const n of nums) total += n;
  return total;
}

/** Field-weighted term frequencies for one document (weight baked into the tf). */
function weighTokens(fields: Field[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const f of fields) {
    for (const term of tokenize(f.text)) tf.set(term, (tf.get(term) ?? 0) + f.weight);
  }
  return tf;
}

// ---------- index ----------

export class Bm25 implements Retriever {
  private ids: string[] = [];
  private lens: number[] = [];
  private df = new Map<string, number>();
  private postings = new Map<string, Map<number, number>>();
  private totalLen = 0;

  /** Average document length (guarded against an empty index). */
  private get avgdl(): number {
    return this.ids.length ? this.totalLen / this.ids.length : 1;
  }

  /** Add a document identified by `id`, built from weighted fields. */
  add(id: string, fields: Field[]): void {
    const tf = weighTokens(fields);
    const docIdx = this.ids.push(id) - 1;
    this.lens[docIdx] = sum(tf.values());
    this.totalLen += this.lens[docIdx];
    this.register(docIdx, tf);
  }

  /** Record one document's term frequencies into the postings + document frequencies. */
  private register(docIdx: number, tf: Map<string, number>): void {
    for (const [term, freq] of tf) {
      let posting = this.postings.get(term);
      if (!posting) this.postings.set(term, posting = new Map());
      posting.set(docIdx, freq);
      this.df.set(term, (this.df.get(term) ?? 0) + 1);
    }
  }

  /** Rank documents against `query`, returning the top `k` by BM25 score. */
  search(query: string, k: number): Match[] {
    const scores = new Map<number, number>();
    for (const term of new Set(tokenize(query))) this.accumulate(term, scores);
    return this.rank(scores, k);
  }

  /** Add one query term's BM25 contribution to every document that contains it. */
  private accumulate(term: string, scores: Map<number, number>): void {
    const posting = this.postings.get(term);
    if (!posting) return;
    const weight = idf(this.ids.length, this.df.get(term) ?? 0);
    for (const [docIdx, tf] of posting) {
      const add = termScore(tf, this.lens[docIdx], this.avgdl, weight);
      scores.set(docIdx, (scores.get(docIdx) ?? 0) + add);
    }
  }

  /** The top `k` scored documents as `Match`es, highest first. */
  private rank(scores: Map<number, number>, k: number): Match[] {
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([docIdx, score]) => ({ id: this.ids[docIdx], score }));
  }
}
