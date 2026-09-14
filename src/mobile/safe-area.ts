/**
 * Safe-area custom properties for `denext/mobile`.
 *
 * @module
 */

/**
 * A stylesheet fragment that defines `--denext-safe-top`, `--denext-safe-right`,
 * `--denext-safe-bottom` and `--denext-safe-left` on `:root` as the device's safe-area insets
 * (`env(safe-area-inset-*, 0px)`: the notch, status bar and home indicator), `0px` where
 * there are none. Drop it into a stylesheet or a `<style>` tag, then pad with the variables.
 *
 * The insets are only non-zero when the viewport meta includes `viewport-fit=cover`. In the
 * App Router, export `viewport = { width: "device-width", initialScale: 1, viewportFit:
 * "cover" }` from the root layout. In SPA mode, put the meta tag in `spa.head`; denext's SPA
 * shell keeps an app's own viewport meta instead of emitting its default.
 *
 * @example
 * ```tsx
 * import { SAFE_AREA_CSS } from "denext/mobile";
 *
 * export default function RootLayout({ children }: { children: unknown }) {
 *   return (
 *     <html>
 *       <head><style>{SAFE_AREA_CSS}</style></head>
 *       <body style={{ paddingTop: "var(--denext-safe-top)" }}>{children}</body>
 *     </html>
 *   );
 * }
 * ```
 */
export const SAFE_AREA_CSS: string = `:root {
  --denext-safe-top: env(safe-area-inset-top, 0px);
  --denext-safe-right: env(safe-area-inset-right, 0px);
  --denext-safe-bottom: env(safe-area-inset-bottom, 0px);
  --denext-safe-left: env(safe-area-inset-left, 0px);
}
`;
