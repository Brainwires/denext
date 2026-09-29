/**
 * `react-native-fast-image` for denext (React Native mode): `FastImage` is React Native's
 * `Image` (react-native-web's, so the browser's image cache), since the package's native view
 * has no web build and rendered nothing. `source` (`{ uri, headers }` or a bundled image),
 * `resizeMode` (`contain`, `cover`, `stretch`, `center`), `tintColor`, `defaultSource`,
 * `onLoadStart` / `onLoad` (`nativeEvent: { width, height }`) / `onError` / `onLoadEnd` and
 * children (drawn over the image) work. `priority` and `cache` are accepted and ignored (the
 * browser owns caching), `onProgress` never fires, `preload()` warms the browser cache and the
 * `clear*Cache()` calls resolve at once.
 *
 * @example
 * ```ts
 * import FastImage from "react-native-fast-image"; // → this module
 * import { h } from "denext/jsx-runtime";
 *
 * h(FastImage, {
 *   source: { uri: "https://example.com/a.jpg", priority: FastImage.priority.high },
 *   resizeMode: FastImage.resizeMode.cover,
 *   style: { width: 120, height: 120 },
 * });
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { flattenStyle, hostView, viewStyle } from "../expo/internal/common.ts";
import * as RN from "./internal/react-native.ts";

/** How the image fills its box. */
export type ResizeMode = "contain" | "cover" | "stretch" | "center";
/** A load priority (ignored). */
export type Priority = "low" | "normal" | "high";
/** A cache policy (ignored: the browser caches). */
export type Cache = "immutable" | "web" | "cacheOnly";

/** An image source. */
export type Source = {
  /** The URL. */
  uri?: string;
  /** Request headers (sent by react-native-web's loader where it can). */
  headers?: { [key: string]: string };
  /** Ignored. */
  priority?: Priority;
  /** Ignored. */
  cache?: Cache;
};

/** `onLoad`'s event. */
export interface OnLoadEvent {
  /** The image's size. */
  nativeEvent: { width: number; height: number };
}

/** `onProgress`'s event (never fired here). */
export interface OnProgressEvent {
  /** Bytes loaded and total. */
  nativeEvent: { loaded: number; total: number };
}

/** `FastImage` props. */
export interface FastImageProps {
  /** The image: a source, or a bundled image (`require("./a.png")`). */
  source?: Source | string | number;
  /** Shown while loading. */
  defaultSource?: string | number;
  /** How the image fills its box (default `cover`). */
  resizeMode?: ResizeMode;
  /** Ignored. */
  fallback?: boolean;
  /** Loading started. */
  onLoadStart?: () => void;
  /** Never fired. */
  onProgress?: (event: OnProgressEvent) => void;
  /** Loaded. */
  onLoad?: (event: OnLoadEvent) => void;
  /** Failed. */
  onError?: () => void;
  /** Loaded or failed. */
  onLoadEnd?: () => void;
  /** Tints the image's opaque pixels. */
  tintColor?: string;
  /** The style. */
  style?: unknown;
  /** Drawn over the image. */
  children?: VNodeChildren;
  /** Other view props. */
  [prop: string]: unknown;
}

/** The resize modes. */
const resizeMode = {
  contain: "contain",
  cover: "cover",
  stretch: "stretch",
  center: "center",
} as const;
/** The priorities. */
const priority = { low: "low", normal: "normal", high: "high" } as const;
/** The cache policies. */
const cacheControl = { immutable: "immutable", web: "web", cacheOnly: "cacheOnly" } as const;

/** React Native's image source for a FastImage source. */
function imageSource(source: FastImageProps["source"]): unknown {
  if (source === null || source === undefined || typeof source !== "object") return source;
  return source.headers ? { uri: source.uri, headers: source.headers } : { uri: source.uri };
}

/** A source's URL, for the DOM fallback. */
function sourceUrl(source: FastImageProps["source"]): string | undefined {
  if (typeof source === "string") return source;
  return typeof source === "object" && source ? source.uri : undefined;
}

/** The DOM `object-fit` of a resize mode. */
const OBJECT_FIT: Readonly<Record<ResizeMode, string>> = {
  contain: "contain",
  cover: "cover",
  stretch: "fill",
  center: "none",
};

/** The image itself: react-native-web's `Image`, else an `<img>`. */
function image(props: FastImageProps, fill: boolean): VNode {
  const { source, defaultSource, resizeMode: mode = "cover", tintColor, onLoad, style } = props;
  const size = fill ? { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } : undefined;
  if (RN.Image) {
    return h(RN.Image, {
      source: imageSource(source),
      defaultSource,
      resizeMode: mode,
      onLoadStart: props.onLoadStart,
      onError: props.onError,
      onLoadEnd: props.onLoadEnd,
      onLoad: onLoad
        ? (e: { nativeEvent?: { source?: { width?: number; height?: number } } }) =>
          onLoad({
            nativeEvent: {
              width: e?.nativeEvent?.source?.width ?? 0,
              height: e?.nativeEvent?.source?.height ?? 0,
            },
          })
        : undefined,
      style: fill
        ? [style, size, tintColor ? { tintColor } : null]
        : [style, tintColor ? { tintColor } : null],
    });
  }
  return h("img", {
    src: sourceUrl(source),
    alt: "",
    onLoad: (e: Event) => {
      const img = e.currentTarget as HTMLImageElement;
      onLoad?.({ nativeEvent: { width: img.naturalWidth, height: img.naturalHeight } });
      props.onLoadEnd?.();
    },
    onError: () => {
      props.onError?.();
      props.onLoadEnd?.();
    },
    style: { ...flattenStyle(style), ...size, objectFit: OBJECT_FIT[mode] ?? "cover" },
  });
}

/**
 * An image, with `children` drawn over it.
 *
 * @param props The source, resize mode, callbacks and style.
 * @returns The image.
 */
function FastImageView(props: FastImageProps): VNode {
  if (props.children === undefined || props.children === null) return image(props, false);
  const outer = flattenStyle(props.style);
  return h(
    hostView(),
    { style: viewStyle(outer, { overflow: "hidden" }) },
    image({ ...props, style: undefined }, true),
    props.children,
  );
}

/**
 * Warm the browser cache for `sources`.
 *
 * @param sources The images.
 */
function preload(sources: readonly Source[]): void {
  const Img = (globalThis as { Image?: new () => HTMLImageElement }).Image;
  if (typeof Img !== "function") return;
  for (const s of sources) {
    if (!s?.uri) continue;
    const img = new Img();
    img.src = s.uri;
  }
}

/** The browser owns the image cache: nothing to clear. */
function clearCache(): Promise<void> {
  return Promise.resolve();
}

/** `FastImage`'s statics. */
export interface FastImageStaticProperties {
  /** The resize modes. */
  resizeMode: typeof resizeMode;
  /** The priorities. */
  priority: typeof priority;
  /** The cache policies. */
  cacheControl: typeof cacheControl;
  /** Warm the cache. */
  preload: (sources: Source[]) => void;
  /** Resolves at once. */
  clearMemoryCache: () => Promise<void>;
  /** Resolves at once. */
  clearDiskCache: () => Promise<void>;
}

/** `FastImage`: React Native's `Image` with the package's statics. */
const FastImage: ((props: FastImageProps) => VNode) & FastImageStaticProperties =
  /* @__PURE__ */ Object.assign(FastImageView, {
    resizeMode,
    priority,
    cacheControl,
    preload,
    clearMemoryCache: clearCache,
    clearDiskCache: clearCache,
  });

export default FastImage;
