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
  /** Target locale (i18n): prefixes an app-absolute `href` with `/{locale}`. */
  locale?: string;
  /** Anchor className. */
  className?: string;
  /** Link content (text or elements) rendered inside the `<a>`. */
  children?: VNodeChildren;
  /** Any other anchor attributes are forwarded. */
  [key: string]: unknown;
}

/** A client-side navigation link (renders an `<a href>`). */
export function Link(props: LinkProps): VNode {
  const { href, replace, prefetch, locale, children, ...rest } = props;
  // i18n: an explicit `locale` prefixes an app-absolute href, so the click lands on
  // the localized route (the client runtime's soft nav then fetches that URL).
  const finalHref = locale && href.startsWith("/") ? `/${locale}${href}` : href;
  // `data-denext-prefetch` opts the anchor into the client runtime's viewport prefetch
  // observer; `data-denext-replace` makes the soft nav replace (not push) history.
  // Without either the link still soft-navigates (pushing) on click.
  const attrs: Record<string, unknown> = { href: finalHref, ...rest };
  if (prefetch) attrs["data-denext-prefetch"] = "";
  if (replace) attrs["data-denext-replace"] = "";
  return h("a", attrs, children);
}

// `next/link`'s public API is a default export — mirror it (like `./head` does) so an
// unmodified `import Link from "next/link"` resolves when the app maps next/link here.
export default Link;
