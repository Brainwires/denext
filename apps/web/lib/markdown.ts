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

// The renderer itself is the first-party one @denext/content-collections ships (moved there
// so content collections and the docs render Markdown identically); re-exported for callers.
import { renderMarkdown } from "../../../packages/content-collections/markdown.ts";
export { renderMarkdown };

/** Convenience: parse frontmatter and render the body in one call. */
export function renderDoc(
  src: string,
): { frontmatter: DocFrontmatter; html: string } {
  const { frontmatter, body } = parseFrontmatter(src);
  return { frontmatter, html: renderMarkdown(body) };
}
