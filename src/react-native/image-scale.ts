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
