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
 * - `fadeDuration` (Android): in the Android shell the image fades in over that many ms once it
 *   has loaded. React Native fades by 300 ms by default; denext fades only when the prop is set.
 *
 * `crossOrigin` and `referrerPolicy` are accepted and do nothing: react-native-web draws the
 * image as a CSS background, which the browser fetches with its defaults.
 *
 * React Native mode's build wraps react-native-web's `Image` with {@linkcode withImageProps}
 * (after {@linkcode withImageStatics}), keeping its statics.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeType, VProps } from "../jsx/types.ts";
import { useState } from "../runtime/hooks.ts";
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
 * @returns The wrapped `Image`, with the statics `Image.getSize` & co.
 */
export function withImageProps(Image: VNodeType): VNodeType {
  const Base = withImageStatics(Image);
  function RNImage(props: ImageProps): VNode {
    const [loaded, setLoaded] = useState(false);
    const out = imageProps(props);
    const fade = props.fadeDuration;
    if (typeof fade !== "number" || fade <= 0 || nativePlatform() !== "android") {
      return h(Base, out as VProps);
    }
    const { onLoad, onError } = props;
    return h(Base, {
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
    } as VProps);
  }
  return Object.assign(RNImage, statics(Base), { displayName: "Image" }) as unknown as VNodeType;
}
