// The component substrate of `denext ui`: render a view's VNode tree to a pre-escaped fragment
// ({@linkcode RawHtml}) — what the page seam takes, and what the form renderer's string API
// (`renderWidget`, `control`, `field`, `opButton`) returns for a panel to embed with `Raw`.
//
// Views are built with `h()` from the JSX runtime, in `.ts` files — never JSX syntax. JSR rewrites
// a package's `compilerOptions.jsxImportSource` into a per-file `@jsxImportSource` pragma resolved
// through the import map at publish time, and denext's own `"denext"` source maps to `./mod.ts`,
// so a `.tsx` view would resolve `<mod.ts>/jsx-runtime` when `denext ui` runs from `jsr:`.
//
// This module is the LEAF of the UI view layer: it imports only the JSX runtime and the string
// renderer (both already in the UI server's module graph via `mod.ts`), never `html.ts` — which
// imports it. The renderer is used purely as a string serialiser: the UI ships no hydration, no
// islands and no inline script (the page CSP stays `script-src 'self'`), so a view is rendered
// once, synchronously, on the server, and nothing about it reaches the client as code.
//
// The renderer escapes every text child and attribute value, with NAMED references — `&amp;`
// `&lt;` `&gt;` `&quot;` — and `&#39;`, safe in text and in double-quoted attributes alike.

import { h } from "../jsx/jsx-runtime.ts";
import { renderToStringSync } from "../jsx/render-to-string.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";

/** A pre-escaped HTML fragment: {@linkcode Raw} inserts it into a component tree verbatim. */
export interface RawHtml {
  /** The already-safe markup. */
  readonly __html: string;
}

/**
 * The host element {@linkcode Raw} renders its markup inside. The string renderer only emits
 * `dangerouslySetInnerHTML` on a host element, so `Raw` wraps its markup in this marker and
 * {@linkcode renderView} strips the marker again — the fragment lands with no wrapper at all.
 * Text children and attribute values are always escaped by the renderer, so the literal marker
 * can only ever come from `Raw` itself (or from trusted markup that spells it out).
 */
const RAW_TAG = "denext-ui-raw";

/** Every opening and closing marker `Raw` leaves in the renderer's output. */
const RAW_MARKER = new RegExp(`</?${RAW_TAG}>`, "g");

/**
 * Render a component view to a pre-escaped fragment — synchronously, with no hydration markers
 * and no client code. The result nests inside another tree through {@linkcode Raw} without
 * being escaped a second time. A throwing component throws out of this call (the UI server
 * answers `500`), and so does an async component: a view must be synchronous.
 *
 * Always render UI views through this function (or `renderPage`), never the renderer directly —
 * it is what removes {@linkcode Raw}'s wrapper.
 *
 * @param node The view's element tree.
 * @returns The rendered markup as a fragment.
 */
export function renderView(node: VNodeChildren): RawHtml {
  return { __html: renderToStringSync(node).replace(RAW_MARKER, "") };
}

/**
 * Insert already-escaped markup into a component tree verbatim — how a fragment the form
 * renderer's string API returned (`renderWidget`, `control`, `field`, `opButton`) nests inside a
 * component view. A `RawHtml` placed directly as a child is NOT rendered as markup; wrap it in
 * `Raw`.
 *
 * **TRUSTED MARKUP ONLY.** The markup must be the output of {@linkcode renderView} (or a form
 * renderer call built on it), or a literal the caller wrote — never user or project text.
 * Anything passed here reaches the page unescaped; put untrusted text in a child or an attribute
 * instead, where the renderer escapes it.
 *
 * @param props The trusted fragment (or trusted markup string) to insert.
 * @returns The element that renders it (its marker wrapper is removed by {@linkcode renderView}).
 */
export function Raw({ html }: { readonly html: RawHtml | string }): VNode {
  const markup = typeof html === "string" ? html : html.__html;
  return h(RAW_TAG, { dangerouslySetInnerHTML: { __html: markup } });
}
