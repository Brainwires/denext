// Client-side head manager for `next/head`. Walks a `<Head>`'s children (VNodes),
// extracts the `<title>`/`<meta>`/`<link>` tags, and applies them to
// `document.head` — keyed so a later render (or a soft navigation) replaces the
// previous page's tags rather than piling duplicates up. Runs only in the browser.

import { Fragment } from "@denext/denext";
import type { VNode, VNodeChild, VNodeChildren } from "@denext/denext";

/** A head tag extracted from a `<Head>` child. */
interface HeadTag {
  tag: "title" | "meta" | "link";
  attrs: Record<string, string>;
  /** Title text (for `<title>`). */
  text?: string;
  /** Dedupe key: explicit `key`, else derived from identifying attributes. */
  key: string;
}

const HOISTED = new Set(["title", "meta", "link"]);

/** Module-wide registry of currently-applied head elements, keyed for replacement. */
const applied = new Map<string, Element>();

/** Index the SSR-rendered head tags once, so hydration adopts them (no duplicates). */
let seeded = false;
function seed(): void {
  if (seeded) return;
  seeded = true;
  for (const el of document.head.querySelectorAll("meta, link")) {
    const attrs: Record<string, string> = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    const key = keyFor(el.tagName.toLowerCase(), attrs);
    if (!applied.has(key)) applied.set(key, el);
  }
}

function isVNode(c: VNodeChild): c is VNode {
  return !!c && typeof c === "object" && "type" in c;
}

/** Derive a stable dedupe key for a tag from its identifying attributes. */
function keyFor(tag: string, attrs: Record<string, string>): string {
  if (tag === "title") return "title";
  if (tag === "meta") {
    const id = attrs.name ?? attrs.property ?? attrs["http-equiv"] ??
      (attrs.charset != null ? "charset" : JSON.stringify(attrs));
    return `meta:${id}`;
  }
  return `link:${attrs.rel ?? ""}:${attrs.href ?? ""}`;
}

/** Convert a single intrinsic VNode into a {@link HeadTag}. */
function toTag(v: VNode): HeadTag {
  const props = (v.props ?? {}) as Record<string, unknown>;
  const attrs: Record<string, string> = {};
  let text: string | undefined;
  for (const [k, val] of Object.entries(props)) {
    if (k === "children") {
      if (v.type === "title") text = String(val ?? "");
      continue;
    }
    if (val == null || val === false) continue;
    attrs[k] = val === true ? "" : String(val);
  }
  const tag = v.type as HeadTag["tag"];
  const key = v.key != null ? String(v.key) : keyFor(tag, attrs);
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
  const mine: string[] = [];
  for (const t of tags) {
    if (t.tag === "title") {
      document.title = t.text ?? "";
      continue;
    }
    const el = document.createElement(t.tag);
    for (const [k, val] of Object.entries(t.attrs)) el.setAttribute(k, val);
    applied.get(t.key)?.remove(); // replace any tag with the same key
    document.head.appendChild(el);
    applied.set(t.key, el);
    mine.push(t.key);
  }
  return () => {
    for (const key of mine) {
      const el = applied.get(key);
      if (el) {
        el.remove();
        applied.delete(key);
      }
    }
  };
}
