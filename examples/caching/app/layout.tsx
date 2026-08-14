import { Link } from "denext";
import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "denext · caching",
  description:
    "Data caching (unstable_cache), tag-based invalidation (revalidateTag), and ISR (export const revalidate) on denext.",
  head: `<link rel="stylesheet" href="/styles.css">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <div class="app">
      <header class="topbar">
        <Link class="brand" href="/">denext · caching</Link>
        <nav>
          <Link href="/data">Data cache</Link>
          <Link href="/isr">ISR</Link>
        </nav>
      </header>
      <main class="content">{children}</main>
      <footer class="foot">
        In-memory cache by default · swap in Deno KV or SQLite for
        multi-instance
      </footer>
    </div>
  );
}
