// Check every `/docs/<page>#<anchor>` link against the ids the docs site really renders. Used
// by `deno task doc-lint` (CI's `check` job); prints each broken anchor and exits non-zero.
//
// Each docs page is rendered as the site renders it (its `page.tsx` default export called; a
// Markdown page's HTML comes back through `dangerouslySetInnerHTML`), and the ids are taken from
// the result: explicit `id` props, the ids the docs shell gives h2/h3 headings, and `id="…"`
// attributes in rendered Markdown (raw HTML, or the `html` prop of the component injecting it). Links are read from the docs sources (`content.md` and
// `page.tsx`), the root guides and AGENTS.md / README.md / CHANGELOG.md, in both the
// site-relative (`/docs/x#y`) and the absolute (`https://denext.dev/docs/x#y`) form. A root
// guide is read on GitHub and JSR too, so a site-relative `](/docs/…)` link there is an error.
//
//   deno run -A scripts/check-doc-anchors.ts

import { tocFromVNodes } from "../site/lib/toc.ts";

const ROOT = new URL("../", import.meta.url);
const DOCS = new URL("site/app/docs/", ROOT);

/** Root files whose `/docs/…#…` links are checked, besides every docs page's own sources. */
const ROOT_FILES = [
  "AGENTS.md",
  "README.md",
  "CHANGELOG.md",
  "FEATURES.md",
  "KNOWN-LIMITATIONS.md",
  "KNOWN-DIFFERENCES.md",
  "ROADMAP.md",
  "POLICIES.md",
  "CONTRIBUTING.md",
];

/** A `/docs/<page>#<anchor>` link, site-relative or on denext.dev. */
const LINK = /(?:https:\/\/denext\.dev)?\/docs\/([a-z0-9-]+)#([A-Za-z0-9_-]+)/g;

/** One link whose anchor the target page doesn't render. */
export interface BrokenAnchor {
  file: string;
  line: number;
  link: string;
  reason: string;
}

// deno-lint-ignore no-explicit-any -- a VNode's props are untyped here
type Node = { type?: unknown; props?: any } | Node[] | string | number | boolean | null;

/** The `id="…"` attributes of rendered Markdown HTML, when `html` is a string. */
function htmlIds(html: unknown, into: Set<string>): void {
  if (typeof html !== "string") return;
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) into.add(m[1]);
}

/** One node's own ids: its `id` prop, and those of the rendered Markdown it injects. */
// deno-lint-ignore no-explicit-any -- a VNode's props are untyped here
function ownIds(props: any, into: Set<string>): void {
  if (typeof props.id === "string") into.add(props.id);
  // Rendered Markdown: raw HTML, or the `html` prop of the component that injects it.
  htmlIds(props.dangerouslySetInnerHTML?.__html, into);
  htmlIds(props.html, into);
}

/** Collect the ids of `n` and of everything below it (children and VNode-valued props). */
function collectIds(n: Node, into: Set<string>): void {
  if (Array.isArray(n)) return n.forEach((c) => collectIds(c, into));
  const props = n && typeof n === "object" ? n.props : undefined;
  if (!props) return;
  ownIds(props, into);
  for (const v of Object.values(props)) {
    if (v && typeof v === "object") collectIds(v as Node, into);
  }
}

/** Every id a rendered VNode tree carries (explicit ids, heading ids, rendered Markdown ids). */
export function renderedIds(tree: unknown): Set<string> {
  // The docs shell ids its h2/h3 headings from their text; do the same (it mutates ids in).
  tocFromVNodes(tree as never);
  const ids = new Set<string>();
  collectIds(tree as Node, ids);
  return ids;
}

/** The `/docs/<page>#<anchor>` links in one file's text, with their 1-based lines. */
export function anchorLinks(
  text: string,
): { page: string; anchor: string; line: number; link: string }[] {
  const out: { page: string; anchor: string; line: number; link: string }[] = [];
  const lines = text.split("\n");
  lines.forEach((l, i) => {
    for (const m of l.matchAll(LINK)) {
      out.push({ page: m[1], anchor: m[2], line: i + 1, link: m[0] });
    }
  });
  return out;
}

/** Check `links` against each page's rendered ids (`null`: no such page). */
export function brokenAnchors(
  file: string,
  text: string,
  idsOf: (page: string) => Set<string> | null,
): BrokenAnchor[] {
  const out: BrokenAnchor[] = [];
  for (const { page, anchor, line, link } of anchorLinks(text)) {
    const ids = idsOf(page);
    if (ids === null) out.push({ file, line, link, reason: `no docs page /docs/${page}` });
    else if (!ids.has(anchor)) out.push({ file, line, link, reason: `no id "${anchor}" there` });
  }
  return out;
}

/**
 * Site-relative `](/docs/…)` links in a file read outside the site (a root guide on GitHub, a
 * package page on JSR), where they 404: those must be absolute `https://denext.dev/docs/…`.
 */
export function relativeDocsLinks(file: string, text: string): BrokenAnchor[] {
  const out: BrokenAnchor[] = [];
  text.split("\n").forEach((l, i) => {
    for (const m of l.matchAll(/\]\((\/docs\/[^)\s]*)\)/g)) {
      out.push({
        file,
        line: i + 1,
        link: m[1],
        reason: "site-relative: 404s on GitHub and JSR; use https://denext.dev" + m[1],
      });
    }
  });
  return out;
}

/** The docs page directories (dynamic segments such as `api/[module]` excluded). */
async function docSlugs(): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(DOCS)) {
    if (e.isDirectory && !e.name.includes("[")) out.push(e.name);
  }
  return out.sort();
}

/** Render every docs page and check every anchor link; the broken ones. */
export async function checkDocAnchors(): Promise<BrokenAnchor[]> {
  const ids = new Map<string, Set<string>>();
  const files: string[] = [...ROOT_FILES];
  for (const slug of await docSlugs()) {
    const page = new URL(`${slug}/page.tsx`, DOCS);
    const mod = await import(page.href);
    ids.set(slug, renderedIds(await mod.default({ params: {} })));
    for await (const e of Deno.readDir(new URL(`${slug}/`, DOCS))) {
      if (e.isFile && /\.(md|tsx)$/.test(e.name)) files.push(`site/app/docs/${slug}/${e.name}`);
    }
  }
  const broken: BrokenAnchor[] = [];
  for (const file of files.sort()) {
    const text = await Deno.readTextFile(new URL(file, ROOT));
    broken.push(...brokenAnchors(file, text, (p) => ids.get(p) ?? null));
    if (ROOT_FILES.includes(file)) broken.push(...relativeDocsLinks(file, text));
  }
  return broken;
}

if (import.meta.main) {
  const broken = await checkDocAnchors();
  for (const b of broken) console.error(`${b.file}:${b.line}: ${b.link}: ${b.reason}`);
  if (broken.length > 0) {
    console.error(`\n${broken.length} broken docs anchor(s).`);
    Deno.exit(1);
  }
  console.log("Every /docs/…#anchor link resolves.");
}
