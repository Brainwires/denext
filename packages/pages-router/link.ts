/**
 * `next/link` for the Pages Router. Renders a plain `<a href>` — the client
 * runtime intercepts same-origin left-clicks (on any internal anchor, `Link` or
 * not) and turns them into **soft (SPA) navigation**; without JS it degrades to a
 * normal link. So `Link` needs no client-only behavior of its own.
 *
 * @module
 */

import { h } from "@denext/denext";
import type { VNode } from "@denext/denext";
import type { VNodeChildren } from "@denext/denext/server";

export type { VNode } from "@denext/denext";
export type { VNodeChildren } from "@denext/denext/server";

/** Props for {@linkcode Link} (a subset of Next's `LinkProps`). */
export interface LinkProps {
  /** Destination path. */
  href: string;
  /** Replace history instead of pushing (honored on the client). */
  replace?: boolean;
  /** Prefetch the route's code chunk when the link scrolls into view (opt-in). */
  prefetch?: boolean;
  /** Anchor className. */
  className?: string;
  /** Link content (text or elements) rendered inside the `<a>`. */
  children?: VNodeChildren;
  /** Any other anchor attributes are forwarded. */
  [key: string]: unknown;
}

/** A client-side navigation link (renders an `<a href>`). */
export function Link(props: LinkProps): VNode {
  const { href, replace: _replace, prefetch, children, ...rest } = props;
  // `data-denext-prefetch` opts the anchor into the client runtime's viewport
  // prefetch observer; without it the link still soft-navigates on click.
  const attrs = prefetch ? { href, "data-denext-prefetch": "", ...rest } : { href, ...rest };
  return h("a", attrs, children);
}
