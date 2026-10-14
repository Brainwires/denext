/**
 * React Native's `Image` props for React Native mode that react-native-web drops:
 *
 * - The web-style props of React Native 0.71: `src` and `srcSet` (`"a.png 1x, a@2x.png 2x"`, or
 *   width descriptors `"a-400.png 400w, a-800.png 800w"`), from which the source for this screen
 *   is picked (as React Native does, `src` is the 1x one when `srcSet` has none); `alt` (the
 *   accessibility label); `width` / `height` (the size, under the `style`'s).
 * - A `source` array (`[{ uri, scale | width }]`), which react-native-web cannot draw: the one
 *   for this screen is picked the same way.
 * - `loadingIndicatorSource`, drawn while the image loads (react-native-web's `defaultSource`).
 * - `fadeDuration` (Android): the image fades in over that many ms once it has loaded. As in
 *   React Native, the Android shell fades by 300 ms when the prop is unset and iOS never fades;
 *   a browser (and Deno Desktop) fades only when the prop is set.
 * - `crossOrigin` and `referrerPolicy`: react-native-web draws the image as a CSS background
 *   (and preloads it with `new Image()`), which the browser fetches with its defaults. With
 *   either prop set, the image is drawn as a real `<img>` carrying them, in react-native-web's
 *   `View`: `resizeMode` becomes `object-fit` (`repeat` draws one copy at the top left, as
 *   `none`), `blurRadius` a CSS blur, `defaultSource` shows until the image loads, and
 *   `onLoadStart` / `onLoad` (`nativeEvent.source` with the natural size) / `onLoadEnd` /
 *   `onError` fire as react-native-web's do. `tintColor` is not drawn on that path.
 *
 * React Native mode's build wraps react-native-web's `Image` with {@linkcode withImageProps}
 * (after {@linkcode withImageStatics}), keeping its statics.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeType, VProps } from "../jsx/types.ts";
import { useEffect, useRef, useState } from "../runtime/hooks.ts";
import { nativePlatform } from "../mobile/bridge.ts";
import { flattenStyle } from "./font-scaling.ts";
import { pickImageScale, withImageStatics } from "./image-scale.ts";

/** One image source, as React Native's array form lists them. */
export interface ImageSourceCandidate {
  readonly uri: string;
  readonly scale?: number;
  readonly width?: number;
  readonly height?: number;
  readonly [key: string]: unknown;
}

/**
 * The candidates in a `srcSet` (plus `src` as the 1x one when the set has none).
 *
 * @param srcSet The `srcSet` prop.
 * @param src The `src` prop.
 * @returns The candidates.
 */
export function parseSrcSet(srcSet: string | undefined, src?: string): ImageSourceCandidate[] {
  const out: ImageSourceCandidate[] = [];
  for (const part of (srcSet ?? "").split(",")) {
    const [uri, descriptor = "1x"] = part.trim().split(/\s+/);
    if (!uri) continue;
    const n = parseFloat(descriptor);
    if (!(n > 0)) continue;
    out.push(descriptor.endsWith("w") ? { uri, width: n } : { uri, scale: n });
  }
  const hasOneX = out.some((c) => c.scale === 1);
  if (src && !hasOneX) out.push({ uri: src, scale: 1 });
  return out;
}

