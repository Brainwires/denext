// A small, first-party, zero-dependency Markdown renderer for the docs site.
//
// Frontmatter parsing for the docs' `.md` pages; the Markdown → HTML renderer lives in
// `packages/content-collections/markdown.ts` (first-party, zero-dependency — no npm markdown
// stack in the tree) and is re-exported from here. Its fenced-code output matches the site's
// <Code> component exactly.

/** Frontmatter parsed from the top `--- ... ---` block of a Markdown document. */
export interface DocFrontmatter {
  title?: string;
  lead?: string;
  slug?: string;
  [key: string]: string | undefined;
}

/** A parsed Markdown document: its frontmatter plus the remaining body. */
export interface ParsedDoc {
  frontmatter: DocFrontmatter;
  body: string;
}

/** Split a leading `--- ... ---` YAML-ish frontmatter block off the body. */
export function parseFrontmatter(src: string): ParsedDoc {
  const normalized = src.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: normalized };

  const block = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n/, "");
  const frontmatter: DocFrontmatter = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[m[1]] = value;
  }
  return { frontmatter, body };
}

/**
 * Split a leading `# Title` off the body. Root guides (CONTRIBUTING.md, …) carry no
 * frontmatter, so their own H1 is the shell's page heading rather than a duplicate inside it.
 */
export function splitLeadingH1(body: string): { title?: string; body: string } {
  const m = body.match(/^\s*#[ \t]+(.+?)[ \t]*\n+/);
  if (!m) return { body };
  return { title: m[1], body: body.slice(m[0].length) };
}

/**
 * Drop a leading raw-HTML block (the `<p align="center"><img …></p>` banner some root READMEs
 * open with) — the renderer escapes it, so it would otherwise show up as literal markup. Only
 * a block at the very top, terminated by a blank line, is removed; anything else is kept.
 */
export function stripLeadingRawHtml(body: string): string {
  const lead = body.match(/^\s*/)![0];
  const rest = body.slice(lead.length);
  if (!rest.startsWith("<")) return body;
  const blank = rest.search(/\n[ \t]*\n/);
  if (blank === -1) return body;
  return rest.slice(blank).replace(/^\n+/, "");
}

/** Hrefs that are already absolute, protocol-relative, site-absolute, in-page, or empty. */
const ABSOLUTE_HREF = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#|$)/i;

/** POSIX `dirname`, without a path dependency: `a/b/c.md` → `a/b`, `c.md` → `""`. */
function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** POSIX normalization of a `/`-joined path: resolve `.`/`..`, drop empty segments. */
function normalizePath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg !== "..") out.push(seg);
    else if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push("..");
  }
  return out.join("/");
}

/** A repo path is a FILE when its last segment has an extension (a leading dot doesn't count). */
function looksLikeFile(path: string): boolean {
  const last = path.slice(path.lastIndexOf("/") + 1);
  return last.lastIndexOf(".") > 0;
}

/** The docs URL / GitHub URL a repo-relative link resolves to, or `null` to leave it alone. */
function docHref(href: string, dir: string): string | null {
  if (ABSOLUTE_HREF.test(href)) return null;
  const hash = href.indexOf("#");
  const anchor = hash === -1 ? "" : href.slice(hash);
  const rel = hash === -1 ? href : href.slice(0, hash);
  const path = normalizePath(dir === "" ? rel : `${dir}/${rel}`);
  if (path === "" || path.startsWith("..")) return null;
  const mapped: string | undefined = DOC_URLS[path];
  if (mapped !== undefined) return mapped + anchor;
  return looksLikeFile(path) ? `${GITHUB_BLOB}/${path}${anchor}` : `${GITHUB_TREE}/${path}`;
}

/**
 * Rewrite the relative links of a rendered repo document so they work on the docs site:
 * a guide the site publishes becomes its route, any other repo path becomes a GitHub URL.
 * `sourcePath` is the document's own repo-relative path; links resolve against its directory.
 */
export function rewriteDocLinks(html: string, sourcePath: string): string {
  const dir = dirOf(sourcePath);
  return html.replace(/href="([^"]*)"/g, (m, href: string) => {
    const next = docHref(href, dir);
    return next === null ? m : `href="${next}"`;
  });
}

// The renderer itself is the first-party one @denext/content-collections ships (moved there
// so content collections and the docs render Markdown identically); re-exported for callers.
import { renderMarkdown } from "../../../packages/content-collections/markdown.ts";
import { DOC_URLS, GITHUB_BLOB, GITHUB_TREE } from "./docs-map.ts";
export { renderMarkdown };

/**
 * Convenience: parse frontmatter and render the body in one call. A document with no
 * frontmatter title takes its leading H1 as the title; pass `sourcePath` (repo-relative) for a
 * file rendered from outside the site so its relative links are rewritten.
 */
export function renderDoc(
  src: string,
  opts?: { sourcePath?: string },
): { frontmatter: DocFrontmatter; html: string } {
  const parsed = parseFrontmatter(src);
  const frontmatter = parsed.frontmatter;
  let body = stripLeadingRawHtml(parsed.body);
  if (frontmatter.title === undefined) {
    const split = splitLeadingH1(body);
    if (split.title !== undefined) {
      frontmatter.title = split.title;
      body = split.body;
    }
  }
  const html = renderMarkdown(body);
  return {
    frontmatter,
    html: opts?.sourcePath ? rewriteDocLinks(html, opts.sourcePath) : html,
  };
}
