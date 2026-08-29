// A next/image-style <Image> component. Like Next, it **optimizes by default**: with no
// explicit `loader` it routes through denext's built-in `/_denext/image` endpoint
// (resize + webp/avif) and generates a responsive `srcSet` from the configured width
// allowlist. Opt out per-image with `unoptimized` (or globally via `images.unoptimized`)
// to render a plain `<img>` with the raw `src` — which is also what a static export uses,
// since there is no server to optimize against. Every image is lazy-loaded, async-decoded,
// and (with `width`/`height`) layout-stable; `priority` opts an above-the-fold image out of
// lazy loading and emits an SSR preload; `placeholder="blur"` paints a `blurDataURL` behind
// it until it loads. A custom `loader` delegates resizing to an external CDN.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { preload } from "../compat/react-dom-preload.ts";

// Next's default width allowlists (kept in sync with src/server/image-optimizer.ts's
// DEFAULT_DEVICE_SIZES / DEFAULT_IMAGE_SIZES). The optimizer refuses any `w=` outside
// `deviceSizes ∪ imageSizes` (an anti-DoS bound), so the default loader must draw its
// `srcSet` widths from exactly this set.
const DEFAULT_DEVICE_SIZES = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
const DEFAULT_IMAGE_SIZES = [32, 48, 64, 96, 128, 256, 384];

/** Runtime image config (mirrors the `images` config the optimizer validates against). */
interface ImageRuntimeConfig {
  /** Render a plain `<img>` (no optimizer) — set globally by static export / config. */
  unoptimized: boolean;
  /** Full-width responsive breakpoints (the optimizer's `w=` allowlist, part 1). */
  deviceSizes: number[];
  /** Fixed icon/thumbnail widths (the optimizer's `w=` allowlist, part 2). */
  imageSizes: number[];
}

let runtimeConfig: ImageRuntimeConfig = {
  unoptimized: false,
  deviceSizes: DEFAULT_DEVICE_SIZES,
  imageSizes: DEFAULT_IMAGE_SIZES,
};

/**
 * Set the process-wide image runtime config. The server/dev entry calls this from
 * `images` config at startup; static export calls it with `{ unoptimized: true }` (no
 * server to optimize against). The client hydration entry calls it from the embedded
 * `#__denext_image_config` island so a client re-render matches the server's output.
 *
 * @param cfg Partial config; unspecified fields keep their current value.
 */
export function setImageRuntimeConfig(cfg: Partial<ImageRuntimeConfig>): void {
  runtimeConfig = {
    unoptimized: cfg.unoptimized ?? runtimeConfig.unoptimized,
    deviceSizes: cfg.deviceSizes ?? runtimeConfig.deviceSizes,
    imageSizes: cfg.imageSizes ?? runtimeConfig.imageSizes,
  };
}

/** The current image runtime config (for embedding into the page for the client). */
export function getImageRuntimeConfig(): ImageRuntimeConfig {
  return runtimeConfig;
}

/**
 * Whether the config differs from the default optimizing baseline (unoptimized off, default
 * width allowlists) — in which case the server must embed it so a client re-render matches.
 * The common case (default optimize) needs no island: the client default already matches.
 */
export function imageConfigNeedsEmbed(): boolean {
  return runtimeConfig.unoptimized ||
    runtimeConfig.deviceSizes !== DEFAULT_DEVICE_SIZES ||
    runtimeConfig.imageSizes !== DEFAULT_IMAGE_SIZES;
}

/** id of the JSON island the server embeds so the client's `<Image>` matches its output. */
export const IMAGE_CONFIG_ID = "__denext_image_config";

// On the client, adopt the embedded config once (before the first `<Image>` resolves), so a
// client re-render reproduces the server's output — notably a static export, where the
// server rendered plain `<img>` (`unoptimized`) but the client default would otherwise
// optimize. A no-op during SSR (no global `document`) and when no island was embedded.
let clientConfigRead = false;
function ensureClientConfig(): void {
  if (clientConfigRead) return;
  clientConfigRead = true;
  if (typeof document === "undefined") return;
  try {
    const el = document.getElementById(IMAGE_CONFIG_ID);
    if (el) {
      setImageRuntimeConfig(JSON.parse(el.textContent ?? "{}") as Partial<ImageRuntimeConfig>);
    }
  } catch {
    // keep defaults on a missing/malformed island
  }
}

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
  /** Skip optimization — render a plain `<img>` with the raw `src` (Next parity). */
  unoptimized?: boolean;
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

