// Root layout — wraps every page's content inside the hydration root.
// denext supplies <html>/<head>/<body>; a layout renders the in-body chrome.

import { Link } from "denext";
import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "denext example",
  description: "A demo app built with denext",
  head: `<link rel="stylesheet" href="/styles.css">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <div class="app">
      <header class="topbar">
        <Link class="brand" href="/">denext</Link>
        <nav>
          <Link href="/">Home</Link>
          <Link href="/about">About</Link>
          <Link href="/blog/hello-world">Blog</Link>
        </nav>
      </header>
      <main class="content">{children}</main>
      <footer class="foot">Built on Deno · no npm dependencies</footer>
    </div>
  );
}
