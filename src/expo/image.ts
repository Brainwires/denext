/**
 * `expo-image` for denext: an `Image` component over react-native-web's `Image` in React
 * Native mode, and a plain `<img>` elsewhere.
 *
 * `contentFit` maps to React Native's `resizeMode` (or CSS `object-fit`), `source` takes a
 * URL string, `{ uri }` or a list (the first is used), and a `file:///documents/…` URI from
 * `denext/expo/file-system` is loaded from the app's files. Placeholders, transitions,
 * blur-hash and the image cache controls are not provided (the cache calls resolve `true`).
 *
 * @example
 * ```ts
 * import { Image } from "denext/expo/image";
 * import { h } from "denext/jsx-runtime";
 *
 * h(Image, { source: { uri: avatarUrl }, contentFit: "cover", style: { width: 40, height: 40 } });
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { useEffect, useState } from "../runtime/hooks.ts";
import {
  flattenStyle,
  hasReactNative,
  hostView,
  nativeOnly,
  viewStyle,
} from "./internal/common.ts";
import { backing, displayUrl } from "./internal/fs.ts";
import * as RN from "./internal/react-native.ts";

/** How the image fills its box. */
export type ImageContentFit = "cover" | "contain" | "fill" | "none" | "scale-down";

/** An image source: a URL, `{ uri }`, or a list of them. */
export type ImageSource = string | { uri?: string; width?: number; height?: number } | null;

/** `Image` props. */
export interface ImageProps {
  /** The image. */
  source?: ImageSource | ImageSource[];
  /** How it fills the box (default `cover`). */
  contentFit?: ImageContentFit;
  /** Where it sits in the box (a CSS `object-position` string, or `{ top, left }`). */
  contentPosition?: string | Record<string, number | string>;
  /** Alt text. */
  alt?: string;
  /** Alt text (React Native name). */
  accessibilityLabel?: string;
  /** The style. */
  style?: unknown;
  /** Called once loaded. */
  onLoad?: (event: { source: { url: string; width: number; height: number } }) => void;
  /** Called when loading fails. */
  onError?: (event: { error: string }) => void;
  /** A placeholder (not provided). */
  placeholder?: unknown;
  /** A transition (not provided). */
  transition?: unknown;
  /** Other props. */
  [prop: string]: unknown;
}

/** `contentFit` → React Native's `resizeMode`. */
const RESIZE_MODE: Readonly<Record<ImageContentFit, string>> = {
  cover: "cover",
  contain: "contain",
  fill: "stretch",
  none: "center",
  "scale-down": "contain",
};

/** The first usable URL of a source. */
function sourceUri(source: ImageProps["source"]): string | null {
  if (Array.isArray(source)) return sourceUri(source[0]);
  if (typeof source === "string") return source;
  return source && typeof source === "object" ? source.uri ?? null : null;
}

