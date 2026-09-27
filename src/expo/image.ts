/**
 * `expo-image` for denext: an `Image` component over react-native-web's `Image` in React
 * Native mode, and a plain `<img>` elsewhere, with Expo's statics.
 *
 * - `source` takes a URL string, `{ uri }`, a list (the first is used), an {@linkcode ImageRef},
 *   or a BlurHash / ThumbHash (`{ blurhash }`, `{ thumbhash }`, `"blurhash:/…"`,
 *   `"thumbhash:/…"`). A `file:///documents/…` URI from `denext/expo/file-system` is loaded
 *   from the app's files.
 * - `placeholder` (a URL, a source, or a hash) shows until the image loads, fitted by
 *   `placeholderContentFit`; hashes are decoded in JS (no canvas needed). `transition` fades
 *   the image in (a number of ms, or `{ duration, timing }`; every effect is a cross-dissolve).
 * - `contentFit` / `contentPosition` are CSS `object-fit` / `object-position`; `blurRadius` is a
 *   CSS blur. `recyclingKey` shows the placeholder again when it changes.
 * - `cachePolicy` is best effort: `"disk"` / `"memory-disk"` read an image
 *   {@linkcode Image.prefetch} (or `writeToCacheAsync`) stored with the Cache API, `"memory"`
 *   reads the ones loaded this session; otherwise the browser's HTTP cache decides.
 *
 * With a placeholder, a transition, a position, a blur, or `contentFit` `none` /
 * `scale-down`, React Native mode draws the image as `<img>` layers in a view instead of
 * react-native-web's `Image` (which has no such options).
 *
 * The statics: `prefetch`, `loadAsync`, `clearMemoryCache`, `clearDiskCache`,
 * `getCachePathAsync`, `writeToCacheAsync`, `readFromCacheAsync`, `configureCache` (accepted,
 * limits not enforced), `generateBlurhashAsync` / `generateThumbhashAsync` (need a canvas),
 * and `Image.Image` ({@linkcode ImageRef}). Not provided: `tintColor` (ignored) and animated
 * image control (`startAnimating` / `stopAnimating` resolve without effect).
 *
 * @example
 * ```ts
 * import { Image } from "denext/expo/image";
 * import { h } from "denext/jsx-runtime";
 *
 * h(Image, {
 *   source: { uri: avatarUrl },
 *   placeholder: { blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" },
 *   transition: 200,
 *   contentFit: "cover",
 *   style: { width: 40, height: 40 },
 * });
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { useEffect, useImperativeHandle, useRef, useState } from "../runtime/hooks.ts";
import {
  flattenStyle,
  hasReactNative,
  hostView,
  nativeOnly,
  viewStyle,
} from "./internal/common.ts";
import { backing, displayUrl } from "./internal/fs.ts";
import {
  bytesBase64,
  hashPlaceholderUrl,
  type RgbaImage,
  rgbaToBlurhash,
  rgbaToThumbhash,
} from "./internal/image-hash.ts";
import * as RN from "./internal/react-native.ts";

/** How the image fills its box. */
export type ImageContentFit = "cover" | "contain" | "fill" | "none" | "scale-down";

/** Where an image sits in its box: a CSS `object-position` string, or edge offsets. */
export type ImageContentPosition = string | Record<string, number | string>;

/** How images are cached (best effort here; see the module docs). */
export type ImageCachePolicy = "none" | "disk" | "memory" | "memory-disk";

/** An image source object. */
export interface ImageSourceObject {
  /** The URL. */
  uri?: string;
  /** The intrinsic width. */
  width?: number;
  /** The intrinsic height. */
  height?: number;
  /** A BlurHash to render instead of a URL. */
  blurhash?: string;
  /** A ThumbHash (base64) to render instead of a URL. */
  thumbhash?: string;
  /** Request headers (used by `loadAsync` and `prefetch`). */
  headers?: Record<string, string>;
  /** The cache key. */
  cacheKey?: string;
}

/** An image source: a URL, a source object, or a loaded {@linkcode ImageRef}. */
export type ImageSource = string | ImageSourceObject | ImageRef | null;

/** A fade-in: its duration (ms), timing and effect (every effect is a cross-dissolve here). */
export interface ImageTransition {
  /** Milliseconds (default 0). */
  duration?: number;
  /** The timing curve. */
  timing?: "ease-in-out" | "ease-in" | "ease-out" | "linear";
  /** The effect (`cross-dissolve`; others fall back to it, `null` disables it). */
  effect?: string | null;
}

