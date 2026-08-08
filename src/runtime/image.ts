// A lightweight <Image> component (next/image-style ergonomics). denext does not
// run an image optimization server, so this renders a plain <img> with sensible
// defaults: lazy loading, async decoding, and explicit dimensions to avoid
// layout shift. `priority` opts a above-the-fold image out of lazy loading.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";

/** Props for {@link Image}. Extra props pass through to the underlying `<img>`. */
export interface ImageProps {
  /** Image source URL. */
  src: string;
  /** Alternative text (required for accessibility). */
  alt: string;
  /** Intrinsic width in pixels (prevents layout shift). */
  width?: number;
  /** Intrinsic height in pixels (prevents layout shift). */
  height?: number;
  /** Responsive `sizes` attribute. */
  sizes?: string;
  /** Responsive `srcset` (candidate sources). */
  srcSet?: string;
  /** Load eagerly and skip lazy loading (for above-the-fold images). */
  priority?: boolean;
  /** Loading strategy; defaults to `lazy` (or `eager` when `priority`). */
  loading?: "lazy" | "eager";
  /** Any other attributes forwarded to the `<img>`. */
  [key: string]: unknown;
}

/**
 * Render an accessible, layout-stable `<img>`: lazy + async-decoded by default,
 * eager when `priority` is set.
 */
export function Image(props: ImageProps): VNode {
  const { priority, loading, srcSet, ...rest } = props;
  return h("img", {
    ...rest,
    srcset: srcSet,
    loading: loading ?? (priority ? "eager" : "lazy"),
    decoding: "async",
    fetchpriority: priority ? "high" : undefined,
  });
}