/** The screen's pixel ratio. */
function devicePixelRatio(): number {
  return (globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1;
}

/**
 * The candidate for this screen: by `width` against the drawn width times the pixel ratio (the
 * smallest that covers it, else the widest), else by `scale` (React Native's pick), else the
 * first.
 *
 * @param candidates The candidates.
 * @param layoutWidth The drawn width, px, when known.
 * @returns The candidate, or `undefined` for none.
 */
export function pickSource(
  candidates: readonly ImageSourceCandidate[],
  layoutWidth?: number,
): ImageSourceCandidate | undefined {
  if (candidates.length <= 1) return candidates[0];
  const wide = candidates.filter((c) => typeof c.width === "number");
  if (wide.length > 0 && typeof layoutWidth === "number") {
    const want = layoutWidth * devicePixelRatio();
    const sorted = [...wide].sort((a, b) => a.width! - b.width!);
    return sorted.find((c) => c.width! >= want) ?? sorted[sorted.length - 1];
  }
  const scaled = candidates.filter((c) => typeof c.scale === "number");
  if (scaled.length > 0) {
    const uri = pickImageScale(scaled.map((c) => [c.scale!, c.uri] as const));
    return scaled.find((c) => c.uri === uri);
  }
  return candidates[0];
}

/** The props the wrapper reads (the rest go on). */
interface ImageProps {
  readonly src?: string;
  readonly srcSet?: string;
  readonly alt?: string;
  readonly width?: number;
  readonly height?: number;
  readonly crossOrigin?: string;
  readonly referrerPolicy?: string;
  readonly fadeDuration?: number;
  readonly loadingIndicatorSource?: unknown;
  readonly defaultSource?: unknown;
  readonly source?: unknown;
  readonly accessibilityLabel?: string;
  readonly style?: unknown;
  readonly onLoad?: (e: unknown) => void;
  readonly onError?: (e: unknown) => void;
  readonly [prop: string]: unknown;
}

/** The props React Native has and react-native-web does not take. */
const RN_ONLY_PROPS = [
  "src",
  "srcSet",
  "alt",
  "width",
  "height",
  "crossOrigin",
  "referrerPolicy",
  "fadeDuration",
  "loadingIndicatorSource",
] as const;

/**
 * The props react-native-web's `Image` gets for a React Native `Image`'s (without the fade).
 *
 * @param props The app's props.
 * @returns The props to pass on.
 */
export function imageProps(props: ImageProps): Record<string, unknown> {
  const out: Record<string, unknown> = { ...props };
  for (const key of RN_ONLY_PROPS) delete out[key];
  const sized = typeof props.width === "number" || typeof props.height === "number";
  const layoutWidth = props.width ?? flattenStyle(props.style).width;
  const width = typeof layoutWidth === "number" ? layoutWidth : undefined;
  if (Array.isArray(props.source)) {
    out.source = pickSource(props.source as ImageSourceCandidate[], width);
  } else if (props.source == null && (props.src || props.srcSet)) {
    out.source = pickSource(parseSrcSet(props.srcSet, props.src), width);
  }
  if (props.alt !== undefined && props.accessibilityLabel === undefined) {
    out.accessibilityLabel = props.alt;
  }
  if (sized) out.style = [{ width: props.width, height: props.height }, props.style];
  if (props.loadingIndicatorSource != null && props.defaultSource == null) {
    out.defaultSource = props.loadingIndicatorSource;
  }
  return out;
}

/** An image source's URI: a string, `{ uri }`, or the first of an array. */
function sourceUri(source: unknown): string | undefined {
  if (typeof source === "string") return source;
  if (Array.isArray(source)) return sourceUri(source[0]);
  const uri = (source as { uri?: unknown } | null | undefined)?.uri;
  return typeof uri === "string" && uri !== "" ? uri : undefined;
}

/** React Native's `resizeMode` as `object-fit` (and where the image sits) on an `<img>`. */
const OBJECT_FIT: Readonly<Record<string, Record<string, string>>> = {
  cover: { objectFit: "cover" },
  contain: { objectFit: "contain" },
  stretch: { objectFit: "fill" },
  center: { objectFit: "scale-down" },
  repeat: { objectFit: "none", objectPosition: "0 0" },
  none: { objectFit: "none", objectPosition: "0 0" },
};

/**
 * The fade-in an `Image` draws after it loads, ms (`0`: none): `fadeDuration` is Android's
 * (300 ms when unset there), never on iOS, and only when set in a browser or Deno Desktop.
 *
 * @param fadeDuration The prop.
 * @param platform The shell's platform (`nativePlatform()`).
 * @returns The fade, ms.
 */
export function imageFade(fadeDuration: unknown, platform: string): number {
  if (platform === "ios") return 0;
  const set = typeof fadeDuration === "number" && Number.isFinite(fadeDuration);
  const ms = set ? fadeDuration as number : platform === "android" ? 300 : 0;
  return ms > 0 ? ms : 0;
}

/** The `<img>` path's load state: the URI it is for, and whether it loaded. */
interface ImgState {
  readonly uri: string | undefined;
  readonly loaded: boolean;
}

/** The load callbacks the `<img>` path calls, react-native-web's shapes. */
interface ImgCallbacks {
  readonly onLoadStart?: () => void;
  readonly onLoad?: (e: unknown) => void;
  readonly onLoadEnd?: () => void;
  readonly onError?: (e: unknown) => void;
}

/** An `<img>` load event's natural size. */
interface ImgLoadEvent {
  readonly currentTarget?: { naturalWidth?: number; naturalHeight?: number };
}

/**
 * The `<img>` path's load state and handlers: `onLoadStart` for each new URI, then `onLoad`
 * (`nativeEvent.source` with the natural size) or `onError`, each followed by `onLoadEnd`.
 *
 * @param uri The image's URI.
 * @param callbacks The app's callbacks.
 * @returns Whether it loaded, and the `<img>`'s `onLoad` / `onError`.
 */
function useImgLoad(uri: string | undefined, callbacks: ImgCallbacks): {
  loaded: boolean;
  onLoad: (e: ImgLoadEvent) => void;
  onError: () => void;
} {
  const [state, setState] = useState<ImgState>({ uri, loaded: false });
  const latest = useRef(callbacks);
  latest.current = callbacks;
  useEffect(() => {
    if (uri !== undefined) latest.current.onLoadStart?.();
  }, [uri]);
  return {
    loaded: state.uri === uri && state.loaded,
    onLoad(e) {
      const img = e?.currentTarget;
      setState({ uri, loaded: true });
      const source = { uri, width: img?.naturalWidth ?? 0, height: img?.naturalHeight ?? 0 };
      latest.current.onLoad?.({ nativeEvent: { source } });
      latest.current.onLoadEnd?.();
    },
    onError() {
      latest.current.onError?.({ nativeEvent: { error: `Failed to load resource ${uri}` } });
      latest.current.onLoadEnd?.();
    },
  };
}

/**
 * The `<img>`'s style: the box filled, `resizeMode` as `object-fit`, `blurRadius` as a blur.
 *
 * @param resizeMode The `resizeMode` (prop or style).
 * @param blurRadius The `blurRadius` prop.
 * @returns The style.
 */
function imgFillStyle(
  resizeMode: unknown,
  blurRadius: unknown,
): Record<string, string | number> {
  const blur: Record<string, string> = typeof blurRadius === "number" && blurRadius > 0
    ? { filter: `blur(${blurRadius}px)` }
    : {};
  return {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    ...(OBJECT_FIT[String(resizeMode)] ?? OBJECT_FIT.cover),
    ...blur,
  };
}

/** A `source` object's own `width` / `height` (the image's size, as react-native-web's). */
function sourceSize(source: unknown): Record<string, unknown> | null {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const { width, height } = source as { width?: number; height?: number };
  return { width, height };
}

/** The props of {@linkcode ElementImage}. */
interface ElementImageProps {
  /** The app's props. */
  readonly props: ImageProps;
  /** The props {@linkcode imageProps} resolved (with the fade's style and handlers). */
  readonly out: Record<string, unknown>;
  /** react-native-web's `View`. */
  readonly view: VNodeType;
}

/** The accessibility label: `aria-label`, else `accessibilityLabel`, else `alt`. */
function imgLabel(rest: Record<string, unknown>, alt: unknown): string {
  return String(rest["aria-label"] ?? rest.accessibilityLabel ?? alt ?? "");
}

/**
 * The image's `<img>`, carrying `crossOrigin` / `referrerPolicy` (invisible while the
 * `defaultSource` shows).
 */
function imgElement(
  props: ImageProps,
  uri: string,
  img: { label: string; draggable: unknown; fill: Record<string, unknown>; hidden: boolean },
  load: ReturnType<typeof useImgLoad>,
): VNode {
  return h("img", {
    crossOrigin: props.crossOrigin,
    referrerPolicy: props.referrerPolicy,
    src: uri,
    alt: img.label,
    draggable: img.draggable === true,
    style: img.hidden ? { ...img.fill, opacity: 0 } : img.fill,
    onLoad: load.onLoad,
    onError: load.onError,
  });
}

/**
 * The `Image` drawn as a real `<img>` (with `crossOrigin` / `referrerPolicy`) in `View`, for
 * when react-native-web's CSS background could not carry them.
 */
function ElementImage({ props, out, view }: ElementImageProps): VNode {
  const {
    source,
    defaultSource,
    resizeMode,
    blurRadius,
    tintColor: _tint,
    draggable,
    onLoadStart,
    onLoad,
    onLoadEnd,
    onError,
    style,
    ...rest
  } = out;
  const uri = sourceUri(source);
  const load = useImgLoad(uri, { onLoadStart, onLoad, onLoadEnd, onError } as ImgCallbacks);
  const label = imgLabel(rest, props.alt);
  const fill = imgFillStyle(resizeMode ?? flattenStyle(style).resizeMode, blurRadius);
  const placeholder = load.loaded ? undefined : sourceUri(defaultSource);
  const hidden = placeholder !== undefined;
  return h(
    view,
    {
      ...rest,
      "aria-label": label || undefined,
      style: [{ overflow: "hidden", zIndex: 0 }, sourceSize(source), style],
    },
    hidden ? h("img", { src: placeholder, alt: "", draggable: false, style: fill }) : null,
    uri === undefined ? null : imgElement(props, uri, { label, draggable, fill, hidden }, load),
  );
}

/** The statics a wrapper keeps (a forwardRef object's internals excluded). */
function statics(component: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(component as Record<string, unknown>)
      .filter(([k]) => k !== "$$typeof" && k !== "render"),
  );
}

