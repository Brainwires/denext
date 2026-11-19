// Root layout: no chrome, the pages are full-bleed. `viewport-fit=cover` lets the page reach
// under an iPhone's notch and home indicator; the CSS keeps the picture and the controls inside
// the safe-area insets (public/styles.css).

import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "RTC viewer",
  description: "A full-screen WebRTC viewer: WebCodecs decoding, WebGPU display",
  head: `<link rel="stylesheet" href="/styles.css">`,
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#000000",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps) {
  return <div class="app">{children}</div>;
}
