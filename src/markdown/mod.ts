/**
 * `denext/markdown` — denext's first-party, zero-dependency Markdown renderer, escaped by default.
 *
 * Two ways to render the same document:
 *
 * - {@linkcode renderMarkdown} returns an HTML string;
 * - {@linkcode Markdown} renders denext elements, so an app can swap any element for its own
 *   component (`components={{ h1: MyH1, a: MyLink, code: MyCode }}`). It has no hooks: it renders
 *   in a Server Component and in a `"use client"` one alike.
 *
 * ```ts
 * import { Markdown, renderMarkdown } from "denext/markdown";
 *
 * renderMarkdown("# Hi <b>there</b>"); // '<h1 id="hi-there">Hi &lt;b&gt;there&lt;/b&gt;</h1>'
 * h(Markdown, { source: post.body, components: { a: SiteLink } });
 * ```
 *
 * Raw HTML in the source is escaped unless `html: "sanitize"` keeps what a first-party allowlist
 * sanitizer allows; link and image URLs with a `javascript:` / `vbscript:` / `data:` scheme are
 * dropped (a link keeps its label, an image its alt text), entity-encoded schemes included. The
 * same renderer backs `@denext/content-collections`' `.md` entries.
 *
 * @module
 */

import { Fragment, h } from "../jsx/jsx-runtime.ts";
import type { Component, VNode, VNodeChildren } from "../jsx/types.ts";
import { type MarkdownOptions, renderMarkdown } from "./render.ts";

export { renderMarkdown, sanitizeHtml } from "./render.ts";
export type {
  MarkdownHtmlMode,
  MarkdownOptions,
  MarkdownUrlKind,
  SanitizeOptions,
} from "./render.ts";

/**
 * The props a {@linkcode Markdown} element override receives: the element's attributes in React
 * spelling (`className`, `htmlFor`, `href`, `id`, `src`, `alt`, …) and its rendered children.
 */
export interface MarkdownElementProps {
  /** The element's rendered children (absent for `img`, `hr`, `br`). */
  readonly children?: VNodeChildren;
  /** The element's attributes, as the HTML renderer writes them. */
  readonly [attribute: string]: unknown;
}

/**
 * What a `code` override receives on top of {@linkcode MarkdownElementProps}: whether it is a
 * fenced or indented block (inside `pre`) or an inline code span, and a fence's info string.
 */
export interface MarkdownCodeProps extends MarkdownElementProps {
  /** `true` for a code span, `false` for the code of a block. */
  readonly inline: boolean;
  /** A fenced block's language (```` ```ts ```` → `"ts"`), when it named one. */
  readonly lang?: string;
}

/**
 * Element overrides for {@linkcode Markdown}, keyed by the lower-case tag the HTML renderer
 * would write (`h1`…`h6`, `p`, `a`, `img`, `code`, `pre`, `ul`, `ol`, `li`, `blockquote`,
 * `aside` (callouts), `table`, `th`, `td`, `em`, `strong`, `sup`, `section`, …). A component
 * renders that element in place of the built-in one; a tag name renames it (`{ h1: "h2" }`).
 */
export type MarkdownComponents = {
  // deno-lint-ignore no-explicit-any -- each override takes the props of its own element.
  readonly [tag: string]: Component<any> | string | undefined;
};

/** Props of {@linkcode Markdown}: the source, the element overrides, and the render options. */
export interface MarkdownProps extends MarkdownOptions {
  /** The Markdown source (any frontmatter already removed). */
  readonly source: string;
  /** Components (or tag names) that render particular elements in place of the built-in ones. */
  readonly components?: MarkdownComponents;
}

/** One element of the rendered document's tree. */
interface MdElement {
  readonly tag: string;
  readonly attrs: ReadonlyArray<readonly [string, string]>;
  readonly children: MdNode[];
}

/** A node of the rendered document's tree: decoded text, or an element. */
type MdNode = string | MdElement;

/** Elements written as `<x … />` with no closing tag. */
const VOID = new Set(["area", "br", "col", "hr", "img", "source", "wbr"]);

/** Elements whose whitespace-only text children aren't content (and that React refuses). */
const NO_TEXT = new Set(["table", "thead", "tbody", "tfoot", "tr", "colgroup"]);

/** Boolean attributes the renderer or sanitizer may emit: present means `true`. */
const BOOLEAN_ATTRS: Readonly<Record<string, string>> = {
  open: "open",
  reversed: "reversed",
  hidden: "hidden",
};

/** HTML attribute names whose React prop is spelled differently. */
const PROP_NAMES: Readonly<Record<string, string>> = { class: "className", for: "htmlFor" };

