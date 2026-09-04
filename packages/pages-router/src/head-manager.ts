// Client-side head manager for `next/head`. Walks a `<Head>`'s children (VNodes),
// extracts the `<title>`/`<meta>`/`<link>` tags, and applies them to
// `document.head` — keyed so a later render (or a soft navigation) replaces the
// previous page's tags rather than piling duplicates up. Runs only in the browser.

import { Fragment } from "@denext/denext";
import type { VNode, VNodeChild, VNodeChildren } from "@denext/denext";

/** A head tag extracted from a `<Head>` child. */
interface HeadTag {
  tag: "title" | "meta" | "link" | "script" | "style" | "base" | "noscript";
  attrs: Record<string, string>;
  /** Text content (for `<title>`/`<script>`/`<style>`/`<noscript>`). */
  text?: string;
  /** Dedupe key: explicit `key`, else derived from identifying attributes. */
  key: string;
}

const HOISTED = new Set([
  "title",
  "meta",
  "link",
  "script",
  "style",
  "base",
  "noscript",
]);
/** Tags whose text content is part of their identity (and set on the element). */
const TEXT_TAGS = new Set(["title", "script", "style", "noscript"]);

/** A small stable hash of a string (djb2), for content-based dedupe keys. */
function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Module-wide registry of currently-applied head elements, keyed for replacement. */
const applied = new Map<string, Element>();

/** Index the SSR-rendered head tags once, so hydration adopts them (no duplicates). */
let seeded = false;
function seed(): void {
  if (seeded) return;
  seeded = true;
  for (
    const el of document.head.querySelectorAll(
      "meta, link, base, script, style, noscript",
    )
  ) {
    const attrs: Record<string, string> = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    const tag = el.tagName.toLowerCase();
    const text = TEXT_TAGS.has(tag) ? (el.textContent ?? undefined) : undefined;
    const key = keyFor(tag, attrs, text);
    if (!applied.has(key)) applied.set(key, el);
  }
}

function isVNode(c: VNodeChild): c is VNode {
  return !!c && typeof c === "object" && "type" in c;
}

/** Derive a stable dedupe key for a tag from its identifying attributes (+ text). */
function keyFor(
  tag: string,
  attrs: Record<string, string>,
  text?: string,
): string {
  if (tag === "title" || tag === "base") return tag;
  if (tag === "meta") return `meta:${metaIdentity(attrs)}`;
  if (tag === "link") return `link:${attrs.rel ?? ""}:${attrs.href ?? ""}`;
  // script/style/noscript: identity is the source (if any) plus the content, so
  // distinct blocks (e.g. two JSON-LD scripts) coexist while a re-render dedupes.
  return `${tag}:${attrs.src ?? ""}:${text != null ? hashText(text) : ""}`;
}

/** What makes a `<meta>` unique: its name/property/http-equiv, `charset`, or everything. */
function metaIdentity(attrs: Record<string, string>): string {
  return attrs.name ?? attrs.property ?? attrs["http-equiv"] ??
    (attrs.charset != null ? "charset" : JSON.stringify(attrs));
}

/** Extract the text content of a VNode's children (for `<script>`/`<style>`/…). */
function childText(val: unknown): string {
  if (val == null || val === false || val === true) return "";
  if (Array.isArray(val)) return val.map(childText).join("");
  if (typeof val === "object" && "props" in (val as VNode)) {
    return childText(
      ((val as VNode).props as { children?: unknown })?.children,
    );
  }
  return String(val);
}

/**
 * A text-bearing tag's content: its children, or raw HTML (common for JSON-LD), which
 * counts as the tag's text/identity. Undefined for other tags or no raw HTML.
 */
function contentText(tag: string, prop: string, val: unknown): string | undefined {
  if (!TEXT_TAGS.has(tag)) return undefined;
  if (prop === "children") return childText(val);
  const html = (val as { __html?: string } | null)?.__html;
  return html != null ? String(html) : undefined;
}

/** Convert a single intrinsic VNode into a {@link HeadTag}. */
function toTag(v: VNode): HeadTag {
  const props = (v.props ?? {}) as Record<string, unknown>;
  const attrs: Record<string, string> = {};
  let text: string | undefined;
  const tag = v.type as HeadTag["tag"];
  for (const [k, val] of Object.entries(props)) {
    if (k === "children" || k === "dangerouslySetInnerHTML") {
      text = contentText(tag, k, val) ?? text;
      continue;
    }
    if (val == null || val === false) continue;
    attrs[k] = val === true ? "" : String(val);
  }
  const key = v.key != null ? String(v.key) : keyFor(tag, attrs, text);
  return { tag, attrs, text, key };
}

/** Recursively collect head tags from children (descending into fragments). */
function collect(children: VNodeChildren | undefined, out: HeadTag[]): void {
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (!isVNode(c)) continue;
    if (c.type === Fragment) {
      collect((c.props as { children?: VNodeChildren })?.children, out);
      continue;
    }
    if (typeof c.type === "string" && HOISTED.has(c.type)) out.push(toTag(c));
  }
}

/**
 * Apply a `<Head>`'s children to `document.head`. Returns a cleanup that removes
 * the tags this call added — so unmounting or re-rendering a `<Head>` (e.g. on a
 * soft navigation) leaves `document.head` reflecting only the current page.
 */
export function applyHead(children: VNodeChildren | undefined): () => void {
  seed(); // adopt SSR-rendered head tags on the first call so hydration adds no dupes
  const tags: HeadTag[] = [];
  collect(children, tags);
  // Each entry undoes exactly what this call did, restoring the element (or title)
  // that was there before — so leaving a page reverts the base SSR tags (e.g. the
  // document's viewport meta) instead of deleting them.
  const restores: Array<() => void> = [];
  for (const t of tags) {
    if (t.tag === "title") {
      const prevTitle = document.title;
      document.title = t.text ?? "";
      restores.push(() => {
        document.title = prevTitle;
      });
      continue;
    }
    const el = document.createElement(t.tag);
    for (const [k, val] of Object.entries(t.attrs)) el.setAttribute(k, val);
    if (t.text != null && TEXT_TAGS.has(t.tag)) el.textContent = t.text;
    const prevEl = applied.get(t.key) ?? null;
    prevEl?.remove(); // detach the previous tag for this key (kept for restore)
    document.head.appendChild(el);
    applied.set(t.key, el);
    restores.push(() => {
      // Only revert if our element is still the current one (a later page may own it).
      if (applied.get(t.key) !== el) return;
      el.remove();
      if (prevEl) {
        document.head.appendChild(prevEl);
        applied.set(t.key, prevEl);
      } else {
        applied.delete(t.key);
      }
    });
  }
  return () => {
    for (const restore of restores) restore();
  };
}
