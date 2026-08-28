// A lightweight <Image> component (next/image-style ergonomics). denext does not
// ship an image-optimization server, so by default this renders a plain <img>
// with sensible defaults: lazy loading, async decoding, and explicit dimensions
// to avoid layout shift. A `loader` lets you delegate resizing to an external
// service (CDN); a widths list then generates a responsive `srcSet`. `priority`
// opts an above-the-fold image out of lazy loading; `placeholder="blur"` shows a
// blurred `blurDataURL` behind the image until it loads.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";

/** Arguments a {@link ImageLoader} receives to build a source URL. */
export interface ImageLoaderProps {
  /** The original `src`. */
  src: string;
  /** Target width in pixels. */
  width: number;
  /** Quality (1–100). */
  quality?: number;
}

/** Builds a (possibly resized) URL for a given width — e.g. a CDN transform. */
export type ImageLoader = (props: ImageLoaderProps) => string;

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
  /** Responsive `srcset` (candidate sources); auto-generated when a `loader` + widths are given. */
  srcSet?: string;
  /** Delegate resizing to an external service; enables `srcSet` generation. */
  loader?: ImageLoader;
  /** Candidate widths for the generated `srcSet` (with `loader`). */
  widths?: number[];
  /** Quality passed to the `loader` (1–100). */
  quality?: number;
  /** Load eagerly and skip lazy loading (for above-the-fold images). */
  priority?: boolean;
  /** Loading strategy; defaults to `lazy` (or `eager` when `priority`). */
  loading?: "lazy" | "eager";
  /** Show a blurred placeholder (needs `blurDataURL`) until the image loads. */
  placeholder?: "blur" | "empty";
  /** A tiny (data-URI) image shown blurred behind the image when `placeholder="blur"`. */
  blurDataURL?: string;
  /** Any other attributes forwarded to the `<img>`. */
  [key: string]: unknown;
}

const DEFAULT_WIDTHS = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];

/** URL path of denext's built-in image-optimization endpoint. */
export const IMAGE_ENDPOINT = "/_denext/image";

/**
 * The default {@link ImageLoader}: points at denext's `/_denext/image` endpoint,
 * which resizes + re-encodes (webp) the source image. Pass it explicitly:
 * `<Image loader={denextImageLoader} widths={[640, 1080]} … />`.
 */
export const denextImageLoader: ImageLoader = ({ src, width, quality }): string =>
  `${IMAGE_ENDPOINT}?url=${encodeURIComponent(src)}&w=${width}&q=${quality ?? 75}`;

/**
 * Resolve {@link ImageProps} into the final `<img>` attribute bag (src/srcSet/loading/
 * blur style/etc.). Shared by {@link Image} (which renders it) and {@link getImageProps}
 * (which returns it).
 */
function resolveImageProps(props: ImageProps): Record<string, unknown> {
  const {
    priority,
    loading,
    srcSet,
    loader,
    widths,
    quality,
    placeholder,
    blurDataURL,
    src,
    width,
    style,
    ...rest
  } = props;

  // With a loader, resize the default `src` and build a responsive `srcSet`.
  let finalSrc = src;
  let finalSrcSet = srcSet;
  if (loader) {
    finalSrc = loader({ src, width: width ?? DEFAULT_WIDTHS[DEFAULT_WIDTHS.length - 1], quality });
    const candidateWidths = widths ?? (width ? [width, width * 2] : DEFAULT_WIDTHS);
    finalSrcSet = candidateWidths
      .map((w) => `${loader({ src, width: w, quality })} ${w}w`)
      .join(", ");
  }

  // Blur placeholder: paint the low-res data URI behind the image until it loads.
  const blurStyle = placeholder === "blur" && blurDataURL
    ? {
      backgroundImage: `url("${blurDataURL}")`,
      backgroundSize: "cover",
      backgroundPosition: "center",
    }
    : undefined;
  const mergedStyle = blurStyle
    ? { ...(style as Record<string, unknown> | undefined), ...blurStyle }
    : style;

  return {
    ...rest,
    src: finalSrc,
    width,
    srcset: finalSrcSet,
    style: mergedStyle,
    loading: loading ?? (priority ? "eager" : "lazy"),
    decoding: "async",
    fetchpriority: priority ? "high" : undefined,
  };
}

/**
 * Render an accessible, layout-stable `<img>`: lazy + async-decoded by default,
 * eager when `priority` is set. With a `loader`, a responsive `srcSet` and a
 * resized default `src` are generated; with `placeholder="blur"`, the
 * `blurDataURL` is shown blurred behind the image until it loads.
 */
export function Image(props: ImageProps): VNode {
  return h("img", resolveImageProps(props));
}

/**
 * `next/image`'s `getImageProps` — resolve {@link ImageProps} to the concrete `<img>`
 * attributes without rendering, for spreading onto your own element (e.g. a background,
 * a `<picture>` source, or a custom `<img>`). Mirrors Next's `{ props }` return shape;
 * `srcSet` is exposed under both `srcSet` and `srcset` for convenience.
 *
 * @param props The image props.
 * @returns `{ props }` — the resolved `<img>` attributes.
 */
export function getImageProps(
  props: ImageProps,
): { props: Record<string, unknown> } {
  const resolved = resolveImageProps(props);
  return { props: { ...resolved, srcSet: resolved.srcset } };
}
