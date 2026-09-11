// Build the site-search index from the exported HTML, run over out/ after `deno task export`.
//
//   deno task search-index      # (invoked by the root `docs:build` task, before `seo`)
//
// One entry per guide SECTION (h2/h3, so a hit deep-links to `#heading`) and one per API
// SYMBOL page. Written to out/search-index.json (what the site serves) and mirrored to
// public/search-index.json (git-ignored) so `deno task dev` / `start` serve it too. The
// /search island (app/search/results.tsx) fetches it lazily and ranks in the browser.

import { DOMParser, type Element } from "deno-dom";

const OUT = new URL("../out", import.meta.url).pathname;
const PUBLIC = new URL("../public", import.meta.url).pathname;

/** Text per guide section / API symbol kept in the index (the snippet source). */
const GUIDE_TEXT_CAP = 600;
const API_TEXT_CAP = 320;

interface Entry {
  u: string;
  p: string;
  t: string;
  x: string;
  k: "guide" | "api";
  d?: string;
}

const collapseWs = (s: string) => s.replace(/\s+/g, " ").trim();
const text = (el: Element | null | undefined) => collapseWs(el?.textContent ?? "");

/** out/docs/x/index.html → /docs/x */
function urlPathFor(fileAbs: string): string {
  const rel = fileAbs.slice(OUT.length).replace(/\/index\.html$/, "").replace(
    /\.html$/,
    "",
  );
  return rel === "" ? "/" : rel;
}

async function* walkHtml(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walkHtml(p);
    else if (entry.isFile && entry.name.endsWith(".html")) yield p;
  }
}

/** Elements whose own text is one unit of prose (an LI only when it holds no nested P). */
const TEXT_TAGS = new Set(["P", "PRE", "DT", "DD", "TD", "TH", "LI"]);

function isTextUnit(el: Element): boolean {
  const tag = el.tagName.toUpperCase();
  if (!TEXT_TAGS.has(tag)) return false;
  if (tag === "LI" && el.querySelector("p, li")) return false;
  if (/\bapi-detail-back\b/.test(el.getAttribute("class") ?? "")) return false;
  return true;
}

function cap(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n).replace(/\s\S*$/, "") + "…";
}

/** A guide page → one entry for the lead + one per h2/h3 section. */
function guideEntries(path: string, title: string, article: Element): Entry[] {
  const out: Entry[] = [];
  let heading = title;
  let anchor = "";
  let parts: string[] = [];
  const flush = () => {
    const x = collapseWs(parts.join(" "));
    if (x || anchor) {
      out.push({
        u: anchor ? `${path}#${anchor}` : path,
        p: title,
        t: heading,
        x: cap(x, GUIDE_TEXT_CAP),
        k: "guide",
      });
    }
    parts = [];
  };
  for (
    const el of Array.from(
      article.querySelectorAll("*"),
    ) as unknown as Element[]
  ) {
    const tag = el.tagName.toUpperCase();
    if (tag === "H1") continue;
    if (tag === "H2" || tag === "H3") {
      flush();
      heading = text(el);
      anchor = el.getAttribute("id") ?? "";
      continue;
    }
    if (isTextUnit(el)) parts.push(text(el));
  }
  flush();
  return out;
}

/** An API symbol page → one entry (name, kind, import module, description). */
function apiEntry(path: string, title: string, article: Element): Entry {
  const kind = text(article.querySelector(".api-kind")) || undefined;
  const importLine = text(article.querySelector(".api-detail-import"));
  const module = /from "([^"]+)"/.exec(importLine)?.[1] ?? "API reference";
  const parts: string[] = [];
  let inDescription = false;
  for (
    const el of Array.from(
      article.querySelectorAll("*"),
    ) as unknown as Element[]
  ) {
    const tag = el.tagName.toUpperCase();
    if (tag === "H2") inDescription = el.getAttribute("id") !== "signature";
    else if (inDescription && isTextUnit(el)) parts.push(text(el));
  }
  return {
    u: path,
    p: module,
    t: title,
    x: cap(collapseWs(parts.join(" ")), API_TEXT_CAP),
    k: "api",
    d: kind,
  };
}

async function entriesFor(fileAbs: string): Promise<Entry[]> {
  const path = urlPathFor(fileAbs);
  if (path === "/search") return [];
  const doc = new DOMParser().parseFromString(
    await Deno.readTextFile(fileAbs),
    "text/html",
  );
  const article = doc?.querySelector(".article") as Element | null;
  if (!doc || !article) return [];
  // The h1 (a symbol page's reads "cookies — denext/server"; keep the bare name).
  const title = text(article.querySelector("h1")).replace(/\s+—\s+denext(\/\S+)?$/, "") ||
    text(doc.querySelector("title")) || path;
  // /docs/api/<module>/<symbol> is a symbol page; /docs/api and /docs/api/<module> are lists.
  const isSymbol = /^\/docs\/api\/[^/]+\/[^/]+$/.test(path);
  if (isSymbol) return [apiEntry(path, title, article)];
  const entries = guideEntries(path, title, article);
  // The API list pages are tables of contents: keep their lead, not their per-kind sections.
  return /^\/docs\/api(\/[^/]+)?$/.test(path) ? entries.slice(0, 1) : entries;
}

const entries: Entry[] = [];
for await (const file of walkHtml(OUT)) entries.push(...await entriesFor(file));
entries.sort((a, b) => a.u.localeCompare(b.u));
const json = JSON.stringify(entries);
await Deno.writeTextFile(`${OUT}/search-index.json`, json);
await Deno.writeTextFile(`${PUBLIC}/search-index.json`, json);
const guides = entries.filter((e) => e.k === "guide").length;
console.log(
  `search-index: ${entries.length} entries (${guides} guide sections, ${
    entries.length - guides
  } API symbols), ${(json.length / 1024).toFixed(0)} KB → out/search-index.json (+ public/)`,
);
