// `denext_read_docs`: return a whole docs page, one section of it, or an API symbol's full docs
// as Markdown — straight from the shipped corpus (./corpus.ts), so it works offline.
//
// Accepted references (case-insensitive, leading/trailing slashes ignored):
//   desktop-runtime                       a page by slug
//   /docs/desktop#desktop-notifications   a page section (also `desktop#…`, a full denext.dev URL)
//   api:denext/useApi                     an API symbol (also `api:denext/server/getSession`,
//   api:denext-server/getSession          `/docs/api/denext-server/getSession`, or a bare
//   getSession                            symbol name when no page has that slug)
// An unknown page answers with did-you-mean suggestions and the list of every page.

import { editDistance } from "../../utils/edit-distance.ts";
import {
  chunkRef,
  chunkUrl,
  type Corpus,
  type DocChunk,
  type DocPage,
  DOCS_ORIGIN,
  isGuide,
  loadCorpus,
} from "./corpus.ts";

/** The result of a read: Markdown text, flagged as an error when nothing matched. */
export interface ReadResult {
  text: string;
  isError?: boolean;
}

/** Default cap on a whole-page read, in characters (a section is never truncated). */
export const READ_PAGE_MAX = 60_000;

/** An absolute URL for a corpus URL (site-relative ones get the docs origin). */
const absolute = (url: string) => (url.startsWith("/") ? `${DOCS_ORIGIN}${url}` : url);

