import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "denext — Next.js's App Router, on Deno",
  description:
    "denext is the Next.js App Router reimplemented for Deno with its own small React — zero-npm runtime, server components, server actions, and pages that ship 0 KB of JavaScript by default.",
  head: `<link rel="stylesheet" href="/styles.css">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <div class="site">
      <header class="topbar">
        <a class="brand" href="/">
          <span class="logo">▲</span> denext
        </a>
        <nav class="topnav">
          <a href="/docs/getting-started">Docs</a>
          <a href="/docs/testing">Testing</a>
          <a href="/docs/deploy">Deploy</a>
        </nav>
      </header>
      <main>{children}</main>
      <footer class="sitefoot">
        Built with denext · static-exported · this page ships <strong>0 KB</strong> of JavaScript
      </footer>
    </div>
  );
}
