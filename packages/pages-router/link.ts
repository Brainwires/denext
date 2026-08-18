/**
 * `next/link` for the Pages Router. Renders an anchor to `href`. In v0.1 this is a
 * normal link (full navigation); soft client-side navigation is planned.
 *
 * @module
 */

import { h } from "@denext/denext";
import type { VNodeChildren } from "@denext/denext/server";

/** Props for {@linkcode Link} (a subset of Next's `LinkProps`). */
export interface LinkProps {
  /** Destination path. */
  href: string;
  /** Replace history instead of pushing (honored on the client). */
  replace?: boolean;
  /** Prefetch on viewport (a no-op in v0.1). */
  prefetch?: boolean;
  /** Anchor className. */
  className?: string;
  children?: VNodeChildren;
  /** Any other anchor attributes are forwarded. */
  [key: string]: unknown;
}

/** A client-side navigation link (renders an `<a href>`). */
export function Link(props: LinkProps): ReturnType<typeof h> {
  const { href, replace: _replace, prefetch: _prefetch, children, ...rest } = props;
  return h("a", { href, ...rest }, children);
}
