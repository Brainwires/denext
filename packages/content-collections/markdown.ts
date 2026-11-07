/**
 * `@denext/content-collections/markdown` — the Markdown renderer behind `.md` entries
 * ({@link "./runtime.ts" | `renderContent`}). It is denext's own `denext/markdown` renderer,
 * re-exported here: raw HTML escaped by default, `html: "sanitize"` keeps what a first-party
 * allowlist sanitizer allows, and `javascript:` / `vbscript:` / `data:` link and image URLs are
 * dropped. For element overrides (`<Markdown components={…} />`), import `denext/markdown`.
 *
 * @module
 */

// The renderer lives in denext itself (`denext/markdown`, from 4.14.0). denext's type checker maps
// the workspace ROOT package to its published JSR types (members are linked locally), and the
// published 4.13.x has no `./markdown` entry, so the import is untyped until 4.14.0 is on JSR;
// the declarations below restate its types. At runtime it resolves to the workspace's own module.
// @ts-ignore -- `@denext/denext/markdown` is not in the published types the checker reads yet
import * as core from "@denext/denext/markdown";

/** How raw HTML in the source is treated: escaped as text (the default) or sanitized. */
export type MarkdownHtmlMode = "escape" | "sanitize";

/**
 * Extensions to the sanitizer's built-in allowlist. They can only ADD to it: the hard-denied
 * elements (`script`, `style`, `iframe`, `form`, `svg`, `math`, … and any namespaced or custom
 * element) and attributes (`on*`, `style`, `srcdoc`, `formaction`, `xlink:*`, any namespaced
 * name) are refused whatever is listed here.
 */
export interface SanitizeOptions {
  /** More element names to keep (lower-case HTML names such as `"center"`). */
  readonly allowElements?: readonly string[];
  /**
   * More attributes to keep, keyed by element name, or `"*"` for every element — for example
   * `{ "*": ["class"] }` keeps `class` (stripped by default) everywhere. A URL-bearing attribute
   * (`href`, `src`, `cite`, `poster`, …) is still scheme-checked.
   */
  readonly allowAttributes?: Readonly<Record<string, readonly string[]>>;
  /**
   * Keep `data:image/(png|gif|jpeg|webp);base64,…` URLs, on `<img src>` only (never SVG).
   * Default `false`.
   */
  readonly allowDataImages?: boolean;
}

/**
 * How `.md` entries render raw HTML: the plugin's `markdown` option (stored with each entry at
 * build, so it stays JSON) and {@linkcode renderMarkdown}'s options here. `denext/markdown`'s
 * `renderMarkdown` takes more (`headingIds`, `allowDataImages`, `urlPolicy`).
 */
export interface MarkdownOptions {
  /**
   * Raw HTML in the source: `"escape"` (the default) shows it as text; `"sanitize"` keeps what
   * the allowlist sanitizer allows (see {@linkcode sanitizeHtml}) and drops the rest.
   */
  readonly html?: MarkdownHtmlMode;
  /** With `html: "sanitize"`: additions to the sanitizer's built-in allowlist. */
  readonly sanitize?: SanitizeOptions;
}

/**
 * Render a Markdown body (frontmatter already stripped) to an HTML string — `denext/markdown`'s
 * `renderMarkdown`: raw HTML escaped unless `options.html` is `"sanitize"`.
 *
 * @param body The Markdown source, without frontmatter.
 * @param options How raw HTML is treated (escaped by default).
 * @returns The rendered HTML.
 */
export const renderMarkdown: (body: string, options?: MarkdownOptions) => string =
  core.renderMarkdown;

/**
 * Sanitize an HTML fragment against the first-party allowlist — `denext/markdown`'s
 * `sanitizeHtml`: re-serialized from a parsed tree, so only allowlisted markup comes out.
 *
 * @param html The HTML fragment.
 * @param options Additions to the built-in allowlist.
 * @returns The sanitized HTML.
 */
export const sanitizeHtml: (html: string, options?: SanitizeOptions) => string = core.sanitizeHtml;
