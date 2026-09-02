// Server-side "On this page" table-of-contents extraction (zero client JavaScript).
//
// The docs render two ways: hand-written JSX pages (headings are VNodes) and Markdown pages
// (headings live in a rendered HTML string). These two extractors give DocsShell an h2/h3
// list for either, computed at build/export time so the TOC ships no JS.

// deno-lint-ignore-file no-explicit-any
import type { VNode, VNodeChild, VNodeChildren } from "denext";

/** One entry in the on-this-page nav. */
export interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
  /** Anchor to jump to, when it differs from `#${id}` (e.g. the API module page). */
  href?: string;
  /** Nested sub-links (e.g. a kind section's individual exports), revealed for the current section. */
  children?: { id: string; text: string }[];
}

function isVNode(n: unknown): n is VNode {
  return typeof n === "object" && n !== null && "type" in (n as any) &&
    "props" in (n as any);
}

/** Gather the visible text of a VNode subtree. */
function vnodeText(node: VNodeChildren): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(vnodeText).join("");
  if (isVNode(node)) return vnodeText((node.props as any)?.children);
  return "";
}

/** A URL-safe id from heading text (matches the Markdown renderer's slugify). */
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
}

function walkVNodes(node: VNodeChildren, out: TocItem[]): void {
  if (Array.isArray(node)) {
    for (const c of node) walkVNodes(c as VNodeChild, out);
    return;
  }
  if (!isVNode(node)) return;
  const props = node.props as any;
  if (node.type === "h2" || node.type === "h3") {
    const text = vnodeText(props?.children).trim();
    // Hand-JSX headings usually have no `id`; MUTATE one in (slugified from the text) so both
    // the anchor and the TOC link exist. Safe: these are freshly-created render-time VNodes.
    let id = typeof props?.id === "string" ? props.id : "";
    if (!id && text) {
      id = slugify(text);
      if (props) props.id = id;
    }
    if (id) out.push({ level: node.type === "h2" ? 2 : 3, id, text });
  }
  walkVNodes(props?.children, out);
}

/** Extract the h2/h3 headings (id + text) from a JSX VNode subtree. */
export function tocFromVNodes(children: VNodeChildren): TocItem[] {
  const out: TocItem[] = [];
  walkVNodes(children, out);
  return out;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

/** Extract the h2/h3 headings (id + text) from rendered Markdown HTML. */
export function tocFromHtml(html: string): TocItem[] {
  const out: TocItem[] = [];
  const re = /<h([23])[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    out.push({ level: Number(m[1]) as 2 | 3, id: m[2], text: stripTags(m[3]) });
  }
  return out;
}