/** The ref handle of an {@linkcode Image}. */
export interface ImageHandle {
  /** Start an animated image (no effect here). */
  startAnimating(): Promise<void>;
  /** Stop an animated image (no effect here). */
  stopAnimating(): Promise<void>;
  /** Keep the image loaded (no effect here). */
  lockResourceAsync(): Promise<void>;
  /** Let the image unload (no effect here). */
  unlockResourceAsync(): Promise<void>;
  /** Load the image again. */
  reloadAsync(): Promise<void>;
  /** The animatable view (null here). */
  getAnimatableRef(): null;
}

/** `Image` props. */
export interface ImageProps {
  /** The image. */
  source?: ImageSource | ImageSource[];
  /** What shows until the image loads: a URL, a source, or a BlurHash / ThumbHash. */
  placeholder?: ImageSource | ImageSource[];
  /** How the placeholder fills the box (default `scale-down`). */
  placeholderContentFit?: ImageContentFit;
  /** How it fills the box (default `cover`). */
  contentFit?: ImageContentFit;
  /** Where it sits in the box (a CSS `object-position` string, or `{ top, left }`). */
  contentPosition?: ImageContentPosition;
  /** A fade-in, in ms or as options. */
  transition?: number | ImageTransition | null;
  /** How it is cached (best effort). */
  cachePolicy?: ImageCachePolicy | null;
  /** A key whose change shows the placeholder again (recycled list cells). */
  recyclingKey?: string | null;
  /** A blur radius in px. */
  blurRadius?: number;
  /** A tint color (not provided: ignored). */
  tintColor?: string | null;
  /** Alt text. */
  alt?: string;
  /** Alt text (React Native name). */
  accessibilityLabel?: string;
  /** The style. */
  style?: unknown;
  /** A ref to the {@linkcode ImageHandle}. */
  ref?: unknown;
  /** Called when loading starts. */
  onLoadStart?: () => void;
  /** Called once loaded. */
  onLoad?: (event: { source: { url: string; width: number; height: number } }) => void;
  /** Called when loading fails. */
  onError?: (event: { error: string }) => void;
  /** Called after a load or a failure. */
  onLoadEnd?: () => void;
  /** Called when the image is shown. */
  onDisplay?: () => void;
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

/** The Cache API cache the disk policies use. */
const CACHE_NAME = "denext-expo-image";

/** The images loaded this session (`loadAsync`, a memory `prefetch`): URL → blob URL. */
const memoryCache = new Map<string, string>();

/** The Cache API, where the page has it. */
function cacheStorage(): CacheStorage | undefined {
  const caches = (globalThis as { caches?: CacheStorage }).caches;
  return typeof caches?.open === "function" ? caches : undefined;
}

/** The first entry of a source list. */
function firstSource(source: ImageProps["source"]): ImageSource | undefined {
  return Array.isArray(source) ? source[0] : source;
}

/** The usable URL of a source: its URL, or a hash decoded to a data URL. */
function sourceUri(source: ImageProps["source"]): string | null {
  const first = firstSource(source);
  if (typeof first === "string") {
    return /^(blurhash|thumbhash):\//.test(first) ? hashPlaceholderUrl(first) : first;
  }
  if (!first || typeof first !== "object") return null;
  if (first.uri) return first.uri;
  const hashed = first as ImageSourceObject;
  if (hashed.blurhash) return hashPlaceholderUrl(hashed.blurhash, "blurhash");
  if (hashed.thumbhash) return hashPlaceholderUrl(hashed.thumbhash, "thumbhash");
  return null;
}

/** A placeholder's URL: a bare string that is not a URL is read as a BlurHash. */
function placeholderUri(placeholder: ImageProps["placeholder"]): string | null {
  const first = firstSource(placeholder);
  if (typeof first === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(first)) {
    return hashPlaceholderUrl(first, "blurhash");
  }
  return sourceUri(first);
}

/** A cached blob URL of `uri` under `policy`, or null. */
async function cachedUri(uri: string, policy: ImageCachePolicy | null | undefined): Promise<
  string | null
> {
  if (policy === "memory" || policy === "memory-disk") {
    const hit = memoryCache.get(uri);
    if (hit) return hit;
  }
  if (policy !== "disk" && policy !== "memory-disk") return null;
  const caches = cacheStorage();
  const response = caches ? await (await caches.open(CACHE_NAME)).match(uri) : undefined;
  if (!response) return null;
  const url = URL.createObjectURL(await response.blob());
  if (policy === "memory-disk") memoryCache.set(uri, url);
  return url;
}

/** Whether a URL is a remote one a cache can hold. */
function cacheable(uri: string): boolean {
  return /^https?:/i.test(uri);
}

/** A URL the platform can load for `uri`: an app file's blob, a cached copy, or the URL. */
function useLoadableUri(uri: string | null, policy: ImageProps["cachePolicy"]): string | null {
  const local = uri !== null && backing(uri) !== null;
  const cached = uri !== null && !local && cacheable(uri) && !!policy && policy !== "none";
  const [resolved, setResolved] = useState<string | null>(local || cached ? null : uri);
  useEffect(() => {
    if (!local && !cached) {
      setResolved(uri);
      return;
    }
    let active = true;
    let url: string | undefined;
    if (cached) {
      cachedUri(uri!, policy).then((hit) => active && setResolved(hit ?? uri), () => {
        if (active) setResolved(uri);
      });
      return () => void (active = false);
    }
    displayUrl(uri!).then((u) => {
      url = u;
      if (active) setResolved(u);
      else URL.revokeObjectURL(u);
    }, () => active && setResolved(null));
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [uri, policy]);
  return resolved;
}

/** `contentPosition` as CSS `object-position`. */
function objectPosition(position: ImageProps["contentPosition"]): string | undefined {
  if (typeof position === "string") return position;
  if (!position) return undefined;
  const px = (v: unknown) => (typeof v === "number" ? `${v}px` : String(v));
  const x = position.left ??
    (position.right !== undefined ? `calc(100% - ${px(position.right)})` : "50%");
  const y = position.top ??
    (position.bottom !== undefined ? `calc(100% - ${px(position.bottom)})` : "50%");
  return `${px(x)} ${px(y)}`;
}

/** A transition as a CSS `transition`, or undefined for none. */
function cssTransition(transition: ImageProps["transition"]): string | undefined {
  if (transition === null || transition === undefined) return undefined;
  const t = typeof transition === "number" ? { duration: transition } : transition;
  if (t.effect === null || !t.duration) return undefined;
  return `opacity ${t.duration}ms ${t.timing ?? "ease-in-out"}`;
}

/** The fill a layer takes in its box. */
const FILL = { position: "absolute", top: 0, left: 0, width: "100%", height: "100%" };

/** Whether React Native mode must draw layers instead of react-native-web's `Image`. */
function needsLayers(props: ImageProps): boolean {
  return props.placeholder !== undefined || cssTransition(props.transition) !== undefined ||
    props.contentPosition !== undefined || !!props.blurRadius ||
    props.contentFit === "none" || props.contentFit === "scale-down";
}

/** What {@linkcode useImageLoad} gives the renderers. */
interface ImageLoad {
  /** The URL to show. */
  uri: string | null;
  /** The current load's key (recycling key, URL and reload count). */
  key: string;
  /** Whether the current load has finished. */
  shown: boolean;
  /** How many times `reloadAsync` ran (a key for the image element). */
  reloads: number;
  /** Report a load. */
  loaded(width: number, height: number): void;
  /** Report a failure. */
  failed(): void;
}

/** The load state of an image: its URL, key, events and the ref handle. */
function useImageLoad(props: ImageProps): ImageLoad {
  const { onLoadStart, onLoad, onError, onLoadEnd, onDisplay } = props;
  const [reloads, setReloads] = useState(0);
  const uri = useLoadableUri(sourceUri(props.source), props.cachePolicy);
  const key = `${props.recyclingKey ?? ""}|${uri ?? ""}|${reloads}`;
  const [shownKey, setShownKey] = useState<string | null>(null);
  const latest = useRef({ onLoadStart, onLoad, onError, onLoadEnd, onDisplay });
  latest.current = { onLoadStart, onLoad, onError, onLoadEnd, onDisplay };
  useImperativeHandle(props.ref as never, (): ImageHandle => ({
    startAnimating: () => Promise.resolve(),
    stopAnimating: () => Promise.resolve(),
    lockResourceAsync: () => Promise.resolve(),
    unlockResourceAsync: () => Promise.resolve(),
    reloadAsync: () => Promise.resolve(setReloads((n) => n + 1)),
    getAnimatableRef: () => null,
  }), []);
  useEffect(() => {
    if (uri) latest.current.onLoadStart?.();
  }, [key]);
  return {
    uri,
    key,
    reloads,
    shown: shownKey === key,
    loaded(width, height) {
      setShownKey(key);
      const call = latest.current;
      call.onLoad?.({ source: { url: uri ?? "", width, height } });
      call.onDisplay?.();
      call.onLoadEnd?.();
    },
    failed() {
      latest.current.onError?.({ error: `Could not load ${uri}` });
      latest.current.onLoadEnd?.();
    },
  };
}

/** The props a renderer passes on to the host element. */
function hostProps(props: ImageProps): Record<string, unknown> {
  const {
    source: _s,
    placeholder: _p,
    placeholderContentFit: _pf,
    contentFit: _f,
    contentPosition: _cp,
    transition: _t,
    cachePolicy: _c,
    recyclingKey: _r,
    blurRadius: _b,
    tintColor: _tint,
    alt: _a,
    accessibilityLabel: _al,
    style: _st,
    ref: _ref,
    onLoadStart: _ls,
    onLoad: _l,
    onError: _e,
    onLoadEnd: _le,
    onDisplay: _d,
    ...rest
  } = props;
  return rest;
}

/** The image through react-native-web's `Image`. */
function nativeImage(props: ImageProps, load: ImageLoad): VNode {
  return h(RN.Image!, {
    ...hostProps(props),
    key: load.reloads,
    accessibilityLabel: props.alt ?? props.accessibilityLabel,
    source: load.uri ? { uri: load.uri } : undefined,
    resizeMode: RESIZE_MODE[props.contentFit ?? "cover"] ?? "cover",
    style: props.style,
    onLoad: (e: { nativeEvent?: { source?: { width: number; height: number } } }) =>
      load.loaded(e?.nativeEvent?.source?.width ?? 0, e?.nativeEvent?.source?.height ?? 0),
    onError: load.failed,
  });
}

/** The `<img>` of the image itself, in `imageStyle`. */
function imageElement(
  props: ImageProps,
  load: ImageLoad,
  imageStyle: Record<string, unknown>,
  extra: Record<string, unknown>,
): VNode {
  const fade = cssTransition(props.transition);
  return h("img", {
    ...extra,
    key: load.reloads,
    src: load.uri ?? undefined,
    alt: props.alt ?? props.accessibilityLabel ?? "",
    style: {
      ...imageStyle,
      objectFit: props.contentFit ?? "cover",
      objectPosition: objectPosition(props.contentPosition),
      filter: props.blurRadius ? `blur(${props.blurRadius}px)` : undefined,
      opacity: fade && !load.shown ? 0 : undefined,
      transition: fade,
    },
    onLoad: (e: Event) => {
      const img = e.currentTarget as HTMLImageElement;
      load.loaded(img.naturalWidth, img.naturalHeight);
    },
    onError: load.failed,
  });
}

/** The image as a view holding the placeholder `<img>` (until loaded) and the image's. */
function layeredImage(props: ImageProps, load: ImageLoad): VNode {
  const holder = props.placeholder !== undefined ? placeholderUri(props.placeholder) : null;
  const fade = cssTransition(props.transition);
  if (!holder && !fade && !hasReactNative()) {
    return imageElement(props, load, flattenStyle(props.style), hostProps(props));
  }
  return h(
    hostView(),
    { ...hostProps(props), style: viewStyle(props.style, { overflow: "hidden" }) },
    holder && !load.shown
      ? h("img", {
        src: holder,
        alt: "",
        "aria-hidden": "true",
        style: { ...FILL, objectFit: props.placeholderContentFit ?? "scale-down" },
      })
      : null,
    load.uri ? imageElement(props, load, FILL, {}) : null,
  );
}

/**
 * An image.
 *
 * @param props The image props.
 * @returns The image element.
 */
export function Image(props: ImageProps): VNode {
  const load = useImageLoad(props);
  const layered = !hasReactNative() || !RN.Image || needsLayers(props);
  return layered ? layeredImage(props, load) : nativeImage(props, load);
}

/** A loaded image: its (blob) URL, size and type. `Image.Image` is this class. */
export class ImageRef {
  /** The loaded image's URL (a `blob:` URL from `loadAsync`). */
  uri: string | null = null;
  /** The width in pixels. */
  width = 0;
  /** The height in pixels. */
  height = 0;
  /** The media type (`image/png`), when known. */
  mediaType: string | null = null;
  /** The pixel scale. */
  scale = 1;
  /** Whether it is an animated image (a GIF). */
  isAnimated = false;

  /**
   * A reference to a loaded image.
   *
   * @param uri Its URL.
   * @param width Its width.
   * @param height Its height.
   * @param mediaType Its media type.
   * @returns The reference.
   */
  static init(uri: string, width: number, height: number, mediaType: string | null): ImageRef {
    return Object.assign(new ImageRef(), {
      uri,
      width,
      height,
      mediaType,
      isAnimated: mediaType === "image/gif",
    });
  }

  /** Release the image (revokes its `blob:` URL). */
  release(): void {
    if (this.uri?.startsWith("blob:")) URL.revokeObjectURL(this.uri);
    this.uri = null;
  }
}

/** Options for `Image.loadAsync` / {@linkcode useImage}. */
export interface ImageLoadOptions {
  /** A maximum width (not applied: the image loads at its size). */
  maxWidth?: number;
  /** A maximum height (not applied). */
  maxHeight?: number;
  /** Called when loading fails, with a retry. */
  onError?(error: Error, retry: () => void): void;
}

/** Options for `Image.prefetch`. */
export interface ImagePrefetchOptions {
  /** Where to cache (default `memory-disk`). */
  cachePolicy?: "disk" | "memory-disk" | "memory";
  /** Request headers. */
  headers?: Record<string, string>;
}

/** Cache limits for `Image.configureCache` (accepted; the browser's cache is not bounded here). */
export interface ImageCacheConfig {
  /** The memory cache's maximum size in bytes. */
  maxMemoryCost?: number;
  /** The memory cache's maximum image count. */
  maxMemoryCount?: number;
  /** The disk cache's maximum size in bytes. */
  maxDiskSize?: number;
}

/** The last `configureCache` call's config. */
let cacheConfig: ImageCacheConfig = {};

/** The size of an image blob: `createImageBitmap`, else an image element. */
async function blobSize(blob: Blob, url: string): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return size;
  }
  const ImageCtor = (globalThis as { Image?: new () => HTMLImageElement }).Image;
  if (!ImageCtor) return { width: 0, height: 0 };
  return await new Promise((resolve, reject) => {
    const img = new ImageCtor();
    img.onload = () =>
      resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
    img.onerror = () => reject(new Error(`Unable to load the image from '${url}'`));
    img.src = url;
  });
}

