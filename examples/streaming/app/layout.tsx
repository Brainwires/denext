import { Link } from "denext";
import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "denext · streaming & suspense",
  description:
    "Async server components with Suspense (buffered SSR), a loading.tsx route fallback, and true out-of-order streaming SSR via renderToReadableStream.",
  head: `<link rel="stylesheet" href="/styles.css">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <div class="app">
      <header class="topbar">
        <Link class="brand" href="/">denext · streaming</Link>
        <nav>
          <Link href="/dashboard">Dashboard</Link>
          <a href="/stream">Streamed SSR</a>
        </nav>
      </header>
      <main class="content">{children}</main>
      <footer class="foot">Suspense boundaries · out-of-order flush</footer>
    </div>
  );
}