/** The entities the renderer and the sanitizer escape with, plus numeric references. */
const ENTITY = /&(?:(amp|lt|gt|quot)|#(\d+)|#x([0-9a-f]+));/gi;
const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"' };

/** Undo the renderer's escaping: the text or attribute value the browser would see. */
function decode(s: string): string {
  return s.replace(ENTITY, (m, name: string | undefined, dec?: string, hex?: string) => {
    if (name !== undefined) return NAMED[name.toLowerCase()];
    const cp = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

/** One tag or comment of the renderer's (well-formed, double-quoted) output. */
const TAG =
  /<!--[\s\S]*?-->|<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'=<>/]+(?:="[^"]*")?)*)\s*\/?>/g;
const ATTR = /([^\s"'=<>/]+)(?:="([^"]*)")?/g;

/**
 * The renderer's HTML as a tree. Its output is generated (never passed through), so the grammar
 * is small; a close tag that doesn't match the innermost open element closes up to the nearest
 * one it does match (as a browser would for the misnested `<strong><em></strong></em>` the
 * inline pass can produce), and one with no open match is ignored.
 */
function parseRendered(html: string): MdNode[] {
  const root: MdElement = { tag: "", attrs: [], children: [] };
  const stack: MdElement[] = [root];
  let last = 0;
  const text = (s: string): void => {
    if (s !== "") stack[stack.length - 1].children.push(decode(s));
  };
  for (const m of html.matchAll(TAG)) {
    text(html.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      const name = m[1].toLowerCase();
      const at = stack.findLastIndex((el, k) => k > 0 && el.tag === name);
      if (at > 0) stack.length = at;
    } else if (m[2] !== undefined) {
      const tag = m[2].toLowerCase();
      const attrs: Array<readonly [string, string]> = [];
      for (const a of (m[3] ?? "").matchAll(ATTR)) {
        attrs.push([a[1].toLowerCase(), decode(a[2] ?? "")]);
      }
      const el: MdElement = { tag, attrs, children: [] };
      stack[stack.length - 1].children.push(el);
      if (!VOID.has(tag)) stack.push(el);
    }
  }
  text(html.slice(last));
  return root.children;
}

/** An element's attributes as props in React spelling. */
function propsOf(el: MdElement): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [name, value] of el.attrs) {
    const bool = BOOLEAN_ATTRS[name];
    if (bool !== undefined) props[bool] = true;
    else props[PROP_NAMES[name] ?? name] = value;
  }
  return props;
}

/** The `code` override's extra props: inline or block, and the fence's language. */
function codeProps(parent: MdElement | null): { inline: boolean; lang?: string } {
  if (parent?.tag !== "pre") return { inline: true };
  const lang = parent.attrs.find(([n]) => n === "data-lang")?.[1];
  return lang === undefined ? { inline: false } : { inline: false, lang };
}

/** A tree node as a denext node, with `components` standing in for the elements they name. */
function toNode(
  node: MdNode,
  parent: MdElement | null,
  components: MarkdownComponents,
): VNodeChildren {
  if (typeof node === "string") return node;
  const kids = node.children
    .filter((c) => !(NO_TEXT.has(node.tag) && typeof c === "string" && c.trim() === ""))
    .map((c) => toNode(c, node, components));
  const props = propsOf(node);
  const override = Object.hasOwn(components, node.tag) ? components[node.tag] : undefined;
  if (typeof override === "function") {
    const extra = node.tag === "code" ? codeProps(parent) : {};
    return h(override, { ...props, ...extra }, ...kids);
  }
  return h(typeof override === "string" ? override : node.tag, props, ...kids);
}

/**
 * Render Markdown as denext elements, with any element swapped for an app's own component.
 *
 * The document is rendered exactly as {@linkcode renderMarkdown} renders it (same options, same
 * escaping and URL rules) and then built as elements, so an override receives only what that
 * HTML would carry: the attributes in React spelling (`className`, `href`, `id`, …) and the
 * rendered children; a `code` override also gets `inline` and a fenced block's `lang`. No HTML
 * string is injected (no `dangerouslySetInnerHTML`): every text run is a text child.
 *
 * ```tsx
 * import { Markdown } from "denext/markdown";
 *
 * <Markdown
 *   source={post.body}
 *   html="sanitize"
 *   components={{ a: SiteLink, code: ({ inline, lang, children }) => … }}
 * />;
 * ```
 *
 * @param props The source, the element overrides, and {@linkcode MarkdownOptions}.
 * @returns A fragment of the document's block elements.
 */
export function Markdown(props: MarkdownProps): VNode {
  // `children` (if a caller passes any) is not an option: the source is the content.
  const { source, components = {}, children: _children, ...options } = props as
    & MarkdownProps
    & { children?: VNodeChildren };
  const tree = parseRendered(renderMarkdown(source, options));
  const blocks = tree
    .filter((n) => typeof n !== "string" || n.trim() !== "")
    .map((n) => toNode(n, null, components));
  return h(Fragment, null, ...blocks);
}