/**
 * react-native-web's `Image` with React Native's props and statics (see the module docs).
 *
 * @param Image react-native-web's `Image`.
 * @param View react-native-web's `View`, for the `<img>` that carries `crossOrigin` /
 *   `referrerPolicy`.
 * @returns The wrapped `Image`, with the statics `Image.getSize` & co.
 */
export function withImageProps(Image: VNodeType, View: VNodeType = "div"): VNodeType {
  const Base = withImageStatics(Image);
  function RNImage(props: ImageProps): VNode {
    const [loaded, setLoaded] = useState(false);
    const out = imageProps(props);
    const fade = imageFade(props.fadeDuration, nativePlatform());
    const direct = props.crossOrigin != null || props.referrerPolicy != null;
    const draw = (p: Record<string, unknown>): VNode =>
      direct ? h(ElementImage, { props, out: p, view: View }) : h(Base, p as VProps);
    if (fade <= 0) return draw(out);
    const { onLoad, onError } = props;
    return draw({
      ...out,
      style: [out.style, { opacity: loaded ? 1 : 0, transition: `opacity ${fade}ms` }],
      onLoad(e: unknown) {
        setLoaded(true);
        onLoad?.(e);
      },
      onError(e: unknown) {
        setLoaded(true);
        onError?.(e);
      },
    });
  }
  return Object.assign(RNImage, statics(Base), { displayName: "Image" }) as unknown as VNodeType;
}
