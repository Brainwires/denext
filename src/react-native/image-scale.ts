/**
 * Metro's `@2x` / `@3x` image variants for React Native mode: `require("./logo.png")` next to
 * `logo@2x.png` and `logo@3x.png` resolves (in React Native mode's build) to a module that
 * bundles every variant and calls {@linkcode pickImageScale}, so the import is the URL of the
 * variant this screen wants, the way React Native picks one: the smallest scale at or above
 * the device pixel ratio, else the largest. The import stays a URL string, as every image
 * import is in a denext build.
 *
 * @module
 */

/**
 * The URL of the variant for this screen: the smallest scale at or above `devicePixelRatio`
 * (read now), else the largest (React Native's `AssetSourceResolver.pickScale`).
 *
 * @param variants `[scale, url]` pairs (any order).
 * @param deviceScale The screen's pixel ratio (default: `devicePixelRatio`, else 1).
 * @returns The chosen URL (`""` without variants).
 */
export function pickImageScale(
  variants: ReadonlyArray<readonly [number, string]>,
  deviceScale?: number,
): string {
  const ratio = deviceScale ??
    ((globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1);
  const sorted = [...variants].sort((a, b) => a[0] - b[0]);
  for (const [scale, url] of sorted) if (scale >= ratio) return url;
  return sorted[sorted.length - 1]?.[1] ?? "";
}

/** What {@linkcode resolveAssetSource} returns: React Native's resolved asset source. */
export interface ResolvedAssetSource {
  /** The URL. */
  readonly uri: string;
  /** The width, when the source says. */
  readonly width?: number;
  /** The height, when the source says. */
  readonly height?: number;
  /** The pixel density of the image (1 unless the source says). */
  readonly scale: number;
}

/**
 * React Native's `Image.resolveAssetSource`: the `{ uri, width, height, scale }` of an image
 * source. In a denext build an imported image (`require("./a.png")`) is already its URL (the
 * `@2x` / `@3x` variant for this screen), so a string resolves to itself; `{ uri }` objects
 * (and the first of an array) keep their size and scale. A bundled asset number (Metro's
 * registry) has no URL here: null.
 *
 * @param source An image source.
 * @returns The resolved source, or null.
 */
export function resolveAssetSource(source: unknown): ResolvedAssetSource | null {
  const one = Array.isArray(source) ? source[0] : source;
  if (typeof one === "string") return one === "" ? null : { uri: one, scale: 1 };
  if (!one || typeof one !== "object") return null;
  const s = one as { uri?: unknown; width?: unknown; height?: unknown; scale?: unknown };
  if (typeof s.uri !== "string") return null;
  return {
    uri: s.uri,
    ...(typeof s.width === "number" ? { width: s.width } : {}),
    ...(typeof s.height === "number" ? { height: s.height } : {}),
    scale: typeof s.scale === "number" ? s.scale : 1,
  };
}

/** The statics react-native-web's `Image` has, which {@linkcode withImageStatics} builds on. */
interface ImageStatics {
  getSize?: (
    uri: string,
    success: (w: number, h: number) => void,
    failure?: (e: unknown) => void,
  ) => void;
  prefetch?: (uri: string) => Promise<unknown>;
  [key: string]: unknown;
}

/**
 * React Native mode's patch of react-native-web's `Image`: adds the statics it lacks,
 * `resolveAssetSource` ({@linkcode resolveAssetSource}), `getSizeWithHeaders` (as `getSize`:
 * the browser cannot send headers for an image) and `prefetchWithMetadata` (as `prefetch`).
 *
 * @param Image react-native-web's `Image`.
 * @returns The same `Image`, with the statics.
 */
export function withImageStatics<T>(Image: T): T {
  const img = Image as unknown as ImageStatics;
  if (typeof img !== "function" && (typeof img !== "object" || img === null)) return Image;
  img.resolveAssetSource ??= resolveAssetSource;
  img.getSizeWithHeaders ??= (
    uri: string,
    _headers: unknown,
    success: (w: number, h: number) => void,
    failure?: (e: unknown) => void,
  ) => img.getSize?.(uri, success, failure);
  img.prefetchWithMetadata ??= (uri: string) =>
    img.prefetch ? img.prefetch(uri) : Promise.resolve(false);
  return Image;
}
