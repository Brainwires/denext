// Root layout — wraps every page's content inside the hydration root.
// denext supplies <html>/<head>/<body>; a layout renders the in-body chrome.

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
        <a class="brand" href="/">denext</a>
        <nav>
          <a href="/">Home</a>
          <a href="/about">About</a>
          <a href="/blog/hello-world">Blog</a>
        </nav>
      </header>
      <main class="content">{children}</main>
      <footer class="foot">Built on Deno · no npm dependencies</footer>
    </div>
  );
}
