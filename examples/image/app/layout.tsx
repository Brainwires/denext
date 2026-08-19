// Root layout. denext supplies <html>/<head>/<body>; the layout renders the
// in-body chrome. metadata.head links the demo stylesheet from public/.

import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "denext · image optimization",
  description:
    "next/image-style <Image> against denext's built-in /_denext/image optimizer: responsive srcSet, priority, and a blur placeholder — plus a dynamic OG image.",
  head: `<link rel="stylesheet" href="/styles.css">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <div class="app">
      <header class="topbar">
        <span class="brand">denext · image</span>
      </header>
      <main class="content">{children}</main>
      <footer class="foot">
        Optimized by /_denext/image · re-encoded to WebP
      </footer>
    </div>
  );
}