/** A source's URL and headers, or a thrown error. */
function loadTarget(
  source: ImageSource | number,
): { uri: string; headers?: Record<string, string> } {
  if (typeof source === "string") return { uri: source };
  const uri = source && typeof source === "object" ? source.uri : undefined;
  if (!uri) throw new Error('The image source must have the "uri" property defined');
  return { uri, headers: (source as ImageSourceObject).headers };
}

/**
 * Load an image into memory and return a reference to it.
 *
 * @param source A URL or a source with a `uri` (and `headers`).
 * @param _options Load options (the size limits are not applied).
 * @returns The reference; its `uri` is a `blob:` URL.
 */
async function imageLoadAsync(
  source: ImageSource | number,
  _options?: ImageLoadOptions,
): Promise<ImageRef> {
  const { uri, headers } = loadTarget(source);
  const response = await fetch(uri, { headers });
  if (!response.ok) {
    throw new Error(`Image request failed with the status code: ${response.status}`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const { width, height } = await blobSize(blob, url);
  memoryCache.set(uri, url);
  return ImageRef.init(url, width, height, response.headers.get("Content-Type"));
}

/** Preload one URL through an image element (the HTTP / memory cache). */
function preload(url: string): Promise<boolean> {
  const ImageCtor = (globalThis as { Image?: new () => HTMLImageElement }).Image;
  if (!ImageCtor) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const img = new ImageCtor();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

/** Store one URL in the Cache API; false when it cannot be fetched or stored. */
async function storeOnDisk(url: string, headers?: Record<string, string>): Promise<boolean> {
  const caches = cacheStorage();
  if (!caches) return false;
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return false;
    await (await caches.open(CACHE_NAME)).put(url, response);
    return true;
  } catch {
    return false;
  }
}

/**
 * Preload images. `disk` / `memory-disk` store them with the Cache API (where the page has
 * it; an `Image` with that `cachePolicy` then reads them from there), `memory` loads them
 * through an image element.
 *
 * @param urls One URL or several.
 * @param options The cache policy (or options with it and headers).
 * @returns `true` when every image loaded.
 */
async function imagePrefetch(
  urls: string | string[],
  options?: ImagePrefetchOptions["cachePolicy"] | ImagePrefetchOptions,
): Promise<boolean> {
  const { cachePolicy = "memory-disk", headers } = typeof options === "string"
    ? { cachePolicy: options }
    : options ?? {};
  const results = await Promise.all(
    [urls].flat().map(async (url) => {
      const disk = cachePolicy !== "memory" && cacheable(url) && cacheStorage()
        ? await storeOnDisk(url, headers)
        : false;
      return disk || await preload(url);
    }),
  );
  return results.every(Boolean);
}

/** Forget the images loaded this session (their `blob:` URLs are revoked). */
function imageClearMemoryCache(): Promise<boolean> {
  for (const url of memoryCache.values()) URL.revokeObjectURL(url);
  memoryCache.clear();
  return Promise.resolve(true);
}

/** Delete the Cache API cache; `false` where the page has no Cache API. */
async function imageClearDiskCache(): Promise<boolean> {
  const caches = cacheStorage();
  if (!caches) return false;
  await caches.delete(CACHE_NAME);
  return true;
}

/** The Cache API key of `cacheKey` when it is cached (it is its own "path"), else null. */
async function imageGetCachePathAsync(cacheKey: string): Promise<string | null> {
  const caches = cacheStorage();
  if (!caches) return null;
  return (await (await caches.open(CACHE_NAME)).match(cacheKey)) ? cacheKey : null;
}

/**
 * Store an image in the Cache API under `cacheKey`.
 *
 * @param source A URL or an {@linkcode ImageRef}.
 * @param cacheKey The key (an image with this key as its `uri` and a disk `cachePolicy` reads it).
 */
async function imageWriteToCacheAsync(source: string | ImageRef, cacheKey: string): Promise<void> {
  const caches = cacheStorage();
  if (!caches) throw new Error("denext/expo: expo-image's writeToCacheAsync needs the Cache API");
  const url = typeof source === "string" ? source : source.uri;
  if (!url) throw new Error("writeToCacheAsync: the image has no uri");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Image request failed with the status code: ${response.status}`);
  }
  await (await caches.open(CACHE_NAME)).put(cacheKey, response);
}

/**
 * The image stored under `cacheKey`, loaded.
 *
 * @param cacheKey The key.
 * @returns The reference, or null when nothing is cached under it.
 */
async function imageReadFromCacheAsync(cacheKey: string): Promise<ImageRef | null> {
  const caches = cacheStorage();
  const response = caches ? await (await caches.open(CACHE_NAME)).match(cacheKey) : undefined;
  if (!response) return null;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const { width, height } = await blobSize(blob, url);
  return ImageRef.init(url, width, height, response.headers.get("Content-Type"));
}

/** Accept cache limits (the browser's cache is not bounded here). */
function imageConfigureCache(config: ImageCacheConfig): void {
  cacheConfig = { ...config };
}

/** A 2D canvas of `w`×`h`, or null where there is none. */
function canvas2d(w: number, h: number): CanvasRenderingContext2D | null {
  const Offscreen =
    (globalThis as unknown as { OffscreenCanvas?: new (w: number, h: number) => HTMLCanvasElement })
      .OffscreenCanvas;
  const doc = (globalThis as { document?: Document }).document;
  const canvas = Offscreen
    ? new Offscreen(w, h)
    : doc?.createElement?.("canvas") as HTMLCanvasElement | undefined;
  if (!canvas) return null;
  canvas.width = w;
  canvas.height = h;
  return canvas.getContext("2d") as CanvasRenderingContext2D | null;
}

/** An image's pixels, scaled to fit `max`×`max`. */
async function pixelsOf(source: string | ImageRef, max: number): Promise<RgbaImage> {
  const url = typeof source === "string" ? source : source.uri;
  if (!url) throw new Error("The image has no uri");
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas2d(w, h);
  if (!context) throw new Error("denext/expo: expo-image's hash generation needs a canvas");
  context.drawImage(bitmap as unknown as CanvasImageSource, 0, 0, w, h);
  bitmap.close?.();
  return { w, h, rgba: new Uint8Array(context.getImageData(0, 0, w, h).data.buffer) };
}

/**
 * Compute an image's BlurHash (on a canvas, from a copy at most 64 px on a side).
 *
 * @param source A URL or an {@linkcode ImageRef}.
 * @param numberOfComponents The components, as `[x, y]` or `{ width, height }`.
 * @returns The hash.
 */
async function imageGenerateBlurhashAsync(
  source: string | ImageRef,
  numberOfComponents: [number, number] | { width: number; height: number },
): Promise<string | null> {
  const [cx, cy] = Array.isArray(numberOfComponents)
    ? numberOfComponents
    : [numberOfComponents.width, numberOfComponents.height];
  return rgbaToBlurhash(await pixelsOf(source, 64), cx, cy);
}

/**
 * Compute an image's ThumbHash (on a canvas, from a copy at most 100 px on a side).
 *
 * @param source A URL or an {@linkcode ImageRef}.
 * @returns The hash, base64.
 */
async function imageGenerateThumbhashAsync(source: string | ImageRef): Promise<string> {
  return bytesBase64(rgbaToThumbhash(await pixelsOf(source, 100)));
}

/** The {@linkcode ImageRef} class (Expo's `Image.Image`). */
Image.Image = ImageRef as typeof ImageRef;
/** Preload images (see {@linkcode ImagePrefetchOptions}); `true` when every one loaded. */
Image.prefetch = (
  urls: string | string[],
  options?: ImagePrefetchOptions["cachePolicy"] | ImagePrefetchOptions,
): Promise<boolean> => imagePrefetch(urls, options);
/** Load an image into memory; its `uri` is a `blob:` URL. */
Image.loadAsync = (source: ImageSource | number, options?: ImageLoadOptions): Promise<ImageRef> =>
  imageLoadAsync(source, options);
/** Forget the images loaded this session. */
Image.clearMemoryCache = (): Promise<boolean> => imageClearMemoryCache();
/** Delete the Cache API cache; `false` without the Cache API. */
Image.clearDiskCache = (): Promise<boolean> => imageClearDiskCache();
/** The cache key when it is cached, else null. */
Image.getCachePathAsync = (cacheKey: string): Promise<string | null> =>
  imageGetCachePathAsync(cacheKey);
/** Store an image in the Cache API under a key. */
Image.writeToCacheAsync = (source: string | ImageRef, cacheKey: string): Promise<void> =>
  imageWriteToCacheAsync(source, cacheKey);
/** The image stored under a key, loaded, or null. */
Image.readFromCacheAsync = (cacheKey: string): Promise<ImageRef | null> =>
  imageReadFromCacheAsync(cacheKey);
/** Accept cache limits (not enforced). */
Image.configureCache = (config: ImageCacheConfig): void => imageConfigureCache(config);
/** An image's BlurHash, computed on a canvas. */
Image.generateBlurhashAsync = (
  source: string | ImageRef,
  numberOfComponents: [number, number] | { width: number; height: number },
): Promise<string | null> => imageGenerateBlurhashAsync(source, numberOfComponents);
/** An image's ThumbHash (base64), computed on a canvas. */
Image.generateThumbhashAsync = (source: string | ImageRef): Promise<string> =>
  imageGenerateThumbhashAsync(source);

/**
 * The cache limits last passed to `Image.configureCache` (denext only; they are not enforced).
 *
 * @returns The config.
 */
export function imageCacheConfig(): ImageCacheConfig {
  return { ...cacheConfig };
}

/**
 * Load an image and return its {@linkcode ImageRef} (null until loaded), reloading when
 * `dependencies` change.
 *
 * @param source A URL or a source with a `uri`.
 * @param options Load options; `onError` gets the error and a retry.
 * @param dependencies Values whose change reloads it (default: the source).
 * @returns The reference, or null.
 */
export function useImage(
  source: ImageSource | number,
  options: ImageLoadOptions = {},
  dependencies: unknown[] = [],
): ImageRef | null {
  const [image, setImage] = useState<ImageRef | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = typeof source === "object" && source ? (source as ImageSourceObject).uri : source;
  useEffect(() => {
    let active = true;
    imageLoadAsync(source, options).then((ref) => {
      if (active) setImage(ref);
    }, (error: Error) => {
      if (active) options.onError?.(error, () => setAttempt((n) => n + 1));
    });
    return () => void (active = false);
  }, [key, attempt, ...dependencies]);
  return image;
}

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
