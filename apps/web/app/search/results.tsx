"use client";

// The docs search island — the ONE interactive route on the site. The index is built
// after `deno task export` by scripts/search-index.ts (one entry per guide section and
// per API symbol) and fetched lazily here; ranking is a small title-first scorer with
// AND semantics across the query's terms, all in the browser, no service behind it.

import { useEffect, useMemo, useState } from "denext";
import { ClearIcon, MagnifierIcon } from "../../components/search.tsx";

/** One searchable unit, as written by scripts/search-index.ts. */
interface Entry {
  /** Where it lives (`/docs/routing#conventions`, `/docs/api/denext/useState`). */
  u: string;
  /** The page (guide title, or the API module) the unit belongs to. */
  p: string;
  /** The unit's own title (section heading or symbol name). */
  t: string;
  /** Its text, already trimmed at build time. */
  x: string;
  /** `guide` sections rank slightly above `api` symbols. */
  k: "guide" | "api";
  /** The symbol kind for API entries (`function`, `interface`, …). */
  d?: string;
}

/** An entry with its lower-cased fields precomputed once, at load. */
interface Prepared extends Entry {
  tl: string;
  pl: string;
  xl: string;
  tw: string[];
}

interface Hit {
  entry: Prepared;
  score: number;
}

const MAX_HITS = 30;

function words(s: string): string[] {
  return s.split(/[^a-z0-9_$]+/).filter(Boolean);
}

/** Query → distinct lower-cased terms. */
function tokenize(q: string): string[] {
  return [...new Set(words(q.toLowerCase()))];
}

let indexPromise: Promise<Prepared[]> | undefined;

function loadIndex(): Promise<Prepared[]> {
  indexPromise ??= fetch("/search-index.json")
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<Entry[]>;
    })
    .then((list) =>
      list.map((e) => {
        const tl = e.t.toLowerCase();
        return {
          ...e,
          tl,
          pl: e.p.toLowerCase(),
          xl: e.x.toLowerCase(),
          tw: words(tl),
        };
      })
    )
    .catch((err) => {
      indexPromise = undefined; // let a retry (reload) try again
      throw err;
    });
  return indexPromise;
}

function occurrences(haystack: string, needle: string, cap: number): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1 && n < cap) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** A term's score against one entry, `0` when the term appears nowhere in it. */
function termScore(e: Prepared, term: string): number {
  let s = 0;
  if (e.tl === term) s += 60;
  else if (e.tw.includes(term)) s += 30;
  else if (e.tw.some((w) => w.startsWith(term))) s += 18;
  else if (e.tl.includes(term)) s += 10;
  if (e.pl.includes(term)) s += 5;
  s += occurrences(e.xl, term, 5) * 2;
  return s;
}

/** Rank the index for the given terms: every term must match somewhere in an entry. */
function search(index: Prepared[], terms: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const entry of index) {
    let score = 0;
    for (const term of terms) {
      const s = termScore(entry, term);
      if (s === 0) {
        score = 0;
        break;
      }
      score += s;
    }
    if (score === 0) continue;
    if (entry.k === "guide") score *= 1.15;
    hits.push({ entry, score });
  }
  hits.sort((a, b) =>
    b.score - a.score || a.entry.t.length - b.entry.t.length || a.entry.p.length - b.entry.p.length
  );
  return hits.slice(0, MAX_HITS);
}

const SNIPPET_BEFORE = 60;
const SNIPPET_LENGTH = 200;

/** A window of the entry's text around the first term hit, ellipsised at the edges. */
function snippetOf(e: Prepared, terms: string[]): string {
  let first = -1;
  for (const term of terms) {
    const i = e.xl.indexOf(term);
    if (i !== -1 && (first === -1 || i < first)) first = i;
  }
  const start = Math.max(0, (first === -1 ? 0 : first) - SNIPPET_BEFORE);
  let s = e.x.slice(start, start + SNIPPET_LENGTH);
  if (start > 0) s = "…" + s.replace(/^\S*\s/, "");
  if (start + SNIPPET_LENGTH < e.x.length) s = s.replace(/\s\S*$/, "") + "…";
  return s;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Text with each term wrapped in `<mark>` (VNodes, never HTML strings). */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>;
  const re = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  const parts = text.split(re);
  return (
    <>
      {parts.map((part, i) => i % 2 === 1 ? <mark key={i}>{part}</mark> : part)}
    </>
  );
}

function statusLine(
  q: string,
  terms: string[],
  index: Prepared[] | null,
  error: string | null,
  hits: Hit[],
): string {
  if (error) {
    return `Couldn't load the search index (${error}). Reload to try again.`;
  }
  if (!index) return "Loading the index…";
  if (terms.length === 0) {
    return `Search ${index.length} sections across the guides and the API reference.`;
  }
  if (hits.length === 0) return `No results for “${q}”.`;
  const n = hits.length === MAX_HITS ? `Top ${MAX_HITS}` : String(hits.length);
  return `${n} result${hits.length === 1 ? "" : "s"} for “${q}”.`;
}

/** Search box + ranked results for `?q=`, kept in sync with the URL as you type. */
export function SearchResults() {
  const [q, setQ] = useState("");
  const [index, setIndex] = useState<Prepared[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setQ(new URLSearchParams(location.search).get("q") ?? "");
    loadIndex().then(
      setIndex,
      (err) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, []);

  const update = (next: string) => {
    setQ(next);
    const url = new URL(location.href);
    if (next) url.searchParams.set("q", next);
    else url.searchParams.delete("q");
    history.replaceState(null, "", url);
  };

  const terms = useMemo(() => tokenize(q), [q]);
  const hits = useMemo(
    () => index && terms.length ? search(index, terms) : [],
    [index, terms],
  );

  return (
    <div class="searchpage">
      <h1>Search the docs</h1>
      <form
        class="search"
        role="search"
        action="/search"
        method="get"
        onSubmit={(e) => e.preventDefault()}
      >
        <span class="search-icon">
          <MagnifierIcon />
        </span>
        <input
          class="search-input"
          type="search"
          name="q"
          value={q}
          placeholder="Search"
          autocomplete="off"
          spellcheck={false}
          autofocus
          aria-label="Search the docs"
          onChange={(e) => update((e.target as HTMLInputElement).value)}
        />
        <button
          type="reset"
          class="search-clear"
          aria-label="Clear search"
          onClick={() => update("")}
        >
          <ClearIcon />
        </button>
      </form>
      <p class="search-status" aria-live="polite">
        {statusLine(q, terms, index, error, hits)}
      </p>
      <noscript>
        <p class="search-status">
          Search needs JavaScript — this is the one page on the site that uses it.
        </p>
      </noscript>
      <ol class="search-results">
        {hits.map(({ entry }) => (
          <li key={entry.u}>
            <a class="search-hit" href={entry.u}>
              <span class="search-hit-page">{entry.p}</span>
              <span class="search-hit-title">
                <Highlight text={entry.t} terms={terms} />
                {entry.d && <span class="search-hit-kind">{entry.d}</span>}
              </span>
              <span class="search-hit-snippet">
                <Highlight text={snippetOf(entry, terms)} terms={terms} />
              </span>
            </a>
          </li>
        ))}
      </ol>
      {terms.length === 0 && index && (
        <p class="search-tips">
          Tip: press <kbd>Enter</kbd>{" "}
          in the header search box on any page to land here. Guides rank above API symbols; every
          word you type has to match.
        </p>
      )}
    </div>
  );
}
