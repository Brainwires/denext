import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "denext · resumability",
  description:
    "A resumable route: interactive with no up-front hydration. Islands wake on demand — click one counter and only that island hydrates.",
  head: `<link rel="stylesheet" href="/styles.css">` +
    `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <div class="app">
      <header class="topbar">
        <span class="brand">denext · resumability</span>
        <code class="flag">export const resumable = true</code>
      </header>
      <main class="content">{children}</main>
      <footer class="foot">
        No hydration on load · handler islands wake on interaction · effect islands wake on idle
      </footer>
    </div>
  );
}
