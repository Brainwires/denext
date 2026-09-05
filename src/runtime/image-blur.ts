// The `next/image` blur-placeholder primitives, kept dependency-free so the client boot
// (which clears placeholders in server-only trees) can import them without pulling the
// image loader / optimizer wiring into the shared client chunk.

/** Marks an `<img>` whose blur placeholder must be cleared once it has loaded. */
export const BLUR_ATTR = "data-dnx-blur";

/**
 * Next.js's blur placeholder: the tiny data URI inside an SVG `feGaussianBlur` filter, as a
 * `background-image`, so the placeholder is genuinely blurred rather than pixel-scaled.
 */
export function blurBackground(dataUrl: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' ` +
    `viewBox='0 0 8 8'><filter id='b' color-interpolation-filters='sRGB'>` +
    `<feGaussianBlur stdDeviation='1'/><feComponentTransfer><feFuncA type='discrete' tableValues='1 1'/>` +
    `</feComponentTransfer></filter><image filter='url(#b)' preserveAspectRatio='none' ` +
    `width='100%' height='100%' xlink:href='${dataUrl}'/></svg>`;
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
}

/** Clear a loaded image's blur placeholder (the `onLoad` half; the client boot handles SSR). */
export function clearBlur(
  img: { style?: { backgroundImage?: string }; removeAttribute?: (n: string) => void },
): void {
  if (img.style) img.style.backgroundImage = "";
  img.removeAttribute?.(BLUR_ATTR);
}
