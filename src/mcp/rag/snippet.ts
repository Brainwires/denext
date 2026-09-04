// A shared snippet helper for the RAG tools — a short text window around the first query
// term, used by both the docs search (search.ts) and the codebase search (code-search.ts).

const SNIPPET_LEN = 200;

/** A ~`len`-char window of `text` around the first occurrence of any query term. */
export function snippet(text: string, terms: string[], len = SNIPPET_LEN): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, (at < 0 ? 0 : at) - 40);
  const slice = text.slice(start, start + len).trim();
  return (start > 0 ? "…" : "") + slice + (start + len < text.length ? "…" : "");
}