/** Normalize a reference: drop the origin, `/docs/` and `doc:` prefixes and stray slashes. */
function normalize(ref: string): string {
  return ref.trim()
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/^\/?docs\//i, "")
    .replace(/^doc:/i, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/(?=#)/, "");
}

/** `denext/server` or `denext-server` → the corpus module slug `denext-server`. */
const moduleSlug = (m: string) => m.replace(/\//g, "-").toLowerCase();

/** Resolve an API reference (`denext/server/getSession`, `denext-server/getSession`, `useApi`). */
function findSymbols(corpus: Corpus, ref: string): DocChunk[] {
  const api = corpus.chunks.filter((c) => !isGuide(c));
  const slash = ref.lastIndexOf("/");
  const name = (slash === -1 ? ref : ref.slice(slash + 1)).toLowerCase();
  const mod = slash === -1 ? null : moduleSlug(ref.slice(0, slash));
  const exact = api.filter((c) =>
    c.id.slice(c.id.lastIndexOf("/") + 1).toLowerCase() === name &&
    (mod === null || moduleSlug(c.module ?? "") === mod)
  );
  if (exact.length || mod === null) return exact;
  return api.filter((c) => c.id.slice(c.id.lastIndexOf("/") + 1).toLowerCase() === name);
}

/** Render API symbols (several when a bare name is exported by more than one module). */
function renderSymbols(corpus: Corpus, syms: DocChunk[]): string {
  return syms.map((c) => {
    const only = c.denextOnly ? " · denext-only (no React/Next.js equivalent)" : "";
    return `${c.text}\n\nSource: ${absolute(chunkUrl(corpus, c))} · ref \`${c.id}\`${only}`;
  }).join("\n\n---\n\n");
}

/** Page header: title, lead, source URL. */
function pageHeader(page: DocPage): string {
  const url = absolute(page.url ?? `/docs/${page.slug}`);
  const lead = page.lead ? `\n\n> ${page.lead}` : "";
  return `# ${page.title}${lead}\n\nSource: ${url}`;
}

/** A section list (`ref — heading`) for a page. */
function outline(sections: DocChunk[]): string {
  return sections.filter((s) => s.level !== 1)
    .map((s) => `${s.level === 3 ? "  " : ""}- ${chunkRef(s)} — ${s.title}`).join("\n");
}

/** A whole page, truncated at a section boundary past `max` with the rest listed. */
function renderPage(page: DocPage, sections: DocChunk[], max: number): string {
  let out = pageHeader(page);
  for (let i = 0; i < sections.length; i++) {
    const next = `\n\n${sections[i].text}`;
    if (i > 0 && out.length + next.length > max) {
      return `${out}\n\n---\n\n[Page truncated at ${max} characters. Read the remaining ` +
        `sections by ref with denext_read_docs:]\n\n${outline(sections.slice(i))}`;
    }
    out += next;
  }
  return out;
}

/** The closest page slugs / titles to `want`. */
function suggestPages(corpus: Corpus, want: string): DocPage[] {
  const w = want.toLowerCase();
  return corpus.pages
    .map((p) => {
      const slug = p.slug.toLowerCase();
      const title = p.title.toLowerCase();
      const contains = slug.includes(w) || w.includes(slug) || title.includes(w);
      const d = Math.min(editDistance(w, slug), editDistance(w, title));
      return { p, d: contains ? 0 : d };
    })
    .filter((x) => x.d <= Math.max(2, Math.floor(w.length / 3)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 5)
    .map((x) => x.p);
}

/** The "unknown page" answer: suggestions plus every page. */
function unknownPage(corpus: Corpus, slug: string): ReadResult {
  const near = suggestPages(corpus, slug);
  const hint = near.length
    ? `Did you mean: ${near.map((p) => `\`${p.slug}\``).join(", ")}?\n\n`
    : "";
  const all = corpus.pages.map((p) => `- ${p.slug} — ${p.title}`).join("\n");
  return {
    text: `No denext docs page "${slug}". ${hint}Available pages:\n\n${all}\n\n` +
      "API symbols: pass `api:<module>/<name>` (e.g. `api:denext/useApi`), or search with " +
      "denext_search_docs.",
    isError: true,
  };
}

/** Read one section of a page by its anchor (or its de-duplicated `anchor-2` id). */
function readSection(corpus: Corpus, page: DocPage, anchor: string): ReadResult {
  const sections = corpus.sectionsOf.get(page.slug) ?? [];
  const a = anchor.toLowerCase();
  const hit = corpus.byId.get(`doc:${page.slug}#${anchor}`) ??
    sections.find((s) => s.anchor?.toLowerCase() === a);
  if (!hit) {
    return {
      text: `No section "#${anchor}" on ${page.slug}. Its sections:\n\n${outline(sections)}`,
      isError: true,
    };
  }
  // An h2 includes its h3 subsections, as on the page.
  const at = sections.indexOf(hit);
  const body = [hit.text];
  if (hit.level === 2) {
    for (const s of sections.slice(at + 1)) {
      if (s.level !== 3) break;
      body.push(s.text);
    }
  }
  const url = absolute(chunkUrl(corpus, hit));
  return { text: `# ${page.title}\n\nSource: ${url}\n\n${body.join("\n\n")}` };
}

/**
 * Read docs by reference: a page, a page section, or an API symbol (see the module comment).
 *
 * @param ref The page slug / URL / `slug#anchor` / `api:<module>/<name>` to read.
 * @param max Cap on a whole-page read in characters (default {@link READ_PAGE_MAX}).
 */
export async function readDocs(ref: string, max = READ_PAGE_MAX): Promise<ReadResult> {
  const corpus = await loadCorpus();
  const norm = normalize(ref);
  if (!norm) return unknownPage(corpus, ref);
  if (/^api[:/]/i.test(norm)) {
    const syms = findSymbols(corpus, norm.replace(/^api[:/]/i, ""));
    return syms.length ? { text: renderSymbols(corpus, syms) } : {
      text: `No API symbol "${ref}". Search with denext_search_docs (kind: "api").`,
      isError: true,
    };
  }
  const hash = norm.indexOf("#");
  const slug = (hash === -1 ? norm : norm.slice(0, hash)).toLowerCase();
  const anchor = hash === -1 ? "" : norm.slice(hash + 1);
  const page = corpus.pageBySlug.get(slug);
  if (!page) {
    const syms = hash === -1 ? findSymbols(corpus, norm) : [];
    return syms.length ? { text: renderSymbols(corpus, syms) } : unknownPage(corpus, slug);
  }
  if (anchor) return readSection(corpus, page, anchor);
  return { text: renderPage(page, corpus.sectionsOf.get(page.slug) ?? [], max) };
}