/** A URL the platform can load for `uri` (a `blob:` URL for an app file, once read). */
function useLoadableUri(uri: string | null): string | null {
  const local = uri !== null && backing(uri) !== null;
  const [resolved, setResolved] = useState<string | null>(local ? null : uri);
  useEffect(() => {
    if (!local) {
      setResolved(uri);
      return;
    }
    let active = true;
    let url: string | undefined;
    displayUrl(uri!).then((u) => {
      url = u;
      if (active) setResolved(u);
      else URL.revokeObjectURL(u);
    }, () => active && setResolved(null));
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [uri]);
  return resolved;
}

/** `contentPosition` as CSS `object-position`. */
function objectPosition(position: ImageProps["contentPosition"]): string | undefined {
  if (typeof position === "string") return position;
  if (!position) return undefined;
  const px = (v: unknown) => (typeof v === "number" ? `${v}px` : String(v));
  return `${px(position.left ?? "50%")} ${px(position.top ?? "50%")}`;
}

/**
 * An image.
 *
 * @param props The image props.
 * @returns The image element.
 */
export function Image(props: ImageProps): VNode {
  const {
    source,
    contentFit = "cover",
    contentPosition,
    alt,
    accessibilityLabel,
    style,
    onLoad,
    onError,
    placeholder: _p,
    transition: _t,
    ...rest
  } = props;
  const uri = useLoadableUri(sourceUri(source));
  const label = alt ?? accessibilityLabel;
  if (hasReactNative() && RN.Image) {
    return h(RN.Image, {
      ...rest,
      accessibilityLabel: label,
      source: uri ? { uri } : undefined,
      resizeMode: RESIZE_MODE[contentFit] ?? "cover",
      style,
      onLoad: (e: { nativeEvent?: { source?: { width: number; height: number } } }) =>
        onLoad?.({
          source: {
            url: uri ?? "",
            width: e?.nativeEvent?.source?.width ?? 0,
            height: e?.nativeEvent?.source?.height ?? 0,
          },
        }),
      onError: () => onError?.({ error: `Could not load ${uri}` }),
    });
  }
  return h("img", {
    ...rest,
    src: uri ?? undefined,
    alt: label ?? "",
    style: {
      ...flattenStyle(style),
      objectFit: contentFit,
      objectPosition: objectPosition(contentPosition),
    },
    onLoad: (e: Event) => {
      const img = e.currentTarget as HTMLImageElement;
      onLoad?.({ source: { url: uri ?? "", width: img.naturalWidth, height: img.naturalHeight } });
    },
    onError: () => onError?.({ error: `Could not load ${uri}` }),
  });
}

/**
 * Preload images.
 *
 * @param urls One URL or several.
 * @returns `true` when every image loaded.
 */
Image.prefetch = async (urls: string | string[]): Promise<boolean> => {
  const ImageCtor = (globalThis as { Image?: new () => HTMLImageElement }).Image;
  if (!ImageCtor) return false;
  const results = await Promise.all(
    [urls].flat().map((url) =>
      new Promise<boolean>((resolve) => {
        const img = new ImageCtor();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = url;
      })
    ),
  );
  return results.every(Boolean);
};

/** Clear the memory cache (the browser owns it): resolves `true`. */
Image.clearMemoryCache = (): Promise<boolean> => Promise.resolve(true);

/** Clear the disk cache (the browser owns it): resolves `true`. */
Image.clearDiskCache = (): Promise<boolean> => Promise.resolve(true);

/** The cached file of `key` (the browser owns the cache): null. */
Image.getCachePathAsync = (_key: string): Promise<string | null> => Promise.resolve(null);

/** `ImageBackground` props: the image props plus the image's own style. */
export type ImageBackgroundProps = ImageProps & {
  /** The image's style (the container gets `style`). */
  imageStyle?: unknown;
  /** Content drawn over the image. */
  children?: unknown;
};

/**
 * An image behind other content.
 *
 * @param props The container style, the image props and `imageStyle`.
 * @returns The container.
 */
export function ImageBackground(props: ImageBackgroundProps): VNode {
  const { style, imageStyle, children, ...imageProps } = props;
  const fill = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 };
  const imageFill = hasReactNative()
    ? [fill, imageStyle]
    : { ...fill, ...flattenStyle(imageStyle) };
  return h(
    hostView(),
    { style: viewStyle(style) },
    h(Image, { ...imageProps, style: imageFill }),
    children as never,
  );
}

/**
 * The type of expo-image's native module (what `requireNativeModule("ExpoImage")` returns).
 * There is no native module on the web: constructing this stand-in throws. Use
 * {@linkcode Image} and its static cache calls instead.
 */
export class ImageNativeModule {
  /** Load an image into memory. */
  declare loadAsync: (source: ImageSource, options?: Record<string, unknown>) => Promise<unknown>;
  /** Preload images into the cache. */
  declare prefetch: (
    urls: string[],
    cachePolicy?: string,
    headers?: Record<string, string>,
  ) => Promise<boolean>;
  /** Clear the memory cache. */
  declare clearMemoryCache: () => Promise<boolean>;
  /** Clear the disk cache. */
  declare clearDiskCache: () => Promise<boolean>;
  /** Configure the cache limits. */
  declare configureCache: (config: Record<string, unknown>) => void;
  /** The cached file of a key. */
  declare getCachePathAsync: (cacheKey: string) => Promise<string | null>;
  /** Write an image to the cache under a key. */
  declare writeToCacheAsync: (source: unknown, cacheKey: string) => Promise<void>;
  /** Read an image from the cache. */
  declare readFromCacheAsync: (cacheKey: string) => Promise<unknown>;
  /** Compute an image's blurhash. */
  declare generateBlurhashAsync: (
    source: unknown,
    numberOfComponents: [number, number] | { width: number; height: number },
  ) => Promise<string | null>;
  /** Compute an image's thumbhash. */
  declare generateThumbhashAsync: (source: unknown) => Promise<string>;

  /** Always throws: there is no native image module on the web. */
  constructor() {
    throw nativeOnly("expo-image", "ImageNativeModule");
  }
}