/** URL path of denext's built-in image-optimization endpoint. */
export const IMAGE_ENDPOINT = "/_denext/image";

/**
 * The default {@link ImageLoader}: points at denext's `/_denext/image` endpoint, which
 * resizes + re-encodes (webp/avif) the source image. Used automatically unless an image
 * is `unoptimized`; also available to pass explicitly.
 */
export const denextImageLoader: ImageLoader = ({ src, width, quality }): string =>
  `${IMAGE_ENDPOINT}?url=${encodeURIComponent(src)}&w=${width}&q=${quality ?? 75}`;

/**
 * Choose the candidate `srcSet` widths for a loader. The built-in loader must draw from
 * the configured allowlist (`deviceSizes ∪ imageSizes`) — the optimizer 400s any other
 * `w=`; for a **responsive** image (`sizes` set) use the full device-size ladder, and for
 * a **fixed** image the nearest allowlisted widths at 1× and 2×. A custom CDN loader
 * accepts arbitrary widths, so it keeps the simple `[w, 2w]` (or the device ladder).
 */
function candidateWidthsFor(
  loader: ImageLoader,
  width: number | undefined,
  hasSizes: boolean,
): number[] {
  if (loader !== denextImageLoader) {
    return width ? [width, width * 2] : runtimeConfig.deviceSizes;
  }
  if (hasSizes || width === undefined) return runtimeConfig.deviceSizes;
  const allowed = [...runtimeConfig.imageSizes, ...runtimeConfig.deviceSizes].sort((a, b) => a - b);
  const atLeast = (target: number) =>
    allowed.find((w) => w >= target) ?? allowed[allowed.length - 1];
  return [...new Set([atLeast(width), atLeast(width * 2)])];
}

/**
 * Resolve {@link ImageProps} into the final `<img>` attribute bag (src/srcSet/loading/
 * blur style/etc.). Shared by {@link Image} (which renders it) and {@link getImageProps}
 * (which returns it).
 */
function resolveImageProps(props: ImageProps): Record<string, unknown> {
  ensureClientConfig();
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
    unoptimized,
    ...rest
  } = props;

  // Optimize by default (Next parity): with no explicit loader, and unless this image or
  // the app is `unoptimized`, route through denext's own optimizer endpoint. A custom
  // loader always wins; `unoptimized` forces a plain `<img>` with the raw `src`.
  const skip = unoptimized ?? runtimeConfig.unoptimized;
  const effectiveLoader = loader ?? (skip ? undefined : denextImageLoader);

  // Build a responsive `srcSet` (and a resized default `src`) when a loader is in effect
  // and the caller didn't supply an explicit `srcSet`.
  let finalSrc = src;
  let finalSrcSet = srcSet;
  if (effectiveLoader && srcSet === undefined) {
    const candidateWidths = widths ?? candidateWidthsFor(effectiveLoader, width, !!props.sizes);
    finalSrcSet = candidateWidths
      .map((w) => `${effectiveLoader({ src, width: w, quality })} ${w}w`)
      .join(", ");
    // The plain `src` points at the largest candidate (highest-DPI fallback).
    finalSrc = effectiveLoader({ src, width: Math.max(...candidateWidths), quality });
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
  const attrs = resolveImageProps(props);
  // LCP: a `priority` image is above the fold, so emit a `<link rel="preload"
  // as="image">` into the SSR head (via the react-dom preload hoist) to start the
  // fetch before the parser reaches the <img>. SSR only — on the client the <img>
  // is already fetching, so a preload there is pure redundancy. `head()` in the
  // preload module already routes SSR→sink / client→document.head, so we simply
  // skip the call when a document exists.
  if (props.priority && typeof (globalThis as { document?: unknown }).document === "undefined") {
    preload(attrs.src as string, {
      as: "image",
      fetchPriority: "high",
      imageSrcSet: attrs.srcset as string | undefined,
      imageSizes: props.sizes,
    });
  }
  return h("img", attrs);
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
