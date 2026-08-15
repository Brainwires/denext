import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "denext · cache components",
  description:
    "Next.js 16 Cache Components: a `use cache` island in a static shell, plus a per-request dynamic hole (Partial Prerendering).",
  head: `<link rel="stylesheet" href="/styles.css">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <div class="app">
      <header class="topbar">
        <span class="brand">denext · cache components</span>
      </header>
      <main class="content">{children}</main>
      <footer class="foot">
        static shell (cached) · dynamic hole (per request)
      </footer>
    </div>
  );
}
