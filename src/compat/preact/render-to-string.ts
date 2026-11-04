/**
 * `denext/preact/render-to-string` — `preact-render-to-string` on denext (`denext migrate` maps
 * `preact-render-to-string` and `preact-render-to-string/stream` here): `renderToString` (also
 * the default export and `render`), `renderToStaticMarkup`, `renderToStringAsync` and
 * `renderToReadableStream`. The tree renders through denext's server renderer (hooks, context,
 * Suspense, class components), written with Preact's markup conventions:
 *
 * - void elements self-close (`<br/>`), and a boolean or empty attribute is bare (`disabled`,
 *   `alt`); boolean attributes are lowercased (`readonly`, `autofocus`);
 * - `class` wins over `className`;
 * - text and attribute values escape only `&`, `<` and `"`;
 * - a style object's declarations each end with `;`;
 * - no Suspense markers, except `<!--$s-->…<!--/$s-->` around a boundary that suspended in an
 *   async render, and a synchronous render that suspends throws (use `renderToStringAsync`).
 *
 * Differences: attributes keep denext's order (Preact writes an `<option>`'s `selected` first),
 * camelCase SVG presentation attributes are always hyphenated (`stroke-width`), a defaulted
 * `<input>` value yields to a controlled one (Preact writes both), the `context` argument (a
 * legacy context object) is ignored, and `renderToReadableStream` sends the whole document once
 * every boundary has resolved instead of streaming fallbacks first.
 *
 * @module
 */

import type { VNode } from "../../jsx/types.ts";
import {
  type FlavoredRenderOptions,
  type MarkupFlavor,
  renderToString as renderAsync,
  renderToStringSync,
  serializeAttributes,
} from "../../jsx/render-to-string.ts";
import { booleanAttrName } from "../../jsx/dom-attributes.ts";

const PREACT_TEXT_ESCAPE = /[&<"]/g;
const PREACT_ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", '"': "&quot;" };

/** Preact's text / attribute escaping: `&`, `<` and `"` only. */
function preactEscape(value: string): string {
  return value.replace(PREACT_TEXT_ESCAPE, (c) => PREACT_ENTITIES[c]);
}

/** `props` with `className` dropped under a `class`, and boolean props lowercased. */
function preactProps(props: Record<string, unknown>): Record<string, unknown> {
  const out = { ...props };
  if (out.class !== undefined) delete out.className;
  for (const name in props) {
    const lower = name.toLowerCase();
    if (lower === name || booleanAttrName(name) === undefined) continue;
    delete out[name];
    out[lower] = props[name];
  }
  return out;
}

/**
 * The attribute text in Preact's form. Every value denext writes is double-quoted with `"`
 * escaped, so an empty value (`=""`) and the `&gt;` / `&#39;` entities are only ever its own.
 */
function preactAttributes(props: Record<string, unknown>, tag: string): string {
  return serializeAttributes(preactProps(props), tag)
    .replace(/ ([^\s="]+)=""/g, " $1")
    .replace(/&gt;|&#39;/g, (m) => (m === "&gt;" ? ">" : "'"))
    .replace(/ style="([^"]*[^;"])"/, ' style="$1;"');
}

/** The message preact-render-to-string throws when a synchronous render suspends. */
const SYNC_SUSPENDED = 'Use "renderToStringAsync" for suspenseful rendering.';

/** Preact's markup conventions for denext's server renderer. */
const PREACT_MARKUP: MarkupFlavor = {
  text: preactEscape,
  attributes: preactAttributes,
  voidClose: "/",
  suspendedMarks: ["<!--$s-->", "<!--/$s-->"],
  syncSuspended() {
    throw new Error(SYNC_SUSPENDED);
  },
};

/** The render options that select Preact's markup. */
const PREACT_RENDER: FlavoredRenderOptions = { markup: PREACT_MARKUP };

/**
 * Render a tree to HTML synchronously, with Preact's markup conventions. A component that
 * suspends makes it throw: render that tree with {@link renderToStringAsync}.
 *
 * @param vnode The tree.
 * @param _context A legacy context object (ignored on denext).
 * @returns The HTML.
 */
export function renderToString(
  vnode: VNode,
  _context?: unknown,
): string {
  return renderToStringSync(vnode, PREACT_RENDER);
}

/** preact-render-to-string's `render`: {@link renderToString}. */
export const render: typeof renderToString = renderToString;

/** preact-render-to-string's `renderToStaticMarkup`: {@link renderToString} (no hydration markup). */
export const renderToStaticMarkup: typeof renderToString = renderToString;

export default renderToString;

/**
 * Render a tree to HTML, waiting for every suspended subtree (a `lazy()` component, thrown
 * data) to resolve. A boundary that suspended is bracketed with `<!--$s-->` / `<!--/$s-->`.
 *
 * @param vnode The tree.
 * @param _context A legacy context object (ignored on denext).
 * @returns The HTML.
 */
export function renderToStringAsync(
  vnode: VNode,
  _context?: unknown,
): Promise<string> {
  return renderAsync(vnode, PREACT_RENDER);
}

/** Options of {@link renderToReadableStream}. */
export interface RenderToReadableStreamOptions {
  /** A nonce for inline scripts (denext's stream writes none). */
  nonce?: string;
}

/** The stream {@link renderToReadableStream} returns: `allReady` settles once it is written. */
export interface RenderStream extends ReadableStream<Uint8Array> {
  /** Resolves when the whole document has been enqueued (rejects with a render error). */
  allReady: Promise<void>;
}

/**
 * Render a tree to a stream of UTF-8 HTML (`preact-render-to-string/stream`). denext writes
 * the document once every Suspense boundary has resolved, as {@link renderToStringAsync} does.
 *
 * @param vnode The tree.
 * @param _options Stream options (`nonce`; unused, no inline script is written).
 * @param _context A legacy context object (ignored on denext).
 * @returns The stream, with `allReady`.
 */
export function renderToReadableStream(
  vnode: VNode,
  _options?: RenderToReadableStreamOptions,
  _context?: unknown,
): RenderStream {
  const html = renderToStringAsync(vnode);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(new TextEncoder().encode(await html));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
  const allReady = html.then(() => {});
  // Unobserved, a failed render still errors the stream; don't also surface an unhandled rejection.
  allReady.catch(() => {});
  return Object.assign(stream, { allReady });
}
